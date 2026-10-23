// A stand-in for the Infino MCP server, speaking raw newline-delimited
// JSON-RPC: one read tool and one write tool. Its tool list also carries the
// environment variable names it was started with, in an extra envKeys field.
// Any tool it receives a call for answers "ran <name>", so a refused call is
// one that never arrived.
import { createInterface } from "node:readline";

const TOOLS = ["infino_sql", "infino_drop_table"].map((name) => ({ name, inputSchema: { type: "object" } }));
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS, envKeys: Object.keys(process.env).sort() } });
  }
  if (message.method === "tools/call") {
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `ran ${message.params.name}` }] } });
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
