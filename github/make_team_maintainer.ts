#!/usr/bin/env deno run --allow-env --allow-net

/**
 * GitHub API を使って組織のチーム情報を取得し、
 * 指定ユーザーを全チームのmaintainerに設定するスクリプト
 *
 * Usage:
 *   deno run --allow-env --allow-net make_team_maintainer.ts [--dry-run] <org> <username>
 */

const GITHUB_API_VERSION = "2022-11-28";

interface Team {
  name: string;
  slug: string;
  [key: string]: unknown;
}

async function getTeams(org: string, user: string, token: string): Promise<Team[]> {
  const url = new URL(`https://api.github.com/orgs/${org}/teams`);
  url.searchParams.set("query", user);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "Accept": "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Error: GitHub API returned ${response.status}`);
    console.error(errorText);
    Deno.exit(1);
  }

  const data = await response.json();
  return data;
}

async function setMaintainer(
  org: string,
  username: string,
  teams: Team[],
  token: string
): Promise<void> {
  console.log(`\nSetting ${username} as maintainer for ${teams.length} teams in ${org}...\n`);

  for (const team of teams) {
    const teamSlug = team.name;
    const url = `https://api.github.com/orgs/${org}/teams/${teamSlug}/memberships/${username}`;

    try {
      console.log(`Processing team: ${teamSlug}`);

      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "maintainer" }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`  ✗ Error: GitHub API returned ${response.status}`);
        console.error(`  ${errorText}`);
        continue;
      }

      const data = await response.json();
      console.log(`  ✓ Success: ${username} is now a ${data.role} of ${teamSlug}`);
    } catch (error) {
      console.error(`  ✗ Error processing team ${teamSlug}:`, error);
    }
  }

  console.log("\nDone!");
}

async function main(): Promise<void> {
  // コマンドライン引数を解析
  let dryRun = false;
  let org: string | undefined;
  let username: string | undefined;

  const args = [...Deno.args];

  if (args[0] === "--dry-run") {
    dryRun = true;
    org = args[1];
    username = args[2];
  } else {
    org = args[0];
    username = args[1];
  }

  if (!org || !username) {
    console.error("Error: org and username parameters are required");
    console.error("Usage: deno run --allow-env --allow-net make_team_maintainer.ts [--dry-run] <org> <username>");
    Deno.exit(1);
  }

  // 環境変数からトークンを取得
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) {
    console.error("Error: GITHUB_TOKEN environment variable is not set");
    Deno.exit(1);
  }

  try {
    // チーム一覧を取得
    console.log(`Fetching teams for ${username} in ${org}...`);
    const teams = await getTeams(org, username, token);
    console.log(`Found ${teams.length} teams`);

    if (dryRun) {
      // Dry runモード: チーム名一覧のみ出力
      console.log("\n--- Team Names (dry-run mode) ---");
      teams.forEach((team) => {
        console.log(team.name);
      });
    } else {
      // 通常モード: JSONを出力してmaintainerを設定
      console.log(JSON.stringify(teams, null, 2));
      // 各チームに対してmaintainerを設定
      await setMaintainer(org, username, teams, token);
    }
  } catch (error) {
    console.error("Error:", error);
    Deno.exit(1);
  }
}

await main();
