import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const execFileAsync = promisify(execFile);
import { seedDatabase } from "./seed.js";

// ── Logging helper (always stderr – stdout is the MCP JSON-RPC channel) ──
const log = (...args: unknown[]) => console.error("[server]", ...args);

// ── Workspace sandbox ──
const WORKSPACE_DIR = path.resolve(process.cwd(), "workspace");

// ── Database setup ──
const DB_PATH = path.join(WORKSPACE_DIR, "data.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
seedDatabase(db);
log("Database ready at", DB_PATH);

/** Resolve a user-supplied path and ensure it stays inside WORKSPACE_DIR. */
function safePath(userPath: string): string {
  const resolved = path.resolve(WORKSPACE_DIR, userPath);
  if (!resolved.startsWith(WORKSPACE_DIR + path.sep) && resolved !== WORKSPACE_DIR) {
    throw new Error(`Path escapes workspace: ${userPath}`);
  }
  return resolved;
}

// ── Create MCP Server ──
const server = new McpServer({
  name: "edu-mcp-server",
  version: "1.0.0",
});

// ── Tool: read_file ──
server.tool(
  "read_file",
  "Read the contents of a file inside the workspace directory.",
  { path: z.string().describe("Relative path inside workspace") },
  async ({ path: filePath }) => {
    log(`>>> read_file  path="${filePath}"`);
    const resolved = safePath(filePath);
    const content = await fs.readFile(resolved, "utf-8");
    log(`<<< read_file  ${content.length} chars`);
    return { content: [{ type: "text", text: content }] };
  },
);

// ── Tool: write_file ──
server.tool(
  "write_file",
  "Write content to a file inside the workspace directory. Creates parent directories if needed.",
  {
    path: z.string().describe("Relative path inside workspace"),
    content: z.string().describe("Content to write"),
  },
  async ({ path: filePath, content }) => {
    log(`>>> write_file  path="${filePath}" (${content.length} chars)`);
    const resolved = safePath(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
    log(`<<< write_file  OK`);
    return { content: [{ type: "text", text: `Wrote ${content.length} chars to ${filePath}` }] };
  },
);

// ── Tool: list_directory ──
server.tool(
  "list_directory",
  "List files and directories inside the workspace directory.",
  { path: z.string().optional().describe("Relative sub-path (default: root of workspace)") },
  async ({ path: dirPath }) => {
    const rel = dirPath ?? ".";
    log(`>>> list_directory  path="${rel}"`);
    const resolved = safePath(rel);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const listing = entries.map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`).join("\n");
    log(`<<< list_directory  ${entries.length} entries`);
    return { content: [{ type: "text", text: listing || "(empty directory)" }] };
  },
);

// ── Tool: fetch_url ──
server.tool(
  "fetch_url",
  "Fetch the content of a URL and return the response body (truncated to 5000 chars).",
  { url: z.string().url().describe("URL to fetch") },
  async ({ url }) => {
    log(`>>> fetch_url  url="${url}"`);
    const res = await fetch(url);
    if (!res.ok) {
      const msg = `HTTP ${res.status} ${res.statusText}`;
      log(`<<< fetch_url  ERROR: ${msg}`);
      return { content: [{ type: "text", text: msg }], isError: true };
    }
    let body = await res.text();
    const full = body.length;
    if (body.length > 5000) body = body.slice(0, 5000) + "\n... (truncated)";
    log(`<<< fetch_url  ${full} chars (${body.length} returned)`);
    return { content: [{ type: "text", text: body }] };
  },
);

// ── Tool: get_weather ──
server.tool(
  "get_weather",
  "Get the current weather for a city using wttr.in (no API key needed).",
  { city: z.string().describe("City name, e.g. 'London'") },
  async ({ city }) => {
    log(`>>> get_weather  city="${city}"`);
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=3`;
    const res = await fetch(url);
    const text = await res.text();
    log(`<<< get_weather  "${text.trim()}"`);
    return { content: [{ type: "text", text: text.trim() }] };
  },
);

// ── Tool: get_sports_scores ──
const SPORT_ENDPOINTS: Record<string, { category: string; league: string }> = {
  nfl: { category: "football", league: "nfl" },
  nba: { category: "basketball", league: "nba" },
  mlb: { category: "baseball", league: "mlb" },
  nhl: { category: "hockey", league: "nhl" },
  mls: { category: "soccer", league: "usa.1" },
  epl: { category: "soccer", league: "eng.1" },
  ncaam: { category: "basketball", league: "mens-college-basketball" },
  ncaaw: { category: "basketball", league: "womens-college-basketball" },
  ncaaf: { category: "football", league: "college-football" },
  wnba: { category: "basketball", league: "wnba" },
  champions: { category: "soccer", league: "uefa.champions" },
  fifa: { category: "soccer", league: "fifa.world" },
  nwsl: { category: "soccer", league: "usa.nwsl" },
  f1: { category: "racing", league: "f1" },
  pga: { category: "golf", league: "pga" },
  atp: { category: "tennis", league: "atp" },
  wta: { category: "tennis", league: "wta" },
};

server.tool(
  "get_sports_scores",
  `Get recent/live sports scores from ESPN. Supported leagues: ${Object.keys(SPORT_ENDPOINTS).join(", ")}.`,
  {
    league: z
      .string()
      .describe(`League abbreviation: ${Object.keys(SPORT_ENDPOINTS).join(", ")}`),
  },
  async ({ league }) => {
    const key = league.toLowerCase();
    log(`>>> get_sports_scores  league="${key}"`);

    const sport = SPORT_ENDPOINTS[key];
    if (!sport) {
      const msg = `Unknown league "${league}". Supported: ${Object.keys(SPORT_ENDPOINTS).join(", ")}`;
      log(`<<< get_sports_scores  ERROR: ${msg}`);
      return { content: [{ type: "text", text: msg }], isError: true };
    }

    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport.category}/${sport.league}/scoreboard`;
    const res = await fetch(url);
    if (!res.ok) {
      const msg = `ESPN API error: HTTP ${res.status}`;
      log(`<<< get_sports_scores  ERROR: ${msg}`);
      return { content: [{ type: "text", text: msg }], isError: true };
    }

    const data = (await res.json()) as {
      leagues?: Array<{ name?: string }>;
      events?: Array<{
        name?: string;
        date?: string;
        status?: { type?: { description?: string } };
        competitions?: Array<{
          competitors?: Array<{
            team?: { displayName?: string };
            score?: string;
            winner?: boolean;
          }>;
        }>;
      }>;
    };

    const events = data.events ?? [];
    if (events.length === 0) {
      const msg = `No games found for ${key.toUpperCase()} right now.`;
      log(`<<< get_sports_scores  ${msg}`);
      return { content: [{ type: "text", text: msg }] };
    }

    const lines = events.map((ev) => {
      const comp = ev.competitions?.[0];
      const teams = comp?.competitors ?? [];
      const status = ev.status?.type?.description ?? "Unknown";
      const matchup = teams
        .map((t) => `${t.team?.displayName ?? "?"} ${t.score ?? "-"}`)
        .join("  vs  ");
      return `${matchup}  (${status})`;
    });

    const header = data.leagues?.[0]?.name ?? key.toUpperCase();
    const text = `${header} Scores:\n${lines.join("\n")}`;
    log(`<<< get_sports_scores  ${events.length} games`);
    return { content: [{ type: "text", text }] };
  },
);

// ── Tool: run_code ──
server.tool(
  "run_code",
  "Run a Python script and return its output (stdout + stderr). Execution is time-limited to 10 seconds.",
  { code: z.string().describe("Python code to execute") },
  async ({ code }) => {
    log(`>>> run_code  (${code.length} chars)`);
    const tmpDir = path.join(WORKSPACE_DIR, ".tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${randomUUID()}.py`);
    try {
      await fs.writeFile(tmpFile, code, "utf-8");
      const { stdout, stderr } = await execFileAsync("python3", [tmpFile], {
        timeout: 10_000,
        cwd: WORKSPACE_DIR,
      });
      const output = (stdout + stderr).trim();
      log(`<<< run_code  OK (${output.length} chars)`);
      return { content: [{ type: "text", text: output || "(no output)" }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`<<< run_code  ERROR: ${msg}`);
      return { content: [{ type: "text", text: `Execution error: ${msg}` }], isError: true };
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  },
);

// ── Tool: web_search ──
server.tool(
  "web_search",
  "Search the web using Brave Search and return top results.",
  {
    query: z.string().describe("Search query"),
    count: z.number().optional().default(5).describe("Number of results (default 5)"),
  },
  async ({ query, count }) => {
    log(`>>> web_search  query="${query}" count=${count}`);
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) {
      const msg = "BRAVE_API_KEY is not set in environment variables.";
      log(`<<< web_search  ERROR: ${msg}`);
      return { content: [{ type: "text", text: msg }], isError: true };
    }

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetch(url, {
      headers: {
        "X-Subscription-Token": apiKey,
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      const msg = `Brave Search API error: HTTP ${res.status} ${res.statusText}`;
      log(`<<< web_search  ERROR: ${msg}`);
      return { content: [{ type: "text", text: msg }], isError: true };
    }

    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };

    const results = data.web?.results ?? [];
    if (results.length === 0) {
      const msg = `No results found for "${query}".`;
      log(`<<< web_search  ${msg}`);
      return { content: [{ type: "text", text: msg }] };
    }

    const formatted = results
      .map((r, i) => `${i + 1}. ${r.title ?? "(no title)"}\n   ${r.url ?? ""}\n   ${r.description ?? ""}`)
      .join("\n\n");

    log(`<<< web_search  ${results.length} results`);
    return { content: [{ type: "text", text: formatted }] };
  },
);

// ── Tool: query_database ──
server.tool(
  "query_database",
  "Run a SQL query against the workspace SQLite database. Supports SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, etc.",
  { sql: z.string().describe("SQL statement to execute") },
  async ({ sql }) => {
    log(`>>> query_database  sql="${sql}"`);
    try {
      const trimmed = sql.trimStart().toUpperCase();
      const isRead = trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("EXPLAIN");

      if (isRead) {
        const rows = db.prepare(sql).all();
        log(`<<< query_database  ${rows.length} rows`);
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      } else {
        const result = db.prepare(sql).run();
        log(`<<< query_database  changes=${result.changes} lastInsertRowid=${result.lastInsertRowid}`);
        return {
          content: [
            { type: "text", text: JSON.stringify({ changes: result.changes, lastInsertRowid: result.lastInsertRowid }) },
          ],
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`<<< query_database  ERROR: ${msg}`);
      return { content: [{ type: "text", text: `SQL Error: ${msg}` }], isError: true };
    }
  },
);

// ── Start ──
async function main() {
  log("Starting MCP server (stdio transport)…");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Server connected – waiting for requests.");
}

main().catch((err) => {
  log("Fatal error:", err);
  process.exit(1);
});
