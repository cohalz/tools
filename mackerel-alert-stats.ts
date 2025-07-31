#!/usr/bin/env -S deno run --allow-env --allow-net

/**
 * Mackerel の期間中のアラート履歴を集計しScrapboxのテーブル形式で出力するスクリプト.
 * 実行例:
 *   MACKEREL_APIKEY=*** ./mackerel-alert-stats.ts --from $(date -d "2 week ago" +%Y-%m-%dT%H:%M:%S+0900) --to $(date +%Y-%m-%dT%H:%M:%S+0900)
 * @module
 */

import { parseArgs } from 'jsr:@std/cli@^0.224.0/parse-args';
import { delay } from 'jsr:@std/async@^0.224.0';
 import { MackerelClient } from 'jsr:@susisu/mackerel-client@^0.1.1';
import type { Alert } from 'jsr:@susisu/mackerel-client@^0.1.1/alerts';

const apiKey = Deno.env.get('MACKEREL_APIKEY');
if (apiKey === undefined) {
  throw new Error('MACKEREL_APIKEY is not set');
}
const cli = new MackerelClient(apiKey);

const flags = parseArgs(Deno.args, {
  string: ['from', 'to'],
});
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

const [alertsByMonitor, prevAlertsByMonitor] = await getAlertsByMonitor(prev, from, to)

console.log(`table:${from.toLocaleString()} ~ ${to.toLocaleString()}の集計 (前期間: ${prev.toLocaleString()} ~ ${from.toLocaleString()})`)
console.log("\t監視名\t回数\tMTTR(分)\t稼働率(%)")

for (const [monitorId, alerts] of Object.entries(alertsByMonitor)) {


  // チェック監視はAPIから名前を取れないので除外している
  if (alerts![0].type === "check") continue
  // 削除済みの監視はAPIから名前を取れないので除外している
  if (alerts![0].monitorId === null) continue
  const monitorName = (await cli.monitors.get(monitorId)).name
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
    alerts = alerts.concat(res.alerts);
    if (currentOpenedAt >= from) {
      break;
    }
    cursor = res.cursor;
    currentOpenedAt = res.alerts[res.alerts.length-1].openedAt
    await delay(1000);
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
