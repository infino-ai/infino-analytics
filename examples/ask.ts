// Smoke-test the facade from the terminal:
//   INFINO_URI=https://<host>/<database> INFINO_API_KEY=... \
//     npx tsx examples/ask.ts "what stands out in this data?"
import { Analytics } from "@infino-ai/analytics";

function requireUri(): string {
  const uri = process.env.INFINO_URI;
  if (!uri) throw new Error("set INFINO_URI to your database endpoint: https://<host>/<database>");
  return uri;
}

const question = process.argv.slice(2).join(" ") || "What data do I have, and what stands out in it?";

const analytics = new Analytics({
  infino: {
    uri: requireUri(),
  },
});

const sessionId = analytics.createSession();
console.log(`# session ${sessionId}`);
console.log(`# Q: ${question}\n`);

for await (const event of analytics.ask(question, { sessionId })) {
  switch (event.type) {
    case "progress":
      console.log(`[progress] ${event.text}\n`);
      break;
    case "sql":
      console.log(`[sql] ${event.query}\n`);
      break;
    case "chart": {
      const m = event.result.metadata;
      console.log(
        `[chart] ${event.spec.chart.type} "${event.spec.title}" — ${m.row_count} rows, binding=${JSON.stringify(m.binding)}`,
      );
      if (m.warnings.length) console.log(`[chart warnings] ${JSON.stringify(m.warnings)}`);
      console.log(`[chart rows] ${JSON.stringify(event.result.rows.slice(0, 6))}\n`);
      break;
    }
    case "summary":
      console.log(`[summary] ${event.text}\n`);
      break;
    case "error":
      console.log(`[error] ${event.message}\n`);
      break;
    case "done":
      console.log(`[done] turns=${event.turns} cost=$${event.costUsd?.toFixed(4)} session=${event.sessionId}`);
      break;
  }
}
