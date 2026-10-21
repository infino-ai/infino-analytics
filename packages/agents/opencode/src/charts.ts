import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CREATE_CHART_DESCRIPTION,
  CREATE_CHART_INPUT,
  runCreateChart,
  type ChatEvent,
  type InfinoClient,
} from "@infino-ai/analytics-core";

// The chart contract, served to opencode as a remote MCP tool. opencode runs
// tools in its own process, so create_chart cannot close over a run's event
// queue the way an in-process tool does. Instead the tool runs here and parks
// the UI-bound events (full result rows) in a ledger keyed by the receipt it
// returns. opencode hands that receipt back verbatim as the tool part's
// output, which is how the run claims its events; the rows still bypass model
// context. Nothing opaque goes into the receipt, because opencode forwards no
// MCP side channel and a model repeats whatever ids it is shown.

/** Unclaimed entries (an aborted run, a timed-out call) are dropped after
 * this long. */
const LEDGER_TTL_MS = 10 * 60_000;
const MAX_BODY_BYTES = 1_000_000;
// opencode replaces any tool output over 51,200 bytes with a truncation note,
// and a receipt it replaced could never be matched to its chart. The cap
// leaves room under that limit.
const RECEIPT_MAX_BYTES = 40_000;
const CELL_MAX_CHARS = 200;

export class ChartLedger {
  // A queue per receipt: identical receipts (same title, type, SQL and
  // result) carry identical events, so which one a run claims does not matter.
  private readonly entries = new Map<string, { events: ChatEvent[]; at: number }[]>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly ttlMs = LEDGER_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    // Expiry also runs on a timer, so a quiet server does not hold an
    // abandoned chart's rows until the next chart comes along.
    this.sweeper = setInterval(() => this.sweep(), ttlMs);
    this.sweeper.unref();
  }

  park(receipt: string, events: ChatEvent[]): void {
    this.sweep();
    if (events.length === 0) return;
    this.entries.set(receipt, [...(this.entries.get(receipt) ?? []), { events, at: this.now() }]);
  }

  /** The events parked under a create_chart output; empty when nothing
   * matches, they expired, or they were already claimed. */
  claim(toolOutput: string | undefined): ChatEvent[] {
    this.sweep();
    if (!toolOutput) return [];
    const queue = this.entries.get(toolOutput);
    const entry = queue?.shift();
    if (queue?.length === 0) this.entries.delete(toolOutput);
    return entry?.events ?? [];
  }

  close(): void {
    clearInterval(this.sweeper);
    this.entries.clear();
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, queue] of this.entries) {
      const live = queue.filter((e) => e.at > cutoff);
      if (live.length) this.entries.set(key, live);
      else this.entries.delete(key);
    }
  }
}

/** Shrinks a receipt to fit RECEIPT_MAX_BYTES: long cell values are cut
 * first, then sample rows dropped from the end. Either cut is stated in the
 * receipt, so the model never mistakes a trimmed sample for the data. */
export function fitReceipt(receipt: Record<string, unknown>): string {
  const fits = (r: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(r)) <= RECEIPT_MAX_BYTES;
  if (fits(receipt)) return JSON.stringify(receipt);

  const rows = Array.isArray(receipt.sample_rows) ? (receipt.sample_rows as Record<string, unknown>[]) : [];
  const shortened = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => {
        const text = typeof v === "string" ? v : JSON.stringify(v) ?? "";
        return [k, text.length > CELL_MAX_CHARS ? `${text.slice(0, CELL_MAX_CHARS)}…` : v];
      }),
    ),
  );
  const trimmed: Record<string, unknown> = {
    ...receipt,
    sample_rows: shortened,
    sample_note: `cell values over ${CELL_MAX_CHARS} characters are cut short to keep this receipt small`,
  };
  while (!fits(trimmed) && (trimmed.sample_rows as unknown[]).length > 0) {
    (trimmed.sample_rows as unknown[]).pop();
    trimmed.sample_note = `sample cut to ${(trimmed.sample_rows as unknown[]).length} rows, with long values shortened, to keep this receipt small`;
  }
  return JSON.stringify(trimmed);
}

export interface ChartServer {
  /** Includes a per-process secret path: the tool runs SQL with this
   * server's Infino key, so other local processes must not reach it. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startChartServer(client: InfinoClient, ledger: ChartLedger): Promise<ChartServer> {
  const path = `/mcp/${randomBytes(16).toString("hex")}`;

  const http = createServer(async (req, res) => {
    if (req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readJson(req);
      if (body === TOO_LARGE) {
        res.writeHead(413).end();
        return;
      }
      // Stateless: one server per request, so concurrent runs share nothing.
      const server = buildServer(client, ledger);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(err instanceof SyntaxError ? 400 : 500).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}

function buildServer(client: InfinoClient, ledger: ChartLedger): McpServer {
  const server = new McpServer({ name: "fino", version: "0.0.0" });
  server.registerTool(
    "create_chart",
    {
      description: CREATE_CHART_DESCRIPTION,
      inputSchema: CREATE_CHART_INPUT,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const events: ChatEvent[] = [];
      const outcome = await runCreateChart(client, args, (e) => events.push(e));
      // Title and type lead the receipt so it identifies this chart, not just
      // its query, among charts parked by concurrent runs.
      const chart = { title: args.title, type: args.chart_type };
      const receipt = outcome.ok
        ? fitReceipt({ chart, ...JSON.parse(outcome.receipt) })
        : fitReceipt({ chart, error: outcome.error });
      ledger.park(receipt, events);
      return { content: [{ type: "text" as const, text: receipt }], isError: !outcome.ok };
    },
  );
  return server;
}

const TOO_LARGE = Symbol("too large");

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // An oversized body is drained and discarded, so the 413 still reaches
    // the client instead of a reset connection.
    let raw = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooLarge = true;
        raw = "";
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        resolve(TOO_LARGE);
        return;
      }
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
