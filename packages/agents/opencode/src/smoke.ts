// Live end-to-end check: boots opencode, asks one question that needs both
// the data tools and the chart tool. It is not a unit test: it spends tokens
// and needs credentials:
//
//   set -a; source .env; set +a
//   npm run smoke -w @infino-ai/analytics-agent-opencode
import { createOpencodeHarness } from "./index.js";

const uri = process.env.INFINO_URI;
if (!uri) throw new Error("INFINO_URI is not set");

const harness = createOpencodeHarness({ infino: { uri }, dataDir: process.env.OPENCODE_DATA_DIR });
const question = "Which tables exist? Pick one, count its rows, and show the count as a metric chart.";
let failed = false;
for await (const event of harness({ question })) {
  if (event.type === "step") console.log(`     step: ${event.tool} ${event.detail?.slice(0, 100) ?? ""}`);
  if (event.type === "step_done" && !event.ok) console.log(`     step failed: ${event.result?.slice(0, 200)}`);
  if (event.type === "chart") console.log(`     chart: ${event.spec.title} (${event.result.metadata.row_count} rows)`);
  if (event.type === "progress") console.log(`OPENCODE ok — ${event.text.slice(0, 200)}`);
  if (event.type === "error") {
    failed = true;
    console.error(`OPENCODE FAILED — ${event.message}`);
  }
  if (event.type === "done") console.log(`     done: ${event.turns} turns, $${event.costUsd?.toFixed(4)}`);
}
process.exit(failed ? 1 : 0);
