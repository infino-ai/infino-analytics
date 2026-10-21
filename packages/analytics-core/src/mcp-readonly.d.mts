/** The Infino MCP tools an analytics agent may call; every other tool is
 * refused by the read-only filter. */
export const READ_TOOLS: ReadonlySet<string>;

export function serverEnv(env: NodeJS.ProcessEnv): Record<string, string>;

export function screenRequest(
  message: unknown,
): { forward: true } | { forward: false; reply: { jsonrpc: "2.0"; id: unknown; result: unknown } };

export function screenToolList<T extends { tools?: { name: string }[] }>(result: T): T;
