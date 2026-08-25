import { strictEqual, throws } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { connectInfinoMcp } from "../src/mcp.js";

const ENTRY = fileURLToPath(new URL("./fixtures/echo-server.ts", import.meta.url));

const connect = () =>
  connectInfinoMcp({ databaseUri: "https://example.test/db", apiKey: "test", entry: ENTRY });

const alive = (pid: number | null) => {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("connectInfinoMcp", () => {
  it("lists the server's tools as Responses function tools", async () => {
    const mcp = await connect();
    try {
      strictEqual(mcp.tools.length, 1);
      strictEqual(mcp.tools[0].name, "echo");
      strictEqual(mcp.tools[0].type, "function");
    } finally {
      await mcp.close();
    }
  });

  it("calls a tool and flattens its text content", async () => {
    const mcp = await connect();
    try {
      const result = await mcp.call("echo", { message: "hi" });
      strictEqual(result.text, "hi");
      strictEqual(result.isError, false);
    } finally {
      await mcp.close();
    }
  });

  // The regression this whole module exists to prevent: one orphaned Node
  // process per question.
  it("kills the child process on close", async () => {
    const mcp = await connect();
    const pid = mcp.pid;
    strictEqual(alive(pid), true);
    await mcp.close();
    // close() ends stdin and escalates to a signal; give the OS a moment.
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    throws(() => process.kill(pid as number, 0), /ESRCH/);
  });
});
