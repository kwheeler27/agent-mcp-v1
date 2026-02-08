# Architecture — agent-mcp-v1

> Educational MCP agent demonstrating how the Model Context Protocol gives
> Claude access to external tools.

---

## High-Level Overview

The system is a two-process architecture connected by the **Model Context
Protocol (MCP)** over stdio. A **Client** process orchestrates conversation
with the Anthropic API while a **Server** child-process hosts the actual tool
implementations.

```
 ┌─────────────────────────────────────────────────────────────────┐
 │                        User Terminal                            │
 │                         (REPL prompt)                           │
 └──────────────────────────┬──────────────────────────────────────┘
                            │ user query
                            ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │                       MCP CLIENT  (client.ts)                    │
 │                                                                  │
 │  ┌──────────────┐    ┌────────────────┐    ┌──────────────────┐ │
 │  │ Tool         │    │ Agent Loop     │    │ Anthropic SDK    │ │
 │  │ Discovery    │───▶│ (multi-turn)   │◀──▶│ (Claude API)     │ │
 │  └──────────────┘    └───────┬────────┘    └──────────────────┘ │
 │                              │ callTool()                        │
 └──────────────────────────────┼───────────────────────────────────┘
                    stdin/stdout│(JSON-RPC 2.0)
                                │
 ┌──────────────────────────────┼───────────────────────────────────┐
 │                       MCP SERVER  (server.ts)                    │
 │                              │                                   │
 │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
 │  │read_file │ │write_file│ │run_code  │ │web_search│  ...       │
 │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘           │
 │       │            │            │             │                  │
 │       ▼            ▼            ▼             ▼                  │
 │  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌───────────┐            │
 │  │workspace│ │workspace│ │ python3  │ │ External  │            │
 │  │  (read) │ │ (write) │ │ process  │ │   APIs    │            │
 │  └─────────┘ └─────────┘ └──────────┘ └───────────┘            │
 └──────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
agent-mcp-v1/
├── src/
│   ├── client.ts        # MCP client + Anthropic agent loop + REPL
│   ├── server.ts        # MCP server + all tool definitions
│   └── seed.ts          # SQLite seed data (books & users tables)
├── workspace/
│   ├── example.txt      # Sample file for read/write demos
│   └── data.db          # SQLite database (created at runtime)
├── build/               # Compiled JS (tsc output)
├── package.json
├── tsconfig.json
├── .env                 # ANTHROPIC_API_KEY, BRAVE_API_KEY
└── .env.example         # Template for required env vars
```

---

## Process Lifecycle

```
  npm run dev
      │
      ▼
  ┌──────────────────────────────────┐
  │  Client process starts           │
  │  (DEV=1 npx tsx src/client.ts)   │
  └──────────┬───────────────────────┘
             │
             │ 1. Spawn child process
             ▼
  ┌──────────────────────────────────┐
  │  Server process starts           │
  │  (npx tsx src/server.ts)         │
  │                                  │
  │  a. Open workspace/data.db       │
  │  b. Enable WAL journal mode      │
  │  c. Seed tables if empty         │
  │  d. Register 9 tools             │
  │  e. Bind StdioServerTransport    │
  └──────────┬───────────────────────┘
             │
             │ 2. MCP handshake over stdio
             ▼
  ┌──────────────────────────────────┐
  │  Client: listTools()             │
  │  ─ discovers all 9 tools         │
  │  ─ converts schemas to Anthropic │
  │    tool format                   │
  │  ─ builds dynamic system prompt  │
  └──────────┬───────────────────────┘
             │
             │ 3. Start REPL
             ▼
  ┌──────────────────────────────────┐
  │  Interactive prompt:  You: _     │
  └──────────────────────────────────┘
```

**Dev vs. Production:**

| Mode | Command | Server spawned as |
|------|---------|-------------------|
| Dev  | `npm run dev` | `npx tsx src/server.ts` |
| Prod | `npm run build && npm start` | `node build/server.js` |

---

## Agent Loop (Multi-Turn Tool Calling)

When the user submits a query, the client enters an iterative loop that allows
Claude to call tools multiple times before producing a final answer.

```
  User query
      │
      ▼
 ┌──────────────────────────────────────────────────┐
 │        Claude API  (messages.create)              │
 │                                                   │
 │  system: dynamic prompt with tool descriptions    │
 │  tools:  9 tool definitions (JSON Schema)         │
 │  messages: [ ...conversation history ]            │
 └────────────────────┬─────────────────────────────┘
                      │
                      ▼
               ┌─────────────┐
               │ stop_reason? │
               └──────┬──────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     "end_turn"   "tool_use"    other
          │           │           │
          ▼           │           ▼
     Return text      │      Return text
     to user          │
                      ▼
         ┌────────────────────────────┐
         │  For each tool_use block:  │
         │                            │
         │  1. Extract name + args    │
         │  2. mcpClient.callTool()   │──────┐
         │  3. Collect text result    │      │ JSON-RPC
         │  4. Build tool_result msg  │      │ over stdio
         └────────────┬───────────────┘      │
                      │                      ▼
                      │         ┌─────────────────────┐
                      │         │    MCP Server        │
                      │         │  ─ validate input    │
                      │         │  ─ execute handler   │
                      │         │  ─ return content[]  │
                      │         └─────────────────────┘
                      │
                      ▼
              Append to messages:
                assistant: [text + tool_use blocks]
                user:      [tool_result blocks]
                      │
                      ▼
              Loop back to Claude API
              (max 10 iterations)
```

**Message accumulation example** (3-tool interaction):

```
messages[0]  user:      "Add Dune to the database and show all sci-fi books"
messages[1]  assistant: [tool_use: query_database INSERT...]
messages[2]  user:      [tool_result: {changes: 1, lastInsertRowid: 9}]
messages[3]  assistant: [tool_use: query_database SELECT...WHERE genre='Science Fiction']
messages[4]  user:      [tool_result: [{...}, {...}, {...}]]
messages[5]  assistant: [text: "Done! I added Dune and here are all sci-fi books..."]
```

---

## Tool Registry

All tools are registered on the MCP server using the `server.tool()` API with
**Zod schemas** for input validation. The MCP SDK auto-converts Zod to JSON
Schema for the wire protocol.

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                        MCP Server Tools                          │
  ├──────────────────┬──────────────────────────┬────────────────────┤
  │  Tool            │  Parameters              │  Backend           │
  ├──────────────────┼──────────────────────────┼────────────────────┤
  │  read_file       │  path: string            │  fs.readFile       │
  │  write_file      │  path: string,           │  fs.writeFile      │
  │                  │  content: string         │                    │
  │  list_directory  │  path?: string           │  fs.readdir        │
  │  fetch_url       │  url: string             │  global fetch()    │
  │  get_weather     │  city: string            │  wttr.in API       │
  │  get_sports_scores│ league: string          │  ESPN API          │
  │  run_code        │  code: string            │  python3 (exec)    │
  │  web_search      │  query: string,          │  Brave Search API  │
  │                  │  count?: number          │                    │
  │  query_database  │  sql: string,            │  better-sqlite3    │
  │                  │  params?: array          │                    │
  └──────────────────┴──────────────────────────┴────────────────────┘
```

**Tool response format** (MCP standard):

```
{
  content: [{ type: "text", text: "..." }],
  isError?: boolean
}
```

---

## Workspace Sandbox

File-system tools (`read_file`, `write_file`, `list_directory`) are restricted
to the `workspace/` directory via the `safePath()` guard.

```
  User-supplied path         safePath()            Result
  ─────────────────         ──────────            ──────
  "notes.txt"          ──▶  workspace/notes.txt    OK
  "sub/dir/file.md"    ──▶  workspace/sub/dir/...  OK
  "../../etc/passwd"   ──▶  /etc/passwd            ERROR: escapes workspace
  "../.env"            ──▶  .env                   ERROR: escapes workspace
```

**Implementation:**

```
  resolve(WORKSPACE_DIR, userPath)
      │
      ▼
  Does resolved path start
  with WORKSPACE_DIR + "/" ?  ───── No ──▶  throw Error
      │
     Yes
      │
      ▼
  Return resolved path
```

---

## Database Layer

### Initialization Flow

```
  Server startup
      │
      ▼
  ┌─────────────────────────────────┐
  │  Open workspace/data.db         │
  │  (created if not exists)        │
  └──────────┬──────────────────────┘
             │
             ▼
  ┌─────────────────────────────────┐
  │  PRAGMA journal_mode = WAL      │
  │  (Write-Ahead Logging for       │
  │   concurrent read performance)  │
  └──────────┬──────────────────────┘
             │
             ▼
  ┌─────────────────────────────────┐
  │  seedDatabase(db)               │
  │                                 │
  │  CREATE TABLE IF NOT EXISTS     │
  │    books (...)                  │
  │    users (...)                  │
  │                                 │
  │  IF books empty:                │
  │    INSERT 8 classic books       │
  │  IF users empty:                │
  │    INSERT 5 sample users        │
  └─────────────────────────────────┘
```

### Schema

```
  ┌─────────────────────────────┐       ┌─────────────────────────────┐
  │          books               │       │          users               │
  ├─────────────────────────────┤       ├─────────────────────────────┤
  │  id     INTEGER PK AUTO     │       │  id     INTEGER PK AUTO     │
  │  title  TEXT NOT NULL        │       │  name   TEXT NOT NULL        │
  │  author TEXT NOT NULL        │       │  email  TEXT NOT NULL        │
  │  year   INTEGER              │       │  favorite_genre TEXT         │
  │  genre  TEXT                 │◀──────│                             │
  └─────────────────────────────┘ JOIN  └─────────────────────────────┘
                                  on genre = favorite_genre
```

**Seed data (8 books across 5 genres):**

```
  Fiction          │  Dystopian        │  Science Fiction
  ─────────────────│──────────────────│───────────────────
  To Kill a        │  1984             │  Neuromancer
  Mockingbird      │  Brave New World  │  The Left Hand
  The Great Gatsby │                   │  of Darkness
                   │                   │
  Fantasy          │  Romance          │
  ─────────────────│──────────────────│
  The Hobbit       │  Pride and        │
                   │  Prejudice        │
```

### query_database Tool Flow

```
  Incoming SQL string + optional params[]
      │
      ▼
  ┌───────────────────────────────┐
  │  Multi-statement detection:   │
  │  contains ";" before end?     │
  └──────────┬────────────────────┘
             │
     ┌───────┴────────┐
     ▼                ▼
   Yes               No
     │                │
     ▼                ▼
  db.exec(sql)   ┌──────────────────────────┐
     │           │  Trim & uppercase check  │
     ▼           └──────────┬───────────────┘
  { executed:               │
    true }       ┌──────────┴──────────┐
                 ▼                     ▼
              SELECT /            Everything
              PRAGMA /            else (INSERT,
              EXPLAIN             UPDATE, DELETE,
                 │                CREATE, DROP)
                 │                     │
                 ▼                     ▼
              db.prepare(sql)      db.prepare(sql)
                .all(...params)      .run(...params)
                 │                     │
                 ▼                     ▼
              JSON array            { changes,
              of row objects          lastInsertRowid }
                 │                     │
                 └──────────┬──────────┘
                            ▼
                 ┌──────────────────────────┐
                 │  Return as MCP content   │
                 │  (or isError on catch)   │
                 └──────────────────────────┘
```

**Parameterized queries** prevent SQL injection by binding values separately:

```json
{
  "sql": "SELECT * FROM books WHERE year > ? AND genre = ?",
  "params": [1950, "Science Fiction"]
}
```

---

## Transport & Protocol

Communication between client and server uses **JSON-RPC 2.0** over standard
I/O pipes, as defined by the MCP specification.

```
  ┌──────────┐  stdout ──▶  ┌──────────┐
  │  Server  │               │  Client  │
  │ process  │  ◀── stdin    │ process  │
  └──────────┘               └──────────┘
       │
       │ stderr (logging only,
       │  not part of protocol)
       ▼
   Terminal output: [server] ...
```

**Why stdio?**
- No network ports needed
- Parent-child process relationship guarantees cleanup
- Simple, no configuration
- Perfect for local single-user agents

**Wire format example** (tool call):

```json
─── Client → Server (stdin) ───
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "query_database",
    "arguments": { "sql": "SELECT * FROM books" }
  }
}

─── Server → Client (stdout) ───
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "[{\"id\":1,...}]" }]
  }
}
```

---

## Dynamic System Prompt

The client builds the system prompt at runtime from discovered tools, so adding
a new tool to the server requires **zero client changes**.

```
  listTools() response
      │
      ▼
  ┌────────────────────────────────────────────────────────┐
  │  "You are a helpful assistant with access to these     │
  │   tools:                                               │
  │   - read_file: Read the contents of a file ...         │
  │   - write_file: Write content to a file ...            │
  │   - list_directory: List files and directories ...     │
  │   - fetch_url: Fetch the content of a URL ...          │
  │   - get_weather: Get the current weather ...           │
  │   - get_sports_scores: Get recent/live sports ...      │
  │   - run_code: Run a Python script ...                  │
  │   - web_search: Search the web using Brave ...         │
  │   - query_database: Run a SQL query against ...        │
  │                                                        │
  │   Always prefer using the specific tool designed ..."  │
  └────────────────────────────────────────────────────────┘
                      │
                      ▼
              Sent as `system` parameter
              to Claude API on every call
```

---

## Dependency Map

```
  ┌─────────────────────────────────────────────────────────┐
  │                      client.ts                           │
  │                                                          │
  │  @anthropic-ai/sdk ──── Claude API calls                 │
  │  @modelcontextprotocol/sdk/client ── MCP client + stdio  │
  │  dotenv ──── loads .env (ANTHROPIC_API_KEY)              │
  └──────────────────────────┬──────────────────────────────┘
                             │ spawns
  ┌──────────────────────────▼──────────────────────────────┐
  │                      server.ts                           │
  │                                                          │
  │  @modelcontextprotocol/sdk/server ── MCP server + stdio  │
  │  zod ──── tool input schema validation                   │
  │  better-sqlite3 ──── synchronous SQLite driver           │
  │  node:fs ──── workspace file operations                  │
  │  node:path ──── path resolution & sandbox                │
  │  node:child_process ──── python3 execution (run_code)    │
  │  node:util ──── promisify(execFile)                      │
  │  node:crypto ──── randomUUID for temp file names         │
  └──────────────────────────┬──────────────────────────────┘
                             │ imports
  ┌──────────────────────────▼──────────────────────────────┐
  │                       seed.ts                            │
  │                                                          │
  │  better-sqlite3 ──── table creation & seed inserts       │
  └─────────────────────────────────────────────────────────┘
```

---

## Adding a New Tool

Because the client discovers tools dynamically, adding a tool only requires
editing `server.ts`:

```
  1.  server.tool(
  2.    "tool_name",                         // unique name
  3.    "Human-readable description",        // used in system prompt
  4.    { param: z.string() },               // Zod schema → JSON Schema
  5.    async ({ param }) => {               // handler
  6.      // ... implementation ...
  7.      return {
  8.        content: [{ type: "text", text: result }]
  9.      };
  10.   },
  11. );
```

After restarting the server, the client will pick it up automatically via
`listTools()` and include it in the system prompt sent to Claude.

---

## External API Integrations

```
  ┌────────────────┐     HTTP GET      ┌───────────────────────┐
  │  get_weather    │ ───────────────▶  │  wttr.in/?format=3    │
  │                 │ ◀────────────── │  (no API key needed)   │
  └────────────────┘   plain text      └───────────────────────┘

  ┌────────────────┐     HTTP GET      ┌───────────────────────┐
  │get_sports_scores│ ──────────────▶  │  ESPN Scoreboard API  │
  │                 │ ◀────────────── │  (public, no key)      │
  └────────────────┘   JSON            └───────────────────────┘
                                        17 leagues supported:
                                        NFL, NBA, MLB, NHL, MLS,
                                        EPL, NCAA (M/W/F), WNBA,
                                        Champions League, FIFA,
                                        NWSL, F1, PGA, ATP, WTA

  ┌────────────────┐     HTTP GET      ┌───────────────────────┐
  │  web_search     │ ───────────────▶  │  Brave Search API     │
  │                 │ ◀────────────── │  (requires BRAVE_API_  │
  └────────────────┘   JSON            │   KEY in .env)         │
                                       └───────────────────────┘

  ┌────────────────┐     HTTP GET      ┌───────────────────────┐
  │  fetch_url      │ ───────────────▶  │  Any URL              │
  │                 │ ◀────────────── │  (truncated to 5000ch) │
  └────────────────┘   text            └───────────────────────┘

  ┌────────────────┐    spawns         ┌───────────────────────┐
  │  run_code       │ ───────────────▶  │  python3 process      │
  │                 │ ◀────────────── │  (10s timeout, temp    │
  └────────────────┘   stdout+stderr   │   file in .tmp/)      │
                                       └───────────────────────┘
```

---

## Error Handling

All tools follow the same error pattern:

```
  Tool handler
      │
      ├── Success ──▶  { content: [{type:"text", text: ...}] }
      │
      └── Failure ──▶  { content: [{type:"text", text: error}], isError: true }
```

The `isError: true` flag is forwarded through MCP to the client, which passes
it as `is_error` on the `tool_result` message to Claude. This lets Claude
understand the tool failed and respond accordingly (retry, explain the error,
or try an alternative approach).
