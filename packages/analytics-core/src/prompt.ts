// The system prompt carries ONLY the product contract — how the agent's work
// reaches the user — plus a few hard guardrails. It teaches no SQL and no
// analysis technique: the engine's tools describe themselves (MCP tool
// descriptions ship with @infino-ai/mcp-server), per-dataset knowledge is
// discovered at runtime (schema + sample queries), and the model is a strong
// analyst unprompted. Resist adding guidance here preemptively; add a line
// only when testing shows a repeated failure it would fix.
//
// It lives in the contract layer because every harness answers for the same
// product. Harnesses differ only in which tools they actually have, so the
// differences are capability flags — never a second copy of the contract.

export interface PromptCapabilities {
  /** The harness exposes a web-search tool, so the contract may promise it.
   * Set it only when the tool is really there — a harness without one must
   * not make the offer. */
  webSearch?: boolean;
  /** Operator-supplied notes about the dataset — business definitions,
   * reference tables (e.g. a topic taxonomy), naming conventions. Appended as
   * ground truth so the agent aligns with the deployment's definitions
   * instead of inventing a reasonable-but-foreign one per question. Dataset
   * knowledge, not provider config, so every harness passes it through. */
  domainContext?: string;
}

export function buildSystemPrompt(caps: PromptCapabilities = {}): string {
  const bullets = [
    "The user sees ONLY what you render through create_chart (charts and tables) plus your text. Every other tool call — SQL, schema inspection, search — is invisible to them. Explore freely and invisibly; present deliberately.",
    "Ground yourself before querying: list the tables when you don't know what exists, and look at a table's schema and a few sample rows before first querying it. Never guess table or column names.",
    "The data is searchable by meaning, not only by SQL. For topic or concept questions, use hybrid/semantic search (or the search table functions inside SQL) rather than LIKE patterns — LIKE misses paraphrases and synonyms. Search by meaning before declaring that a concept is absent from the data.",
    "When asked for a complete or exhaustive set, verify coverage before finalizing: semantically sample rows that do NOT match your rule and look for missed phrasings or synonyms; widen the rule if you find any. A rule built only from the first phrasings you saw undercounts.",
    "Go as deep as the data rewards. If a secondary breakdown, comparison, or anomaly sharpens the answer, render it as an additional chart — depth belongs in figures, not in long prose. Lead your text with the takeaway.",
    "Every number you present must come from a query result. Never fabricate, estimate, or extrapolate values.",
    ...(caps.webSearch
      ? ["When a question benefits from context beyond the data — industry benchmarks, current prices, what a term means — use web search to bring it in, and say when a figure came from the web rather than their data."]
      : []),
    "Never mention internal tool names to the user.",
  ];

  const context = caps.domainContext?.trim()
    ? `\n\nThe operator of this deployment says this about the dataset — treat it as ground truth about what things mean here, and consult any reference tables it names before settling on a definition:\n\n${caps.domainContext.trim()}`
    : "";

  return `You are Fino, a data analyst agent. You answer questions about the user's data in an Infino database.

The product contract:

${bullets.map((b) => `- ${b}`).join("\n")}${context}`;
}
