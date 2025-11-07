#!/usr/bin/env deno run --allow-env --allow-net

/**
 * GitHub GraphQL API を使って組織の全チームとメンバーを一度に取得し、
 * 指定ユーザーが含まれるチームに対して、そのユーザーを maintainer に設定するスクリプト
 *
 * Usage:
 *   deno run --allow-env --allow-net make_team_maintainer.ts [--dry-run] <org> <username>
 *
 * Options:
 *   --dry-run  実際の設定は行わず、対象となるチームの一覧のみを表示
 */

const GITHUB_API_VERSION = "2022-11-28";

interface TeamMember {
  login: string;
}

interface Team {
  name: string;
  slug: string;
  id: string;
  members: TeamMember[];
}

interface GraphQLTeamNode {
  name: string;
  slug: string;
  id: string;
  members: {
    edges: Array<{
      node: {
        login: string;
      };
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

interface GraphQLResponse {
  data: {
    organization: {
      teams: {
        edges: Array<{
          node: GraphQLTeamNode;
        }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    };
  };
}

/**
 * GraphQL クエリを実行
 */
async function executeGraphQL(
  query: string,
  variables: Record<string, unknown>,
  token: string
): Promise<GraphQLResponse> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Error: GitHub GraphQL API returned ${response.status}`);
    console.error(errorText);
    Deno.exit(1);
  }

  const data = await response.json();

  if (data.errors) {
    console.error("GraphQL Errors:", JSON.stringify(data.errors, null, 2));
    Deno.exit(1);
  }

  return data;
}

/**
 * 特定のチームの残りのメンバーを取得（100人以上の場合）
 */
async function getAdditionalMembers(
  org: string,
  teamSlug: string,
  cursor: string,
  token: string
): Promise<TeamMember[]> {
  const members: TeamMember[] = [];
  let currentCursor: string | null = cursor;
  let hasNextPage = true;

  const query = `
    query($org: String!, $teamSlug: String!, $cursor: String!) {
      organization(login: $org) {
        team(slug: $teamSlug) {
          members(first: 100, after: $cursor) {
            edges {
              node {
                login
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const variables = {
      org,
      teamSlug,
      cursor: currentCursor,
    };

    const result = await executeGraphQL(query, variables, token);
    const teamMembers = result.data.organization.team?.members;

    if (!teamMembers) {
      break;
    }

    members.push(...teamMembers.edges.map(edge => ({ login: edge.node.login })));

    hasNextPage = teamMembers.pageInfo.hasNextPage;
    currentCursor = teamMembers.pageInfo.endCursor;
  }

  return members;
}

/**
 * 組織の全チームとメンバーを取得（ページング対応）
 */
async function getAllTeamsWithMembers(
  org: string,
  token: string
): Promise<Team[]> {
  const teams: Team[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  // チームとメンバーを一度に取得するクエリ
  const query = `
    query($org: String!, $cursor: String) {
      organization(login: $org) {
        teams(first: 100, after: $cursor) {
          edges {
            node {
              name
              slug
              id
              members(first: 100) {
                edges {
                  node {
                    login
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const variables = {
      org,
      cursor,
    };

    const result = await executeGraphQL(query, variables, token);
    const teamsData = result.data.organization.teams;

    // 各チームのデータを処理
    for (const edge of teamsData.edges) {
      const node = edge.node;
      const team: Team = {
        name: node.name,
        slug: node.slug,
        id: node.id,
        members: node.members.edges.map(memberEdge => ({
          login: memberEdge.node.login,
        })),
      };

      // メンバーが100人以上いる場合は追加で取得
      if (node.members.pageInfo.hasNextPage && node.members.pageInfo.endCursor) {
        console.log(`  Team "${node.name}" has more than 100 members, fetching additional members...`);
        const additionalMembers = await getAdditionalMembers(
          org,
          node.slug,
          node.members.pageInfo.endCursor,
          token
        );
        team.members.push(...additionalMembers);
      }

      teams.push(team);
    }

    hasNextPage = teamsData.pageInfo.hasNextPage;
    cursor = teamsData.pageInfo.endCursor;

    console.log(`Fetched ${teams.length} teams so far...`);
  }

  return teams;
}

/**
 * 指定ユーザーが含まれるチームのみをフィルタリング
 */
function filterTeamsByUser(
  teams: Team[],
  username: string
): Team[] {
  const teamsWithUser: Team[] = [];

  console.log(`\nFiltering teams for user ${username}...\n`);

  for (const team of teams) {
    const hasMember = team.members.some(member => member.login === username);

    if (hasMember) {
      teamsWithUser.push(team);
      console.log(`✓ Found in: ${team.name} (${team.slug})`);
    }
  }

  return teamsWithUser;
}

/**
 * 指定ユーザーをチームのmaintainerに設定
 */
async function setMaintainer(
  org: string,
  username: string,
  teams: Team[],
  token: string
): Promise<void> {
  console.log(`\nSetting ${username} as maintainer for ${teams.length} teams in ${org}...\n`);

  for (const team of teams) {
    const teamSlug = team.slug;
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
    // 全チームとメンバーを一度に取得
    console.log(`Fetching all teams and members in ${org} using GraphQL API...\n`);
    const allTeams = await getAllTeamsWithMembers(org, token);
    console.log(`\nFound ${allTeams.length} teams in total`);

    // ユーザーが含まれるチームをフィルタリング
    const teamsWithUser = filterTeamsByUser(allTeams, username);

    console.log(`\n--- Results ---`);
    console.log(`User ${username} is a member of ${teamsWithUser.length} team(s):\n`);

    if (dryRun) {
      // Dry runモード: チームのslugのみ出力
      console.log("--- Team Slugs (dry-run mode) ---");
      teamsWithUser.forEach((team) => {
        console.log(team.slug);
      });
    } else {
      // 各チームに対してmaintainerを設定
      await setMaintainer(org, username, teamsWithUser, token);
    }
  } catch (error) {
    console.error("Error:", error);
    Deno.exit(1);
  }
}

await main();
