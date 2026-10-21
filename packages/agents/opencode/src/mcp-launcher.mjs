// Starts the Infino MCP server with only the environment it needs. opencode
// hands its MCP children its own environment, which holds the model provider
// keys; none of those belong in a process that runs the agent's queries.
//
//   node mcp-launcher.mjs <path to @infino-ai/mcp-server entry>
//
// Plain JavaScript, so it runs under any Node without type stripping.
import { pathToFileURL } from "node:url";

const KEEP = /^(PATH|HOME|TMPDIR|TEMP|TMP|SYSTEMROOT|INFINO_.+)$/;

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node mcp-launcher.mjs <mcp server entry>");
  process.exit(2);
}
for (const key of Object.keys(process.env)) {
  if (!KEEP.test(key)) delete process.env[key];
}
// The server sees itself as the entry point, as if run directly.
process.argv.splice(1, 2, entry);
await import(pathToFileURL(entry).href);
