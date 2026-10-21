import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, describe, it } from "node:test";
import { InfinoClient } from "@infino-ai/analytics-core";
import { startOpencode, type OpencodeServer, type StartOptions } from "../src/server.js";

// startOpencode against a fake opencode binary: the real spawn, boot checks,
// password, environment, and shutdown, with no model or network involved.
const FAKE = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

const dirs: string[] = [];
const servers: OpencodeServer[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  delete process.env.FAKE_OPENCODE_MODE;
  delete process.env.OPENCODE_PERMISSION;
});

function options(mode = "", timing: StartOptions["timing"] = {}): StartOptions {
  const dataDir = mkdtempSync(join(tmpdir(), "fino-opencode-test-"));
  dirs.push(dataDir);
  process.env.FAKE_OPENCODE_MODE = mode;
  process.env.FAKE_OPENCODE_URL_FILE = join(dataDir, "url");
  return {
    infino: new InfinoClient({ uri: "https://example.test/db", apiKey: "test" }),
    infinoApiKey: "test",
    model: "fake/model",
    systemPrompt: "you are a test",
    steps: 5,
    mcpTimeoutMs: 1000,
    dataDir,
    binary: FAKE,
    timing: { bootMs: 5000, connectMs: 5000, killGraceMs: 300, ...timing },
  };
}

async function boot(mode = "", timing: StartOptions["timing"] = {}) {
  const opts = options(mode, timing);
  const server = await startOpencode(opts);
  servers.push(server);
  return { server, url: readFileSync(join(opts.dataDir, "url"), "utf8") };
}

describe("startOpencode", () => {
  it("answers only requests carrying this boot's password", async () => {
    const { server, url } = await boot();
    strictEqual((await fetch(`${url}/experimental/tool/ids`)).status, 401);
    const wrong = `Basic ${Buffer.from("fino:guess").toString("base64")}`;
    strictEqual((await fetch(`${url}/experimental/tool/ids`, { headers: { authorization: wrong } })).status, 401);
    strictEqual(await server.backend.createSession(), "ses_new", "the backend authenticates");
  });

  it("keeps the host's OPENCODE_* variables from the server", async () => {
    process.env.OPENCODE_PERMISSION = '{"bash":"allow"}';
    const { url } = await boot();
    const keys = (await (await fetch(`${url}/debug/env`)).json()) as string[];
    ok(!keys.includes("OPENCODE_PERMISSION"), "a host override must not reach opencode");
    ok(keys.includes("OPENCODE_SERVER_PASSWORD") && keys.includes("OPENCODE_CONFIG_CONTENT"));
  });

  it("sends each question under the id the run chose", async () => {
    const { server, url } = await boot();
    await server.backend.prompt("ses_new", "how many rows?", "msg_0123456789abExampleId1234");
    const [prompt] = (await (await fetch(`${url}/debug/prompts`)).json()) as { id: string; messageID: string; agent: string }[];
    deepStrictEqual([prompt.id, prompt.messageID, prompt.agent], ["ses_new", "msg_0123456789abExampleId1234", "fino"]);
  });

  it("tells a missing session from a failed lookup", async () => {
    const { server } = await boot();
    strictEqual(await server.backend.hasSession("ses_known"), true);
    strictEqual(await server.backend.hasSession("ses_missing"), false);
    // Another harness's id; opencode would answer it with a 500.
    strictEqual(await server.backend.hasSession("resp_0123"), false);
    await rejects(server.backend.hasSession("ses_broken"), /session lookup failed/);
  });

  it("refuses to boot with a built-in tool it does not disable", async () => {
    await rejects(startOpencode(options("extra-tool")), /built-in tools this harness does not disable: brand_new_tool/);
  });

  it("refuses to boot when an MCP server did not connect", async () => {
    await rejects(startOpencode(options("mcp-failed")), /MCP servers did not connect: fino: failed \(connect ECONNREFUSED\)/);
  });

  it("reports a server that exits during boot, with its output", async () => {
    await rejects(startOpencode(options("exit-early")), (err: Error) => {
      match(err.message, /exited \(code 3\)/);
      match(err.message, /boom: config invalid/);
      return true;
    });
  });

  it("gives up on a server that never starts listening", async () => {
    await rejects(startOpencode(options("never-listen", { bootMs: 300 })), /did not start within 300 ms/);
  });

  it("gives up on an event stream that never connects", async () => {
    const { server } = await boot("no-greeting", { connectMs: 200 });
    await rejects(server.backend.subscribe(new AbortController().signal));
  });

  it("ends open event streams when the server dies", async () => {
    const { server, url } = await boot();
    const events = (await server.backend.subscribe(new AbortController().signal))[Symbol.asyncIterator]();
    const next = events.next().catch(() => ({ done: true }));
    await fetch(`${url}/debug/exit`);
    strictEqual((await next).done, true);
    strictEqual(server.alive(), false);
  });

  it("kills a server that ignores SIGTERM", async () => {
    const { server } = await boot("ignore-sigterm", { killGraceMs: 200 });
    const started = Date.now();
    await server.close();
    strictEqual(server.alive(), false);
    ok(Date.now() - started < 3000);
  });
});
