import { test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import { createClaudeHarness, toolPolicy, type AgentConfig, type QueryFn } from "../src/index.js";

const WEB = ["WebSearch", "WebFetch"];

test("web tools are auto-approved by default", () => {
  const { allowedTools, disallowedTools } = toolPolicy({});
  for (const t of WEB) {
    ok(allowedTools.includes(t), `${t} allowed`);
    ok(!disallowedTools.includes(t), `${t} not denied`);
  }
  ok(disallowedTools.includes("Bash"));
});

test("webSearch: false denies the web tools, not just unlists them", () => {
  const { allowedTools, disallowedTools } = toolPolicy({ webSearch: false });
  for (const t of WEB) {
    ok(!allowedTools.includes(t), `${t} not allowed`);
    ok(disallowedTools.includes(t), `${t} denied`);
  }
  ok(disallowedTools.includes("Bash"));
  ok(allowedTools.includes("mcp__infino-engine__*"));
});

/** Runs one question and returns the options the harness passed the SDK. */
async function sdkOptions(config: Partial<AgentConfig>) {
  let seen: { allowedTools?: string[]; disallowedTools?: string[]; systemPrompt?: string } = {};
  const queryFn = ((args: { options: typeof seen }) => {
    seen = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", session_id: "s", result: "", num_turns: 1, total_cost_usd: 0 };
    })();
  }) as unknown as QueryFn;
  const harness = createClaudeHarness({ infino: { uri: "https://example.test/db", apiKey: "test" }, ...config }, queryFn);
  for await (const _ of harness({ question: "q" })) void _;
  return seen;
}

test("the harness hands the SDK the policy and a prompt to match", async () => {
  const on = await sdkOptions({});
  deepStrictEqual(on.allowedTools, toolPolicy({}).allowedTools);
  ok(on.systemPrompt?.includes("web search"));

  const off = await sdkOptions({ webSearch: false });
  deepStrictEqual(off.allowedTools, toolPolicy({ webSearch: false }).allowedTools);
  deepStrictEqual(off.disallowedTools, toolPolicy({ webSearch: false }).disallowedTools);
  ok(!off.systemPrompt?.includes("web search"));
});
