import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { FunctionTool } from "openai/resources/responses/responses";

// The data tools, from the published @infino-ai/mcp-server over stdio. This
// package owns the child process itself, so every exit path must close the
// transport or a question leaks a Node process.

export interface McpToolset {
  readonly tools: readonly FunctionTool[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
  /** For tests: proof the child is gone after close(). */
  readonly pid: number | null;
}

export interface McpOptions {
  databaseUri: string;
  apiKey: string;
  /** Test seam: an alternative server entry point. */
  entry?: string;
}

export async function connectInfinoMcp(opts: McpOptions): Promise<McpToolset> {
  const entry = opts.entry ?? createRequire(import.meta.url).resolve("@infino-ai/mcp-server");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    // HOME is merged in by the SDK's default env and matters: the server's
    // local embedder caches its model there.
    env: { INFINO_MCP_URI: opts.databaseUri, INFINO_API_KEY: opts.apiKey },
    stderr: "pipe",
  });
  const client = new Client({ name: "fino-openai", version: "0.0.0" });
  await client.connect(transport);

  try {
    const tools: FunctionTool[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools.map(toFunctionTool));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return {
      tools,
      pid: transport.pid,
      async call(name, args) {
        const result = await client.callTool({ name, arguments: args });
        return { text: flattenContent(result.content), isError: result.isError === true };
      },
      close: () => client.close(),
    };
  } catch (err) {
    await client.close();
    throw err;
  }
}

/** MCP ships plain JSON Schema, so this is nearly a rename. `strict` stays
 * off: MCP schemas omit `additionalProperties: false`, which strict rejects. */
export function toFunctionTool(tool: {
  name: string;
  description?: string;
  title?: string;
  inputSchema: Record<string, unknown>;
}): FunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? tool.title ?? "",
    parameters: stripSchemaMeta(tool.inputSchema),
    strict: false,
  };
}

/** `$schema` is metadata the Responses validator has no use for. */
export function stripSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema, ...rest } = schema;
  return rest;
}

function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string }) =>
      part?.type === "text" ? (part.text ?? "") : `[non-text content: ${part?.type ?? "unknown"}]`,
    )
    .join("\n");
}
