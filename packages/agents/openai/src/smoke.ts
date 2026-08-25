// Live reachability check for the two external surfaces this harness needs.
// Not a unit test — it spends tokens and requires credentials:
//
//   set -a; source .env; set +a
//   npm run smoke -w @infino-ai/analytics-agent-openai
import { connectInfinoMcp } from "./mcp.js";
import { createOpenAIHarness } from "./index.js";

const uri = process.env.INFINO_URI;
if (!uri) throw new Error("INFINO_URI is not set");

const mcp = await connectInfinoMcp({
  databaseUri: uri,
  apiKey: process.env.INFINO_API_KEY ?? "",
});
try {
  console.log(`MCP  ok — ${mcp.tools.length} tools: ${mcp.tools.map((t) => t.name).join(", ")}`);
  const listTables = mcp.tools.find((t) => t.name === "infino_list_tables");
  if (listTables) console.log(`     tables: ${(await mcp.call("infino_list_tables", {})).text.slice(0, 200)}`);
} finally {
  await mcp.close();
}

const harness = createOpenAIHarness({ infino: { uri } });
for await (const event of harness({ question: "Which tables exist? Answer in one sentence." })) {
  if (event.type === "step") console.log(`     step: ${event.tool}`);
  if (event.type === "progress") console.log(`OPENAI ok — ${event.text.slice(0, 200)}`);
  if (event.type === "error") console.error(`OPENAI FAILED — ${event.message}`);
}
