#!/usr/bin/env -S deno run --allow-env --allow-net

/**
 * Mackerel の期間中のアラート履歴を集計しScrapboxのテーブル形式で出力するスクリプト.
 * 実行例:
 *   MACKEREL_APIKEY=*** ./mackerel-alert-stats.ts --from $(date -d "2 week ago" +%Y-%m-%dT%H:%M:%S+0900) --to $(date +%Y-%m-%dT%H:%M:%S+0900) [--notificationGroupId <id> | --channelId <id>]
 * --notificationGroupId: その通知グループに届くアラートのみに絞る (子通知グループとして転送してくる親の通知グループの分も含む)
 * --channelId: その通知チャンネルに届くアラートのみに絞る (デフォルト通知グループ経由の分は含まない)
 * @module
 */

import { parseArgs } from 'jsr:@std/cli@^0.224.0/parse-args';
import { delay } from 'jsr:@std/async@^0.224.0';
import { MackerelClient } from 'jsr:@susisu/mackerel-client@^0.1.1';
import type { Alert } from 'jsr:@susisu/mackerel-client@^0.1.1/alerts';
import type { NotificationGroup } from 'jsr:@susisu/mackerel-client@^0.1.1/channels';


const apiKey = Deno.env.get('MACKEREL_APIKEY');
if (apiKey === undefined) {
  throw new Error('MACKEREL_APIKEY is not set');
}
const cli = new MackerelClient(apiKey);

const flags = parseArgs(Deno.args, {
  string: ['from', 'to', 'notificationGroupId', 'channelId'],
});
if (flags.notificationGroupId && flags.channelId) {
  throw new Error('--notificationGroupId and --channelId cannot be specified together');
}
const from = new Date(flags.from ?? '');
const to = new Date(flags.to ?? '');
if (Number.isNaN(from.getTime())) {
  throw new Error('--from is not set or invalid');
}
if (Number.isNaN(to.getTime())) {
  throw new Error('--to is not set or invalid');
}
if (!(from.getTime() < to.getTime())) {
  throw new Error(`invavlid time range [${from.toISOString()}, ${to.toISOString()})`);
}

type AlertStats = {
  count: number;
  mttr: number;
  downTime: number;
};

const prev = new Date(2*from.valueOf()-to.valueOf())

const windowMin = Math.round((to.valueOf() - from.valueOf())/60000)

type NotificationScope = {
  monitorIds: Set<string>;
  serviceNames: Set<string>;
};

// 通知グループ・通知チャンネルでフィルタリングするための情報を取得
let notificationScope: NotificationScope | null = null;
if (flags.notificationGroupId || flags.channelId) {
  notificationScope = await getNotificationScope({
    notificationGroupId: flags.notificationGroupId,
    channelId: flags.channelId,
  });
}

const [alertsByMonitor, prevAlertsByMonitor] = await getAlertsByMonitor(prev, from, to)

console.log(`table:${from.toLocaleString()} ~ ${to.toLocaleString()}の集計 (前期間: ${prev.toLocaleString()} ~ ${from.toLocaleString()})`)
console.log("\t監視名\t回数\tMTTR(分)\t稼働率(%)")

for (const [monitorId, alerts] of Object.entries(alertsByMonitor)) {


  // チェック監視はAPIから名前を取れないので除外している
  if (alerts![0].type === "check") continue
  // 削除済みの監視はAPIから名前を取れないので除外している
  if (alerts![0].monitorId === null) continue

  const monitor = await cli.monitors.get(monitorId);

  if (notificationScope && !isMonitorInScope(monitorId, monitor, notificationScope)) continue;

  const monitorName = monitor.name;
  const [currentStats, prevStats] = [getAlertStats(alerts as Alert[]), getAlertStats(prevAlertsByMonitor[monitorId] ?? [])]
  const [availability, prevAvailability] = [100 * (windowMin - currentStats.downTime)/windowMin, 100 * (windowMin - prevStats.downTime)/windowMin]

  console.log(`\t${monitorName}\t${getNumberWithDelta(currentStats.count, prevStats.count)}\t${getNumberWithDelta(currentStats.mttr, prevStats.mttr)}\t${getNumberWithDelta(availability, prevAvailability, 2)}`);
}

function getMTTR(alerts: Alert[]): number {
  if (alerts.length === 0) return 0
  return Number((alerts.map(alert => ((alert.closedAt || new Date()).valueOf() - alert.openedAt.valueOf()) / 60000).reduce(function (acc, cur) {
        return acc  + cur
    }, 0) / alerts.length).toFixed(0));
}

async function getAlerts(from: Date) {
  let alerts: Alert[] = [];
  let cursor: string | undefined = undefined;
  let currentOpenedAt = new Date();
  while (true) {
    const res = await cli.alerts.list({ includeClosed: true, cursor })
    cursor = res.cursor;
    currentOpenedAt = res.alerts[res.alerts.length-1].openedAt
    alerts = alerts.concat(res.alerts);
    if (currentOpenedAt < from) {
      break;
    }
    await delay(100);
  }
  return alerts;
}

async function getAlertsByMonitor(prev: Date, from: Date, to: Date): Promise<Partial<Record<string, Alert[]>>[]> {
  const alerts = await getAlerts(prev)

  return [
    Object.groupBy(alerts.filter(alert => alert.openedAt >= from && alert.openedAt < to), alert => alert.monitorId),
    Object.groupBy(alerts.filter(alert => alert.openedAt >= prev && alert.openedAt < from), alert => alert.monitorId)
  ]
}

function getNumberWithDelta(a: number, b: number, fractionDigits: number = 0): string {
  return  `${a.toFixed(fractionDigits)}(${a >= b ? "+" : ""}${(a - b).toFixed(fractionDigits)})`
}

function getAlertStats(alerts: Alert[]): AlertStats {
  const [count, mttr] = [alerts.length, getMTTR(alerts)]
  return {
    count,
    mttr,
    downTime: count * mttr
  }
}

type Monitor = Awaited<ReturnType<typeof cli.monitors.get>>;

function isMonitorInScope(monitorId: string, monitor: Monitor, scope: NotificationScope): boolean {
  if (scope.monitorIds.has(monitorId)) return true;

  if ('serviceName' in monitor && monitor.serviceName && scope.serviceNames.has(monitor.serviceName)) {
    return true;
  }
  if ('scopes' in monitor) {
    const monitorScopes = Array.isArray(monitor.scopes) ? monitor.scopes : monitor.scopes.include;
    if (Array.isArray(monitorScopes)) {
      return monitorScopes.some(s => scope.serviceNames.has(s.split(':')[0]));
    }
  }
  return false;
}

// 子通知グループは親の通知グループに来た通知の転送先なので、起点の通知グループに加えて祖先の通知グループのスコープも対象にする
async function getNotificationScope(
  { notificationGroupId, channelId }: { notificationGroupId?: string; channelId?: string },
): Promise<NotificationScope> {
  const notificationGroups = await cli.channels.listNotificationGroups();

  let startGroups: NotificationGroup[];
  if (notificationGroupId) {
    startGroups = notificationGroups.filter(ng => ng.id === notificationGroupId);
    if (startGroups.length === 0) {
      throw new Error(`Notification group with id ${notificationGroupId} not found`);
    }
  } else {
    startGroups = notificationGroups.filter(ng => ng.childChannelIds.includes(channelId!));
    if (startGroups.length === 0) {
      throw new Error(`No notification group notifies channel ${channelId}`);
    }
  }

  const parentsById = new Map<string, NotificationGroup[]>();
  for (const group of notificationGroups) {
    for (const childId of group.childNotificationGroupIds) {
      parentsById.set(childId, [...(parentsById.get(childId) ?? []), group]);
    }
  }

  const visited = new Map<string, NotificationGroup>();
  const queue = [...startGroups];
  while (queue.length > 0) {
    const group = queue.shift()!;
    if (visited.has(group.id)) continue;
    visited.set(group.id, group);
    queue.push(...(parentsById.get(group.id) ?? []));
  }

  const groups = [...visited.values()];
  console.error(`対象の通知グループ: ${groups.map(g => g.name).join(', ')}`);
  const criticalGroups = groups.filter(g => g.notificationLevel === 'critical');
  if (criticalGroups.length > 0) {
    console.error(`注意: Critical のみ通知する通知グループ (${criticalGroups.map(g => g.name).join(', ')}) を経由するアラートは、Warning も集計に含まれます`);
  }

  return {
    monitorIds: new Set(groups.flatMap(g => g.scopes.monitors.map(m => m.id))),
    serviceNames: new Set(groups.flatMap(g => g.scopes.services.map(s => s.name))),
  };
}
