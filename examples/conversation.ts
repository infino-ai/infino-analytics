// Multi-turn session: the follow-up resumes the same conversation, so the
// agent already knows the tables and the prior answer.
//   INFINO_URI=https://<host>/<database> INFINO_API_KEY=... npx tsx examples/conversation.ts
import { Analytics, type ChatEvent } from "@infino-ai/analytics";

function requireUri(): string {
  const uri = process.env.INFINO_URI;
  if (!uri) throw new Error("set INFINO_URI to your database endpoint: https://<host>/<database>");
  return uri;
}

const analytics = new Analytics({
  infino: { uri: requireUri() },
});

function print(event: ChatEvent) {
  switch (event.type) {
    case "sql":
      console.log(`[sql] ${event.query}`);
      break;
    case "chart":
      console.log(
        `[chart] ${event.spec.chart.type} "${event.spec.title}" rows=${event.result.metadata.row_count} binding=${JSON.stringify(event.result.metadata.binding)}`,
      );
      if (event.result.metadata.warnings.length)
        console.log(`[warnings] ${JSON.stringify(event.result.metadata.warnings)}`);
      break;
    case "summary":
      console.log(`[summary] ${event.text}`);
      break;
    case "error":
      console.log(`[error] ${event.message}`);
      break;
    case "done":
      console.log(`[done] turns=${event.turns} cost=$${event.costUsd?.toFixed(4)}\n`);
      break;
  }
}

const sessionId = analytics.createSession();

console.log("### Q1: trend\n");
for await (const e of analytics.ask("Show me a trend over time in this data", { sessionId })) print(e);

console.log("### Q2 (follow-up): drill in\n");
for await (const e of analytics.ask(
  "Break down the most interesting point from that chart",
  { sessionId },
)) print(e);
