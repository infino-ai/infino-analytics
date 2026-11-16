/** A deployment's guard over the agent's queries: a refusal reason, or nothing to allow. */
export type QueryPolicy = (call: { tool: string; args: Record<string, unknown> }) =>
  | string
  | undefined
  | null
  | Promise<string | undefined | null>;

export const QUERY_POLICY_ENV: "FINO_QUERY_POLICY";

export function policyPath(env?: NodeJS.ProcessEnv): string | undefined;

export function loadQueryPolicy(path?: string): Promise<QueryPolicy | null>;

export function checkQuery(policy: QueryPolicy | null, tool: string, args: unknown): Promise<string | undefined>;

export function refusalText(tool: string, reason: string): string;
