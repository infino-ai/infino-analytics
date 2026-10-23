import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createOpencodeClient, type Config, type Event } from "@opencode-ai/sdk/v2";
import { MCP_READONLY_PROXY, type ChatEvent, type InfinoClient } from "@infino-ai/analytics-core";
import { ChartLedger, startChartServer } from "./charts.js";

// The opencode server, owned by this package: the pinned binary from npm,
// spawned once per harness and shared by every run (it boots in seconds, and a
// session is cheap). Everything the agent can reach is set here, in config
// passed on the command line; the host's opencode config and OPENCODE_*
// variables never reach it.

const AGENT = "fino";
const INFINO_MCP = "infino-engine";
const CHART_MCP = "fino";
const MCP_SERVERS = [INFINO_MCP, CHART_MCP];
const SERVER_USER = "fino";

// opencode's built-in tools, exactly as the pinned version reports them, all
// switched off. They act on the machine running this server, whose
// environment holds the Infino and model keys, so a prompt-injected command
// could read them. The agent's whole surface is the two MCP servers above.
// assertToolSurface keeps this list honest across upgrades.
const BUILTIN_TOOLS = [
  "apply_patch",
  "bash",
  "edit",
  "glob",
  "grep",
  "invalid",
  "question",
  "read",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
];

/** Startup and shutdown limits; tests shorten them. */
export interface ServerTiming {
  bootMs: number;
  connectMs: number;
  killGraceMs: number;
}
const TIMING: ServerTiming = { bootMs: 30_000, connectMs: 10_000, killGraceMs: 5_000 };
const OUTPUT_TAIL_CHARS = 4000;

/** What a run needs from opencode. The conformance suite swaps in a scripted
 * one; production gets startOpencode(). */
export interface OpencodeBackend {
  readonly mcpServers: readonly string[];
  createSession(): Promise<string>;
  /** False only when opencode does not know the session; other failures
   * throw, so an outage never masquerades as a lost conversation. */
  hasSession(sessionId: string): Promise<boolean>;
  /** True while a prompt is still running in the session. */
  isBusy(sessionId: string): Promise<boolean>;
  /** Resolves once the stream is connected, so a prompt sent after it cannot
   * outrun the subscription. The stream ends if the connection drops. */
  subscribe(signal: AbortSignal): Promise<AsyncIterable<Event>>;
  /** Sends the question as the user message `messageId`, so every event of
   * the run can be told apart from a previous run's. */
  prompt(sessionId: string, text: string, messageId: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  claimChart(output: string | undefined): ChatEvent[];
}

export interface StartOptions {
  infino: InfinoClient;
  infinoApiKey: string;
  /** "<provider>/<model>", as opencode names it. */
  model: string;
  systemPrompt: string;
  /** Model calls per question before opencode forces a text-only reply. */
  steps: number;
  /** opencode applies this to every MCP request, tool calls included, so it
   * caps the slowest query a tool can run. */
  mcpTimeoutMs: number;
  /** Where sessions persist. Resume works only while this survives. */
  dataDir: string;
  /** Explicit binary path; defaults to the one npm installed for this platform. */
  binary?: string;
  timing?: Partial<ServerTiming>;
}

export interface OpencodeServer {
  backend: OpencodeBackend;
  /** False once the child has exited; the harness then boots a new one. */
  alive(): boolean;
  close(): Promise<void>;
}

export async function startOpencode(opts: StartOptions): Promise<OpencodeServer> {
  const timing = { ...TIMING, ...opts.timing };
  // Resolved before anything is started, so a missing install fails with
  // nothing to clean up.
  const binary = opts.binary ?? resolveBinary();
  const infinoMcpEntry = createRequire(import.meta.url).resolve("@infino-ai/mcp-server");
  const dataDir = resolve(opts.dataDir);
  const workdir = join(dataDir, "workspace");
  mkdirSync(workdir, { recursive: true });
  // An empty config home, so the host user's opencode config never loads;
  // the OPENCODE_DISABLE_* switches below cover what it does not. It lives in
  // the data directory under a name nothing else uses, and is emptied at each
  // boot, so a shutdown that skips cleanup leaves nothing behind elsewhere.
  const configHome = join(dataDir, "opencode-config-home");
  rmSync(configHome, { recursive: true, force: true });
  mkdirSync(configHome, { recursive: true });
  // opencode's HTTP API can read the config (which holds the Infino key) and
  // open a shell, so it only answers requests carrying this boot's password.
  const password = randomBytes(24).toString("base64url");

  let child: ChildProcess | undefined;
  let closing = false;
  let closeCharts: (() => Promise<void>) | undefined;
  const connections = new Set<AbortController>();
  const output = new OutputTail();

  const isRunning = () => !!child && child.exitCode === null && child.signalCode === null;
  // Synchronous, so it also works from an exit handler.
  const release = () => {
    if (isRunning()) child?.kill();
  };
  // The host's own shutdown logic keeps control: the signal is re-raised only
  // when nothing else listens, restoring Node's default exit.
  const onSignal = (signal: NodeJS.Signals) => {
    release();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const unhook = () => {
    process.off("exit", release);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
  process.once("exit", release);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  const close = async () => {
    closing = true;
    unhook();
    const running = child && isRunning() ? child : undefined;
    release();
    // A wedged server that ignores SIGTERM does not get to outlive us.
    if (running) {
      const exited = new Promise<void>((done) => {
        running.once("exit", () => done());
        if (running.exitCode !== null || running.signalCode !== null) done();
      });
      const timer = setTimeout(() => running.kill("SIGKILL"), timing.killGraceMs);
      await exited;
      clearTimeout(timer);
    }
    await closeCharts?.();
  };

  try {
    const ledger = new ChartLedger();
    const charts = await startChartServer(opts.infino, ledger);
    closeCharts = async () => {
      ledger.close();
      await charts.close();
    };

    const config: Config = {
      model: opts.model,
      autoupdate: false,
      share: "disabled",
      snapshot: false,
      lsp: false,
      formatter: false,
      instructions: [],
      plugin: [],
      tools: Object.fromEntries(BUILTIN_TOOLS.map((t) => [t, false])),
      // Nobody is there to answer a permission prompt, so nothing may ask one.
      // doom_loop is opencode's repeated-identical-call guard: denying it hands
      // the model a refusal to read instead of stalling the run on a question.
      permission: {
        ...Object.fromEntries(BUILTIN_TOOLS.map((t) => [t, "deny" as const])),
        doom_loop: "deny",
        external_directory: "deny",
      },
      agent: {
        [AGENT]: {
          mode: "primary",
          prompt: opts.systemPrompt,
          steps: opts.steps,
        },
      },
      mcp: {
        [INFINO_MCP]: {
          type: "local",
          // Through the read-only filter, which also strips the environment
          // opencode passes down, model keys included, to what the Infino
          // server needs.
          command: [process.execPath, MCP_READONLY_PROXY, infinoMcpEntry],
          environment: { INFINO_MCP_URI: opts.infino.databaseUri, INFINO_API_KEY: opts.infinoApiKey },
          timeout: opts.mcpTimeoutMs,
        },
        [CHART_MCP]: { type: "remote", url: charts.url, oauth: false, timeout: opts.mcpTimeoutMs },
      },
    };

    const port = await freePort();
    child = spawn(binary, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
      cwd: workdir,
      env: {
        // Provider credentials come from the environment. The host's own
        // OPENCODE_* variables do not: they can override permissions, add MCP
        // servers, or switch on experimental behaviour.
        ...withoutOpencodeVars(process.env),
        HOME: join(dataDir, "home"),
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: join(dataDir, "data"),
        XDG_CACHE_HOME: join(dataDir, "cache"),
        XDG_STATE_HOME: join(dataDir, "state"),
        // opencode also looks outside its config home: agent instruction
        // files and .opencode/ directories found by walking up from its
        // working directory, external skills, and its default plugins. These
        // switches turn all of it off.
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_SERVER_USERNAME: SERVER_USER,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const spawned = child;
    spawned.stdout?.on("data", (chunk) => output.add(chunk));
    spawned.stderr?.on("data", (chunk) => output.add(chunk));
    // A crash after boot ends every open run's stream at once, so runs report
    // it instead of waiting out their stall timers.
    spawned.once("exit", (code, signal) => {
      for (const connection of connections) connection.abort();
      if (!closing) {
        console.error(`opencode server exited (${signal ?? `code ${code}`})${output.render()}`);
      }
    });

    const baseUrl = await waitForListen(spawned, output, timing.bootMs);
    const client = createOpencodeClient({
      baseUrl,
      directory: workdir,
      headers: { Authorization: `Basic ${Buffer.from(`${SERVER_USER}:${password}`).toString("base64")}` },
    });
    await assertToolSurface(client);
    await assertMcpConnected(client);

    const [providerID, ...modelPath] = opts.model.split("/");
    const backend: OpencodeBackend = {
      mcpServers: MCP_SERVERS,
      async createSession() {
        const res = await client.session.create({ title: "fino" }, { throwOnError: true });
        return res.data.id;
      },
      async hasSession(sessionId) {
        // A thread started under another harness holds that harness's id,
        // which opencode answers with a 500 rather than a 404.
        if (!sessionId.startsWith("ses_")) return false;
        const res = await client.session.get({ sessionID: sessionId });
        if (res.response?.status === 404) return false;
        if (res.error) throw new Error(`opencode session lookup failed: ${JSON.stringify(res.error).slice(0, 300)}`);
        return true;
      },
      async isBusy(sessionId) {
        const res = await client.session.status(undefined, { throwOnError: true });
        const status = res.data[sessionId];
        return !!status && status.type !== "idle";
      },
      async subscribe(signal) {
        const connection = new AbortController();
        connections.add(connection);
        const stop = () => connection.abort();
        signal.addEventListener("abort", stop, { once: true });
        connection.signal.addEventListener("abort", () => connections.delete(connection), { once: true });
        if (!isRunning()) connection.abort();
        // Only connecting is time-boxed; the connection then lives as long as
        // the run. One attempt: a dropped stream must end the run, because
        // events missed while reconnecting are gone.
        const timer = setTimeout(stop, timing.connectMs);
        const sub = await client.event.subscribe(undefined, { signal: connection.signal, sseMaxRetryAttempts: 1 });
        const events = (sub.stream as AsyncIterable<Event>)[Symbol.asyncIterator]();
        // The SDK opens the connection lazily, on the first read, so a prompt
        // sent before then can outrun it. opencode greets every connection
        // with server.connected; reading up to it makes the subscription live
        // before this returns.
        try {
          for (;;) {
            const next = await events.next();
            if (next.done) throw new Error("opencode event stream did not connect");
            if (next.value.type === "server.connected") break;
          }
        } finally {
          clearTimeout(timer);
        }
        return { [Symbol.asyncIterator]: () => events };
      },
      async prompt(sessionId, text, messageId) {
        await client.session.promptAsync(
          {
            sessionID: sessionId,
            messageID: messageId,
            agent: AGENT,
            model: { providerID, modelID: modelPath.join("/") },
            parts: [{ type: "text", text }],
          },
          { throwOnError: true },
        );
      },
      async abort(sessionId) {
        await client.session.abort({ sessionID: sessionId }).catch(() => {});
      },
      claimChart: (output) => ledger.claim(output),
    };
    return { backend, alive: isRunning, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Fails closed when opencode registers a built-in this file does not know:
 * an upgrade that adds a tool must not silently hand it to the agent. */
async function assertToolSurface(client: ReturnType<typeof createOpencodeClient>): Promise<void> {
  const res = await client.tool.ids(undefined, { throwOnError: true });
  const unknown = (res.data as string[]).filter((id) => !BUILTIN_TOOLS.includes(id));
  if (unknown.length > 0) {
    throw new Error(`opencode exposes built-in tools this harness does not disable: ${unknown.join(", ")}`);
  }
}

/** An agent without its MCP servers would answer with no data tools at all,
 * so a server that failed to start fails the boot instead. */
async function assertMcpConnected(client: ReturnType<typeof createOpencodeClient>): Promise<void> {
  const res = await client.mcp.status(undefined, { throwOnError: true });
  const statuses = res.data as Record<string, { status?: string; error?: string }>;
  const down = MCP_SERVERS.filter((name) => statuses[name]?.status !== "connected");
  if (down.length > 0) {
    const detail = down.map((name) => `${name}: ${statuses[name]?.status ?? "missing"}${statuses[name]?.error ? ` (${statuses[name].error})` : ""}`);
    throw new Error(`opencode MCP servers did not connect: ${detail.join("; ")}`);
  }
}

function withoutOpencodeVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("OPENCODE_")));
}

/** The opencode binary for this machine. opencode-ai's postinstall hard-links
 * bin/opencode.exe to the variant it verified runs here (glibc or musl, AVX2
 * or baseline), so that one comes first; the variant packages are the
 * fallback for an install that skipped scripts. */
function resolveBinary(): string {
  const require = createRequire(import.meta.url);
  const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
  const candidates: string[] = [];
  try {
    candidates.push(join(dirname(require.resolve("opencode-ai/package.json")), "bin", "opencode.exe"));
  } catch {
    // opencode-ai is a dependency of this package; its absence surfaces below.
  }
  const base = `opencode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  for (const variant of ["", "-baseline", "-musl", "-baseline-musl"]) {
    try {
      candidates.push(join(dirname(require.resolve(`${base}${variant}/package.json`)), "bin", exe));
    } catch {
      // Not installed for this variant.
    }
  }
  // npm installs every variant for the platform, so presence proves nothing;
  // the binary has to run.
  const runs = candidates.find((path) => spawnSync(path, ["--version"], { timeout: 10_000 }).status === 0);
  if (!runs) throw new Error(`no working opencode binary installed for ${process.platform}-${process.arch}; run npm install`);
  return runs;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

/** The last few thousand characters the server printed, for error messages.
 * Reading every chunk keeps the pipes drained, so a chatty server never
 * blocks on a full buffer. */
class OutputTail {
  private text = "";

  add(chunk: unknown): void {
    this.text = (this.text + String(chunk)).slice(-OUTPUT_TAIL_CHARS);
  }

  contains(pattern: RegExp): RegExpMatchArray | null {
    return this.text.match(pattern);
  }

  render(): string {
    const tail = this.text.trim();
    return tail ? `\n${tail.slice(-2000)}` : "";
  }
}

function waitForListen(child: ChildProcess, output: OutputTail, bootMs: number): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let settled = false;
    const finish = (err: Error | undefined, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      if (err) reject(err);
      else resolveUrl(url as string);
    };
    const fail = (why: string) => finish(new Error(`opencode server ${why}${output.render()}`));
    const onData = () => {
      const match = output.contains(/listening on\s+(https?:\/\/\S+)/);
      if (match) finish(undefined, match[1]);
    };
    const timer = setTimeout(() => fail(`did not start within ${bootMs} ms`), bootMs);
    child.stdout?.on("data", onData);
    child.once("error", (err) => fail(`failed to spawn: ${err.message}`));
    child.once("exit", (code, signal) => fail(`exited (${signal ?? `code ${code}`})`));
  });
}
