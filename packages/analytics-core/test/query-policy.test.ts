import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { screenCall } from "../src/mcp-readonly.mjs";
import { checkQuery, loadQueryPolicy } from "../src/query-policy.mjs";
import { MCP_READONLY_PROXY, mcpServerEnv, runCreateChart, type InfinoClient } from "../src/index.js";

// The optional query policy (FINO_QUERY_POLICY): its verdicts, the read-only
// filter applying it in front of a fake server, and the chart tool applying
// it to its SQL. This file runs in its own process, so setting the variable
// here reaches the chart tool's lazy load and nothing else.
const POLICY = fileURLToPath(new URL("./fixtures/query-policy.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
process.env.FINO_QUERY_POLICY = POLICY;

type Reply = { id?: unknown; result?: { content?: { text: string }[]; isError?: boolean } };

describe("query policy verdicts", () => {
  it("allows everything when no policy is configured", async () => {
    strictEqual(await loadQueryPolicy(""), null);
    strictEqual(await checkQuery(null, "infino_sql", { query: "SELECT * FROM big_table" }), undefined);
    strictEqual(await screenCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "infino_sql" } }, null), null);
  });

  it("returns the policy's reason, and refuses when the policy throws", async () => {
    const policy = await loadQueryPolicy(POLICY);
    strictEqual(await checkQuery(policy, "infino_sql", { query: "SELECT 1" }), undefined);
    strictEqual(await checkQuery(policy, "infino_sql", { query: "SELECT * FROM big_table" }), "big_table needs a time filter");
    match(
      (await checkQuery(() => {
        throw new Error("boom");
      }, "infino_sql", {})) ?? "",
      /query policy failed on this call \(boom\)/,
    );
  });

  it("answers a refused MCP call as a tool error the model can read", async () => {
    const policy = await loadQueryPolicy(POLICY);
    const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "infino_keyword_search", arguments: { table: "big_table", query: "x" } } };
    deepStrictEqual(await screenCall(call, policy), {
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "infino_keyword_search was refused by this deployment's query policy: big_table needs a time filter" }],
        isError: true,
      },
    });
    strictEqual(await screenCall({ jsonrpc: "2.0", id: 8, method: "tools/list" }, policy), null);
  });

  it("passes the MCP server the policy path and embedding settings, nothing else", () => {
    deepStrictEqual(
      mcpServerEnv("https://h/db", "k", undefined, {
        FINO_QUERY_POLICY: "policy.mjs",
        INFINO_MCP_EMBED_BASE_URL: "http://embed/v1",
        INFINO_MCP_EMBED_MODEL: "m",
        INFINO_MCP_EMBED_API_KEY: "",
        ANTHROPIC_API_KEY: "secret",
      }),
      {
        INFINO_MCP_URI: "https://h/db",
        INFINO_API_KEY: "k",
        INFINO_MCP_EMBED_BASE_URL: "http://embed/v1",
        INFINO_MCP_EMBED_MODEL: "m",
        FINO_QUERY_POLICY: `${process.cwd()}/policy.mjs`,
      },
    );
  });

  it("lets a chosen embedder replace the server's, without its API key for another host", () => {
    const saved = { ...process.env };
    try {
      process.env.INFINO_MCP_EMBED_API_KEY = "secret";
      process.env.INFINO_MCP_EMBED_BASE_URL = "http://embed/v1";
      delete process.env.FINO_QUERY_POLICY;
      deepStrictEqual(
        mcpServerEnv("https://h/db", "k", { baseUrl: "https://elsewhere/v1", model: "other" }, process.env),
        {
          INFINO_MCP_URI: "https://h/db",
          INFINO_API_KEY: "k",
          INFINO_MCP_EMBED_PROVIDER: "openai",
          INFINO_MCP_EMBED_BASE_URL: "https://elsewhere/v1",
          INFINO_MCP_EMBED_MODEL: "other",
        },
      );
    } finally {
      process.env = saved;
    }
  });
});

describe("query policy in the read-only proxy, end to end", () => {
  it("refuses what the policy refuses and forwards the rest", async () => {
    const child = spawn(process.execPath, [MCP_READONLY_PROXY, FAKE], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, FINO_QUERY_POLICY: POLICY },
    });
    const replies = new Map<unknown, Reply>();
    const done = new Promise<void>((resolve) => {
      createInterface({ input: child.stdout }).on("line", (line) => {
        const message = JSON.parse(line) as Reply;
        replies.set(message.id, message);
        if (replies.size === 3) resolve();
      });
    });
    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "infino_sql", arguments: { query: "SELECT 1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "infino_sql", arguments: { query: "SELECT * FROM big_table" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "infino_sql", arguments: { query: "SELECT 2" } } },
    ]) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    await done;
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    strictEqual(replies.get(1)?.result?.content?.[0].text, "ran infino_sql");
    strictEqual(replies.get(2)?.result?.isError, true);
    match(replies.get(2)?.result?.content?.[0].text ?? "", /big_table needs a time filter/);
    strictEqual(replies.get(3)?.result?.content?.[0].text, "ran infino_sql");
  });

  it("will not start when the configured policy cannot load", async () => {
    const child = spawn(process.execPath, [MCP_READONLY_PROXY, FAKE], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, FINO_QUERY_POLICY: "/nonexistent/policy.mjs" },
    });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    strictEqual(code, 2);
  });
});

describe("query policy in the chart tool", () => {
  it("refuses a chart before its SQL runs", async () => {
    const sent: string[] = [];
    const client = {
      querySql: async (sql: string) => {
        sent.push(sql);
        return [{ n: 1 }];
      },
    } as unknown as InfinoClient;
    const events: unknown[] = [];
    const args = { title: "t", chart_type: "metric" as const, table: "big_table", sql: "SELECT COUNT(*) AS n FROM big_table", y: ["n"] };
    const refused = await runCreateChart(client, args, (e) => events.push(e));
    deepStrictEqual(refused, {
      ok: false,
      error: "create_chart was refused by this deployment's query policy: big_table needs a time filter",
    });
    strictEqual(sent.length, 0);
    strictEqual(events.length, 0);

    const allowed = await runCreateChart(client, { ...args, table: "small", sql: "SELECT COUNT(*) AS n FROM small" }, (e) => events.push(e));
    strictEqual(allowed.ok, true);
    strictEqual(sent.length, 1);
  });
});
