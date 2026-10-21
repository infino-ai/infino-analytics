#!/usr/bin/env node
// A stand-in for the opencode binary: answers the routes the harness calls,
// with the same password check, and misbehaves on request through
// FAKE_OPENCODE_MODE (comma-separated): exit-early, never-listen,
// ignore-sigterm, extra-tool, mcp-failed, no-greeting.
//
// /debug/* routes skip the password; they exist only for the tests, which
// find the server through the URL it writes to FAKE_OPENCODE_URL_FILE.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const modes = new Set((process.env.FAKE_OPENCODE_MODE ?? "").split(",").filter(Boolean));
const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("1.19.2");
  process.exit(0);
}
if (modes.has("ignore-sigterm")) process.on("SIGTERM", () => {});
if (modes.has("exit-early")) {
  console.error("boom: config invalid");
  process.exit(3);
}
if (modes.has("never-listen")) setInterval(() => {}, 1000);
else listen();

function listen() {
  const port = Number(args.find((a) => a.startsWith("--port="))?.slice("--port=".length));
  const expected = `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
  const prompts = [];
  const tools = ["apply_patch", "bash", "edit", "glob", "grep", "invalid", "question", "read", "skill", "task", "todowrite", "webfetch", "websearch", "write"];
  if (modes.has("extra-tool")) tools.push("brand_new_tool");

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (path === "/debug/env") return json(res, 200, Object.keys(process.env));
      if (path === "/debug/prompts") return json(res, 200, prompts);
      if (path === "/debug/exit") {
        json(res, 200, true);
        return setTimeout(() => process.exit(1), 10);
      }
      if (req.headers.authorization !== expected) return json(res, 401, { error: "unauthorized" });

      if (path === "/experimental/tool/ids") return json(res, 200, tools);
      if (path === "/mcp") {
        return json(res, 200, {
          "infino-engine": { status: "connected" },
          fino: modes.has("mcp-failed") ? { status: "failed", error: "connect ECONNREFUSED" } : { status: "connected" },
        });
      }
      if (path === "/session/status") return json(res, 200, {});
      if (path === "/session" && req.method === "POST") return json(res, 200, { id: "ses_new" });
      const session = path.match(/^\/session\/([^/]+)(\/.*)?$/);
      if (session) {
        const [, id, rest] = session;
        if (rest === "/prompt_async") {
          prompts.push({ id, ...JSON.parse(body || "{}") });
          res.writeHead(204).end();
          return;
        }
        if (rest === "/abort") return json(res, 200, true);
        if (id === "ses_known") return json(res, 200, { id });
        if (id === "ses_broken") return json(res, 500, { error: "storage failed" });
        return json(res, 404, { error: "not found" });
      }
      if (path === "/event") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (!modes.has("no-greeting")) res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
        return;
      }
      json(res, 404, { error: `no route ${path}` });
    });
  }).listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    if (process.env.FAKE_OPENCODE_URL_FILE) writeFileSync(process.env.FAKE_OPENCODE_URL_FILE, url);
    console.log(`opencode server listening on ${url}`);
  });
}
