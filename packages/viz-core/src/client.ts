// Minimal REST client for Infino Cloud's per-database SQL endpoint.
// Deliberately tiny: viz execution is a deterministic code path and only
// needs query_sql. Agent-side exploration (schemas, search) goes through
// the published @infino-ai/mcp-server instead.

export interface InfinoConfig {
  /** Hosted endpoint including database: https://<host>/<database> */
  uri: string;
  apiKey?: string;
}

export class InfinoClient {
  private readonly host: string;
  private readonly database: string;
  private readonly apiKey: string;

  constructor(config: InfinoConfig) {
    const url = new URL(config.uri);
    this.host = url.origin;
    this.database = url.pathname.replace(/^\/|\/$/g, "");
    if (!this.database) {
      throw new Error(
        `infino uri must include the database as the path: https://<host>/<database> (got ${config.uri})`,
      );
    }
    const key = config.apiKey ?? process.env.INFINO_API_KEY;
    if (!key) {
      throw new Error("infino apiKey missing (set it in config or INFINO_API_KEY)");
    }
    this.apiKey = key;
  }

  get databaseUri(): string {
    return `${this.host}/${this.database}`;
  }

  async listTables(): Promise<string[]> {
    const res = await fetch(`${this.host}/v1/list_tables/${this.database}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`list_tables failed (${res.status}): ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as string[] | { tables?: string[] };
    return Array.isArray(parsed) ? parsed : (parsed.tables ?? []);
  }

  async querySql(query: string): Promise<Record<string, unknown>[]> {
    const maxRetries = 5;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.host}/v1/query_sql/${this.database}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query }),
      });
      if (res.status === 503 && attempt < maxRetries) {
        const wait = Number(res.headers.get("retry-after")) || 3;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        // Sanitized: status + engine message only, no host echoing.
        throw new Error(`sql failed (${res.status}): ${text.slice(0, 500)}`);
      }
      return JSON.parse(text) as Record<string, unknown>[];
    }
  }
}
