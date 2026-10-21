import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { READ_TOOLS, screenRequest, screenToolList, serverEnv } from "../src/mcp-readonly.mjs";
import { MCP_READONLY_PROXY } from "../src/index.js";

// The read-only filter every harness starts the Infino MCP server through:
// its screening rules, then the real script in front of a fake server.
const FAKE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

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
    const listed = screenToolList({ tools: [{ name: "infino_sql" }, { name: "infino_add_documents" }, { name: "infino_count" }], nextCursor: "c" });
    deepStrictEqual(listed, { tools: [{ name: "infino_sql" }, { name: "infino_count" }], nextCursor: "c" });
  });

  it("keeps no write tool of the current server on the read list", () => {
    for (const write of ["infino_add_documents", "infino_update_documents", "infino_delete_documents", "infino_create_table", "infino_drop_table", "infino_create_database"]) {
      strictEqual(READ_TOOLS.has(write), false, write);
    }
  });

  it("passes the server only the environment it needs", () => {
    deepStrictEqual(
      serverEnv({ PATH: "/bin", HOME: "/h", INFINO_API_KEY: "k", INFINO_MCP_URI: "u", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret" }),
      { PATH: "/bin", HOME: "/h", INFINO_API_KEY: "k", INFINO_MCP_URI: "u" },
    );
  });
});

describe("read-only MCP proxy, end to end", () => {
  /** Sends requests through the real proxy script and returns the replies by id. */
  async function exchange(
    requests: object[],
  ): Promise<Map<unknown, { result: { tools?: { name: string }[]; envKeys?: string[]; content?: { text: string }[]; isError?: boolean } }>> {
    const proxy = spawn(process.execPath, [MCP_READONLY_PROXY, FAKE], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ANTHROPIC_API_KEY: "secret", INFINO_API_KEY: "k" },
    });
    const replies = new Map();
    const done = new Promise<void>((resolve) => {
      createInterface({ input: proxy.stdout }).on("line", (line) => {
        const message = JSON.parse(line);
        replies.set(message.id, message);
        if (replies.size === requests.length) resolve();
      });
    });
    for (const request of requests) proxy.stdin.write(`${JSON.stringify(request)}\n`);
    await done;
    proxy.stdin.end();
    await new Promise((resolve) => proxy.once("exit", resolve));
    return replies;
  }

  it("filters the tool list, refuses writes, forwards reads, and strips the environment", async () => {
    const replies = await exchange([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "infino_drop_table", arguments: { table: "t" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "infino_sql", arguments: { query: "SELECT 1" } } },
    ]);
    deepStrictEqual(replies.get(1)?.result.tools?.map((t) => t.name), ["infino_sql"]);
    deepStrictEqual(replies.get(2)?.result, {
      content: [{ type: "text", text: "infino_drop_table is not available: this agent is read-only" }],
      isError: true,
    });
    strictEqual(replies.get(3)?.result.content?.[0].text, "ran infino_sql");
    const envKeys = replies.get(1)?.result.envKeys ?? [];
    strictEqual(envKeys.includes("INFINO_API_KEY"), true);
    strictEqual(envKeys.includes("ANTHROPIC_API_KEY"), false, "a model key must not reach the server");
  });
});
