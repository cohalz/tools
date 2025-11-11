#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Mackerel 監視ルール一覧取得CLI
 *
 * 使い方:
 *   MACKEREL_APIKEY=your-api-key deno run --allow-net --allow-env list_monitors.ts --service myservice [--format json] [--excludeAllServices]
 */

interface Monitor {
  id: string;
  type: string;
  name: string;
  isMute?: boolean;
  scopes?: string[];
  excludeScopes?: string[];
  [key: string]: unknown;
}

interface MonitorsResponse {
  monitors: Monitor[];
}

const MACKEREL_API_BASE = "https://api.mackerelio.com";

async function getMonitors(apiKey: string): Promise<Monitor[]> {
  const response = await fetch(`${MACKEREL_API_BASE}/api/v0/monitors`, {
    headers: {
      "X-Api-Key": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch monitors: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json() as MonitorsResponse;
  return data.monitors;
}

function filterByService(monitors: Monitor[], service: string, excludeAllServices: boolean = false): Monitor[] {
  return monitors.filter((monitor) => {
    // type が external, expression, anomalyDetection, service の場合は名前にserviceが含まれているかチェック
    if (
      monitor.type === "external" ||
      monitor.type === "expression" ||
      monitor.type === "anomalyDetection" ||
      monitor.type === "service"
    ) {
      return monitor.name.includes(service);
    }

    // excludeScopesにサービスが含まれている場合は除外
    if (monitor.excludeScopes && monitor.excludeScopes.length > 0) {
      const isExcluded = monitor.excludeScopes.some((scope) => {
        const servicePart = scope.split(":")[0];
        return servicePart === service;
      });
      if (isExcluded) {
        return false;
      }
    }

    // excludeAllServicesが有効な場合、scopesが未定義または空配列の場合は除外
    if (excludeAllServices && (!monitor.scopes || monitor.scopes.length === 0)) {
      return false;
    }

    // scopesが未定義または空配列の場合は含める
    if (!monitor.scopes || monitor.scopes.length === 0) {
      return true;
    }

    // scopesの各要素について、コロンの前の部分がserviceと一致するかチェック
    return monitor.scopes.some((scope) => {
      const servicePart = scope.split(":")[0];
      return servicePart === service;
    });
  });
}

function displayMonitors(monitors: Monitor[]): void {
  console.log(`\n監視ルール一覧 (${monitors.length}件)\n`);
  console.log("─".repeat(80));

  for (const monitor of monitors) {
    const muteStatus = monitor.isMute ? "[ミュート中]" : "";
    console.log(`ID: ${monitor.id}`);
    console.log(`名前: ${monitor.name} ${muteStatus}`);
    console.log(`タイプ: ${monitor.type}`);
    if (monitor.scopes && monitor.scopes.length > 0) {
      console.log(`スコープ: ${monitor.scopes.join(", ")}`);
    }
    if (monitor.excludeScopes && monitor.excludeScopes.length > 0) {
      console.log(`除外スコープ: ${monitor.excludeScopes.join(", ")}`);
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
    Deno.exit(1);
  }

  // コマンドライン引数の解析
  let serviceFilter: string | null = null;
  let format: string = "text";
  let excludeAllServices: boolean = false;
  const args = Deno.args;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--service" && i + 1 < args.length) {
      serviceFilter = args[i + 1];
      i++;
    } else if (args[i] === "--format" && i + 1 < args.length) {
      format = args[i + 1];
      i++;
    } else if (args[i] === "--excludeAllServices") {
      excludeAllServices = true;
    }
  }

  if (!serviceFilter) {
    console.error("Error: --service オプションは必須です");
    console.error("\n使い方:");
    console.error(
      "  MACKEREL_APIKEY=your-api-key deno run --allow-net --allow-env list_monitors.ts --service myservice [--format json] [--excludeAllServices]",
    );
    Deno.exit(1);
  }

  try {
    console.log("Mackerel監視ルールを取得中...");
    let monitors = await getMonitors(apiKey);

    console.log(`サービス "${serviceFilter}" でフィルタリング中...`);
    monitors = filterByService(monitors, serviceFilter, excludeAllServices);

    if (format === "json") {
      console.log(JSON.stringify(monitors, null, 2));
    } else {
      displayMonitors(monitors);
    }
  } catch (error) {
    console.error("エラーが発生しました:", error.message);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
