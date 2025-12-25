#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Mackerel 監視ルール一覧取得CLI
 *
 * 使い方:
 *   MACKEREL_APIKEY=your-api-key deno run --allow-net --allow-env list_monitors.ts --service myservice [--format json] [--excludeAllServices]
 *   複数のサービスを指定する場合はカンマ区切りで指定:
 *   MACKEREL_APIKEY=your-api-key deno run --allow-net --allow-env list_monitors.ts --service service1,service2,service3
 *   通知グループで絞り込む場合:
 *   MACKEREL_APIKEY=your-api-key deno run --allow-net --allow-env list_monitors.ts --notificationGroupId <id> [--format json]
 */

import { MackerelClient } from 'jsr:@susisu/mackerel-client@^0.1.1';
import type { NotificationGroup } from 'jsr:@susisu/mackerel-client@^0.1.1/channels';
import type { Monitor } from 'jsr:@susisu/mackerel-client@^0.1.1/monitors';

async function getMonitors(cli: MackerelClient): Promise<Monitor[]> {
  return await cli.monitors.list();
}

/**
 * スコープのinclude部分を配列に変換する
 */
function scopesToIncludeArray(scopes: string[] | { include: string[], exclude?: string[] } | undefined): string[] {
  if (!scopes) {
    return [];
  }
  if (Array.isArray(scopes)) {
    return scopes;
  }
  if (typeof scopes === 'object' && 'include' in scopes && Array.isArray(scopes.include)) {
    return scopes.include;
  }
  return [];
}

/**
 * スコープのexclude部分を配列に変換する
 */
function scopesToExcludeArray(scopes: string[] | { include: string[], exclude?: string[] } | undefined): string[] {
  if (!scopes) {
    return [];
  }
  if (Array.isArray(scopes)) {
    return [];
  }
  if (typeof scopes === 'object' && 'exclude' in scopes && Array.isArray(scopes.exclude)) {
    return scopes.exclude;
  }
  return [];
}

function filterByService(monitors: Monitor[], service: string, excludeAllServices: boolean = false): Monitor[] {
  // カンマ区切りでサービス名を分割
  const services = service.split(",").map(s => s.trim());

  return monitors.filter((monitor) => {
    // type が external, expression, anomalyDetection, service の場合は名前にserviceが含まれているかチェック
    if (
      monitor.type === "external" ||
      monitor.type === "expression" ||
      monitor.type === "anomalyDetection" ||
      monitor.type === "service"
    ) {
      return services.some(svc => monitor.name.includes(svc));
    }

    // scopesが存在しない場合の処理
    if (!('scopes' in monitor)) {
      return !excludeAllServices;
    }

    // scopesをリストに変換
    const scopesList = scopesToIncludeArray(monitor.scopes);

    // excludeAllServicesが有効な場合、scopesが未定義または空配列の場合は除外
    if (excludeAllServices && scopesList.length === 0) {
      return false;
    }

    // scopesが未定義または空配列の場合は含める
    if (scopesList.length === 0) {
      return true;
    }

    // scopesの各要素について、コロンの前の部分がserviceと一致するかチェック
    return scopesList.some((scope) => {
      const servicePart = scope.split(":")[0];
      return services.includes(servicePart);
    });
  });
}

async function getNotificationGroup(cli: MackerelClient, notificationGroupId: string): Promise<NotificationGroup> {
  const notificationGroups = await cli.channels.listNotificationGroups();
  const group = notificationGroups.find(ng => ng.id === notificationGroupId);
  if (!group) {
    throw new Error(`Notification group with id ${notificationGroupId} not found`);
  }
  return group;
}

function filterByNotificationGroup(monitors: Monitor[], notificationGroup: NotificationGroup): Monitor[] {
  const allowedMonitorIds = new Set(notificationGroup.scopes.monitors.map(m => m.id));
  const allowedServiceNames = new Set(notificationGroup.scopes.services.map(s => s.name));

  return monitors.filter((monitor) => {

    // 監視ルールIDが通知グループに含まれているかチェック
    let isAllowed = allowedMonitorIds.has(monitor.id);

    // 監視ルールのスコープがサービスに一致するかチェック
    if (!isAllowed && 'serviceName' in monitor && monitor.serviceName) {
      if (allowedServiceNames.has(monitor.serviceName as string)) {
        isAllowed = true;
      }
    }
    if (!isAllowed && 'scopes' in monitor) {
      if(Array.isArray(monitor.scopes)) {
        for (const scope of monitor.scopes) {
          const serviceName = scope.split(':')[0];
          if (allowedServiceNames.has(serviceName)) {
            isAllowed = true;
            break;
          }
        }
      } else if (Array.isArray(monitor.scopes.include)) {
        for (const scope of monitor.scopes.include) {
          const serviceName = scope.split(':')[0];
          if (allowedServiceNames.has(serviceName)) {
            isAllowed = true;
            break;
          }
        }
      }
    }
    return isAllowed;
  });
}

function displayMonitors(monitors: Monitor[]): void {
  console.log(`\n監視ルール一覧 (${monitors.length}件)\n`);
  console.log("─".repeat(80));

  for (const monitor of monitors) {
    const muteStatus = monitor.isMuted ? "[ミュート中]" : "";
    console.log(`ID: ${monitor.id}`);
    console.log(`名前: ${monitor.name} ${muteStatus}`);
    console.log(`タイプ: ${monitor.type}`);

    // スコープ一覧を構築
    let scopesList: string[] = [];
    if ('scopes' in monitor) {
      scopesList = scopesToIncludeArray(monitor.scopes);
    }

    // 除外スコープ一覧を構築（scopes.excludeがあればそれを使う）
    let excludeScopesList: string[] = [];
    if ('scopes' in monitor) {
      excludeScopesList = scopesToExcludeArray(monitor.scopes);
    }

    // スコープの表示
    if (scopesList.length > 0) {
      console.log(`スコープ: ${scopesList.join(", ")}`);
    }
    if (excludeScopesList.length > 0) {
      console.log(`除外スコープ: ${excludeScopesList.join(", ")}`);
    }

    console.log("─".repeat(80));
  }
}

async function main() {
  const apiKey = Deno.env.get("MACKEREL_APIKEY");

  if (!apiKey) {
    console.error("Error: MACKEREL_APIKEY environment variable is not set");
    console.error("\n使い方:");
    console.error(
      "  MACKEREL_APIKEY=your-api-key deno run --allow-net --allow-env list_monitors.ts --service myservice [--format json] [--excludeAllServices]",
    );
    console.error(
      "  複数サービス指定: --service service1,service2,service3",
    );
    console.error(
      "  通知グループ指定: --notificationGroupId <id> [--format json]",
    );
    Deno.exit(1);
  }

  // コマンドライン引数の解析
  let serviceFilter: string | null = null;
  let notificationGroupId: string | null = null;
  let format: string = "text";
  let excludeAllServices: boolean = false;
  const args = Deno.args;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--service" && i + 1 < args.length) {
      serviceFilter = args[i + 1];
      i++;
    } else if (args[i] === "--notificationGroupId" && i + 1 < args.length) {
      notificationGroupId = args[i + 1];
      i++;
    } else if (args[i] === "--format" && i + 1 < args.length) {
      format = args[i + 1];
      i++;
    } else if (args[i] === "--excludeAllServices") {
      excludeAllServices = true;
    }
  }

  if (!serviceFilter && !notificationGroupId) {
    console.error("Error: --service または --notificationGroupId のいずれかは必須です");
    console.error("\n使い方:");
    console.error(
      "  MACKEREL_APIKEY=your-api-key deno run --allow-net --allow-env list_monitors.ts --service myservice [--format json] [--excludeAllServices]",
    );
    console.error(
      "  複数サービス指定: --service service1,service2,service3",
    );
    console.error(
      "  通知グループ指定: --notificationGroupId <id> [--format json]",
    );
    Deno.exit(1);
  }

  if (serviceFilter && notificationGroupId) {
    console.error("Error: --service と --notificationGroupId は同時に指定できません");
    Deno.exit(1);
  }

  try {
    const cli = new MackerelClient(apiKey);

    if (format !== "json") {
      console.log("Mackerel監視ルールを取得中...");
    }
    let monitors = await getMonitors(cli);

    if (serviceFilter) {
      if (format !== "json") {
        console.log(`サービス "${serviceFilter}" でフィルタリング中...`);
      }
      monitors = filterByService(monitors, serviceFilter, excludeAllServices);
    } else if (notificationGroupId) {
      if (format !== "json") {
        console.log(`通知グループ "${notificationGroupId}" でフィルタリング中...`);
      }
      const notificationGroup = await getNotificationGroup(cli, notificationGroupId);
      monitors = filterByNotificationGroup(monitors, notificationGroup);
    }

    if (format === "json") {
      console.log(JSON.stringify(monitors, null, 2));
    } else {
      displayMonitors(monitors);
    }
  } catch (error) {
    console.error("エラーが発生しました:", error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
