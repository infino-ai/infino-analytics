import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSystemPrompt } from "../src/prompt.js";

// One product contract, two harnesses. These assertions exist so a harness
// cannot quietly grow its own copy that drifts.
describe("buildSystemPrompt", () => {
  it("states the create_chart rendering contract in every variant", () => {
    for (const prompt of [buildSystemPrompt(), buildSystemPrompt({ webSearch: true })]) {
      match(prompt, /ONLY what you render through create_chart/);
      match(prompt, /Never fabricate, estimate, or extrapolate/);
      match(prompt, /Never mention internal tool names/);
    }
  });

  it("promises web search only to a harness that has it", () => {
    match(buildSystemPrompt({ webSearch: true }), /use web search to bring it in/);
    ok(!/web search/.test(buildSystemPrompt()));
  });

  it("differs by exactly one bullet", () => {
    const count = (p: string) => p.split("\n").filter((l) => l.startsWith("- ")).length;
    strictEqual(count(buildSystemPrompt({ webSearch: true })), count(buildSystemPrompt()) + 1);
  });

  it("keeps the closing guardrail last, whatever the capabilities", () => {
    for (const prompt of [buildSystemPrompt(), buildSystemPrompt({ webSearch: true })]) {
      const bullets = prompt.split("\n").filter((l) => l.startsWith("- "));
      match(bullets[bullets.length - 1], /Never mention internal tool names/);
    }
  });
});
