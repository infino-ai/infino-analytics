import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { READ_TOOLS, screenRequest, screenToolList, serverEnv } from "../src/mcp-readonly.mjs";
import { MCP_READONLY_PROXY } from "../src/index.js";

// The read-only filter every harness starts the Infino MCP server through:
// its screening rules, the real script in front of a fake server, and the
// installed @infino-ai/mcp-server itself, started offline on memory://.
const FAKE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const REAL = createRequire(import.meta.url).resolve("@infino-ai/mcp-server");

// The installed server's tools that change data. Never shown to the agent;
// listed so that a server release adding a tool fails the classification
// test below until someone puts it on this list or on READ_TOOLS.
const KNOWN_WRITES = new Set([
  "infino_add_documents",
  "infino_update_documents",
  "infino_delete_documents",
  "infino_create_table",
  "infino_drop_table",
  "infino_create_database",
]);

type Reply = {
  id?: unknown;
  result?: {
    tools?: { name: string; description?: string; annotations?: Record<string, unknown> }[];
    envKeys?: string[];
    content?: { text: string }[];
    isError?: boolean;
  };
};

/** Sends JSON-RPC lines to a child process and returns its replies by id,
 * once every request that has an id is answered. */
async function exchange(command: string[], env: NodeJS.ProcessEnv, messages: object[]): Promise<Map<unknown, Reply>> {
  const child = spawn(process.execPath, command, { stdio: ["pipe", "pipe", "ignore"], env });
  const expected = messages.filter((m) => "id" in m).length;
  const replies = new Map<unknown, Reply>();
  const done = new Promise<void>((resolve) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Reply;
      if (message.id === undefined) return;
      replies.set(message.id, message);
      if (replies.size === expected) resolve();
    });
  });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  await done;
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  return replies;
}

const HANDSHAKE = [
  { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];
const OFFLINE = { PATH: process.env.PATH, HOME: process.env.HOME, INFINO_MCP_URI: "memory://" };

describe("read-only MCP screening", () => {
  it("forwards reads and refuses every other tool call", () => {
    deepStrictEqual(screenRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "infino_sql" } }), { forward: true });
    deepStrictEqual(screenRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "infino_drop_table" } }), {
      forward: false,
      reply: {
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "infino_drop_table is not available: this agent is read-only" }], isError: true },
      },
    });
    strictEqual(screenRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "infino_tool_from_the_future" } }).forward, false);
  });

  it("forwards everything that is not a tool call", () => {
    deepStrictEqual(screenRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), { forward: true });
    deepStrictEqual(screenRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), { forward: true });
  });

  it("lists only read tools", () => {
    const listed = screenToolList({ tools: [{ name: "infino_count" }, { name: "infino_add_documents" }], nextCursor: "c" });
    deepStrictEqual(listed, { tools: [{ name: "infino_count" }], nextCursor: "c" });
  });

  it("describes infino_sql as read-only", () => {
    const [sql] = screenToolList({
      tools: [
        {
          name: "infino_sql",
          description: "Use for analytical questions. Any single statement is allowed, DDL/DML included.",
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
      ],
    }).tools;
    deepStrictEqual(sql, {
      name: "infino_sql",
      description: "Use for analytical questions. Read-only here: only SELECT and WITH queries run, and any write is refused.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
  });

  it("passes the server only the environment it needs, whatever the case of its keys", () => {
    deepStrictEqual(
      serverEnv({
        Path: "C:\\bin",
        SystemRoot: "C:\\Windows",
        HOME: "/h",
        HTTPS_PROXY: "http://proxy:3128",
        no_proxy: "localhost",
        NODE_EXTRA_CA_CERTS: "/ca.pem",
        INFINO_API_KEY: "k",
        ANTHROPIC_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
        NODE_OPTIONS: "--require /evil.js",
      }),
      {
        Path: "C:\\bin",
        SystemRoot: "C:\\Windows",
        HOME: "/h",
        HTTPS_PROXY: "http://proxy:3128",
        no_proxy: "localhost",
        NODE_EXTRA_CA_CERTS: "/ca.pem",
        INFINO_API_KEY: "k",
      },
    );
  });
});

describe("read-only MCP proxy, end to end", () => {
  it("filters the tool list, refuses writes, forwards reads, and strips the environment", async () => {
    const replies = await exchange([MCP_READONLY_PROXY, FAKE], { ...process.env, ANTHROPIC_API_KEY: "secret", INFINO_API_KEY: "k" }, [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "infino_drop_table", arguments: { table: "t" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "infino_sql", arguments: { query: "SELECT 1" } } },
    ]);
    deepStrictEqual(replies.get(1)?.result?.tools?.map((t) => t.name), ["infino_sql"]);
    deepStrictEqual(replies.get(2)?.result, {
      content: [{ type: "text", text: "infino_drop_table is not available: this agent is read-only" }],
      isError: true,
    });
    strictEqual(replies.get(3)?.result?.content?.[0].text, "ran infino_sql");
    const envKeys = replies.get(1)?.result?.envKeys ?? [];
    strictEqual(envKeys.includes("INFINO_API_KEY"), true);
    strictEqual(envKeys.includes("ANTHROPIC_API_KEY"), false, "a model key must not reach the server");
  });
});

describe("the installed Infino MCP server", () => {
  it("has every tool classified as a read or a known write", async () => {
    const replies = await exchange([REAL], OFFLINE, [...HANDSHAKE, { jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    const names = (replies.get(1)?.result?.tools ?? []).map((t) => t.name);
    ok(names.length > 0, "the server listed no tools");
    deepStrictEqual(names.filter((n) => !READ_TOOLS.has(n) && !KNOWN_WRITES.has(n)), [], "unclassified tools: add each to READ_TOOLS or KNOWN_WRITES");
    deepStrictEqual([...READ_TOOLS].filter((n) => !names.includes(n)), [], "READ_TOOLS names a tool the server does not have");
  });

  it("reaches the agent as exactly the read tools, with infino_sql read-only", async () => {
    const replies = await exchange([MCP_READONLY_PROXY, REAL], OFFLINE, [...HANDSHAKE, { jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    const tools = replies.get(1)?.result?.tools ?? [];
    deepStrictEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS].sort());
    const sql = tools.find((t) => t.name === "infino_sql");
    ok(sql?.description?.endsWith("Read-only here: only SELECT and WITH queries run, and any write is refused."));
    ok(!/DDL|DML/.test(sql?.description ?? ""), `the server's write wording survived: ${sql?.description}`);
    strictEqual(sql?.annotations?.destructiveHint, false);
    strictEqual(sql?.annotations?.readOnlyHint, true);
  });
});
