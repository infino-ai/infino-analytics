// Runs the Infino MCP server behind a read-only filter, for every harness.
//
//   node mcp-readonly.mjs <path to @infino-ai/mcp-server entry>
//
// The server exposes its whole toolset, writes included, and leaves the limit
// to the API key's scope. An analytics agent never needs to write, so the
// filter answers for the server: tools/list only returns READ_TOOLS, and a
// tools/call for anything else is refused here and never reaches it. A tool
// added in a later server release is refused until someone lists it.
// infino_sql stays: Infino Cloud's query_sql endpoint, which it uses, accepts
// only reads.
//
// The server also gets only the environment it needs. Harness processes hold
// model provider keys, and none of those belong in the process that runs the
// agent's queries.
//
// Plain JavaScript, so it runs under any Node without type stripping. MCP's
// stdio transport is newline-delimited JSON-RPC, which is all this parses.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const READ_TOOLS = new Set([
  "infino_list_tables",
  "infino_describe_table",
  "infino_sql",
  "infino_count",
  "infino_keyword_search",
  "infino_hybrid_search",
  "infino_semantic_search",
  "infino_exact_match",
  "infino_token_match",
]);

// Case-insensitive: Windows keeps each key's own case (Path, SystemRoot).
// Proxy and CA settings stay, because the server's local embedder downloads
// its model on first use, which a proxy or a TLS-inspecting CA must not break.
const KEEP_ENV =
  /^(PATH|HOME|USERPROFILE|TMPDIR|TEMP|TMP|SYSTEMROOT|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|INFINO_.+)$/i;

/** The environment the server may see. */
export function serverEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => KEEP_ENV.test(key)));
}

/** What to do with one message from the client: forward it, or answer it
 * here with `reply`. */
export function screenRequest(message) {
  if (message?.method !== "tools/call") return { forward: true };
  const name = message.params?.name;
  if (READ_TOOLS.has(name)) return { forward: true };
  return {
    forward: false,
    reply: {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: `${name} is not available: this agent is read-only` }],
        isError: true,
      },
    },
  };
}

const SQL_READ_ONLY_NOTE = "Read-only here: only SELECT and WITH queries run, and any write is refused.";

/** A tools/list result with everything outside READ_TOOLS removed, and
 * infino_sql described as the read-only tool it is behind this filter. */
export function screenToolList(result) {
  if (!result || !Array.isArray(result.tools)) return result;
  return { ...result, tools: result.tools.filter((tool) => READ_TOOLS.has(tool.name)).map(describeReadOnly) };
}

// The server describes infino_sql as accepting DDL and DML and marks it
// destructive. Passed through, that invites the model to write and spend a
// turn on each refusal.
function describeReadOnly(tool) {
  if (tool.name !== "infino_sql") return tool;
  const description = String(tool.description ?? "")
    .replace(/\s*Any single statement[^.]*\./i, "")
    .trim();
  return {
    ...tool,
    description: `${description} ${SQL_READ_ONLY_NOTE}`.trim(),
    annotations: { ...tool.annotations, readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  };
}

function run(entry) {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"], env: serverEnv(process.env) });
  const listRequests = new Set();
  const send = (stream, message) => stream.write(`${JSON.stringify(message)}\n`);

  createInterface({ input: process.stdin }).on("line", (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      child.stdin.write(`${line}\n`);
      return;
    }
    // A JSON-RPC batch is screened message by message; refusals are answered
    // here and the rest goes on as a smaller batch.
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const forwarded = [];
    for (const message of messages) {
      const verdict = screenRequest(message);
      if (!verdict.forward) {
        send(process.stdout, verdict.reply);
        continue;
      }
      if (message?.method === "tools/list" && message.id !== undefined) listRequests.add(message.id);
      forwarded.push(message);
    }
    if (forwarded.length > 0) send(child.stdin, Array.isArray(parsed) ? forwarded : forwarded[0]);
  }).on("close", () => child.stdin.end());

  createInterface({ input: child.stdout }).on("line", (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }
    const screen = (message) => {
      if (message?.id === undefined || !listRequests.has(message.id) || !message.result) return message;
      listRequests.delete(message.id);
      return { ...message, result: screenToolList(message.result) };
    };
    send(process.stdout, Array.isArray(parsed) ? parsed.map(screen) : screen(parsed));
  });

  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

// Run only as a script, not when imported for its screening functions.
// Compared as real paths: workspaces reach this file through a symlink.
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const entry = process.argv[2];
  if (!entry) {
    console.error("usage: node mcp-readonly.mjs <mcp server entry>");
    process.exit(2);
  }
  run(entry);
}
