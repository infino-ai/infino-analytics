import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createOpencodeClient, type Config, type Event } from "@opencode-ai/sdk/v2";
import type { ChatEvent, InfinoClient } from "@infino-ai/analytics-core";
import { ChartLedger, startChartServer } from "./charts.js";

// The opencode server, owned by this package: the pinned binary from npm,
// spawned once per harness and shared by every run (it boots in seconds, and a
// session is cheap). Everything the agent can reach is set here, in config
// passed on the command line, never read from the host.

const AGENT = "fino";
const INFINO_MCP = "infino-engine";
const CHART_MCP = "fino";

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

const BOOT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** What a run needs from opencode. The conformance suite swaps in a scripted
 * one; production gets startOpencode(). */
export interface OpencodeBackend {
  readonly mcpServers: readonly string[];
  createSession(): Promise<string>;
  /** False only when opencode no longer knows the session; other failures
   * throw, so an outage never masquerades as a lost conversation. */
  hasSession(sessionId: string): Promise<boolean>;
  /** True while a prompt is still running in the session. */
  isBusy(sessionId: string): Promise<boolean>;
  /** Resolves once the stream is connected, so a prompt sent after it cannot
   * outrun the subscription. */
  subscribe(signal: AbortSignal): Promise<AsyncIterable<Event>>;
  prompt(sessionId: string, text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  claimChart(output: string | undefined): ChatEvent[];
}

export interface StartOptions {
  infino: InfinoClient;
  infinoApiKey: string;
  /** "<provider>/<model>", as opencode names it. */
  model: string;
  systemPrompt: string;
  maxSteps: number;
  /** opencode applies this to every MCP request, tool calls included, so it
   * caps the slowest query a tool can run. */
  mcpTimeoutMs: number;
  /** Where sessions persist. Resume works only while this survives. */
  dataDir: string;
  /** Explicit binary path; defaults to the one npm installed for this platform. */
  binary?: string;
}

export interface OpencodeServer {
  backend: OpencodeBackend;
  /** False once the child has exited; the harness then boots a new one. */
  alive(): boolean;
  close(): Promise<void>;
}

export async function startOpencode(opts: StartOptions): Promise<OpencodeServer> {
  // Resolved before anything is started, so a missing install fails with
  // nothing to clean up.
  const binary = opts.binary ?? resolveBinary();
  const infinoMcpEntry = createRequire(import.meta.url).resolve("@infino-ai/mcp-server");
  const dataDir = resolve(opts.dataDir);
  const workdir = join(dataDir, "workspace");
  mkdirSync(workdir, { recursive: true });
  // An empty config home, so the host user's opencode config never loads;
  // the OPENCODE_DISABLE_* switches below cover what it does not. It lives in
  // the data directory and is emptied at each boot, so a shutdown that skips
  // cleanup (a supervisor's SIGKILL) leaves nothing behind elsewhere.
  const configHome = join(dataDir, "config");
  rmSync(configHome, { recursive: true, force: true });
  mkdirSync(configHome, { recursive: true });

  let child: ChildProcess | undefined;
  let closeCharts: (() => Promise<void>) | undefined;

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
    unhook();
    const running = child && isRunning() ? child : undefined;
    release();
    // A wedged server that ignores SIGTERM does not get to outlive us.
    if (running) {
      const exited = new Promise<void>((done) => {
        running.once("exit", () => done());
        if (running.exitCode !== null || running.signalCode !== null) done();
      });
      const timer = setTimeout(() => running.kill("SIGKILL"), KILL_GRACE_MS);
      await exited;
      clearTimeout(timer);
    }
    await closeCharts?.();
  };

  try {
    const ledger = new ChartLedger();
    const charts = await startChartServer(opts.infino, ledger);
    closeCharts = charts.close;

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
          maxSteps: opts.maxSteps,
        },
      },
      mcp: {
        [INFINO_MCP]: {
          type: "local",
          command: [process.execPath, infinoMcpEntry],
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
        // Provider credentials come from the environment; HOME and XDG are
        // redirected so nothing else does.
        ...process.env,
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
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const baseUrl = await waitForListen(child);
    const client = createOpencodeClient({ baseUrl, directory: workdir });
    await assertToolSurface(client);

    const [providerID, ...modelPath] = opts.model.split("/");
    const backend: OpencodeBackend = {
      mcpServers: [INFINO_MCP, CHART_MCP],
      async createSession() {
        const res = await client.session.create({ title: "fino" }, { throwOnError: true });
        return res.data.id;
      },
      async hasSession(sessionId) {
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
        // The connection outlives this call; only connecting is time-boxed.
        const connection = new AbortController();
        const stop = () => connection.abort();
        signal.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(stop, CONNECT_TIMEOUT_MS);
        const sub = await client.event.subscribe(undefined, { signal: connection.signal });
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
      async prompt(sessionId, text) {
        await client.session.promptAsync(
          { sessionID: sessionId, agent: AGENT, model: { providerID, modelID: modelPath.join("/") }, parts: [{ type: "text", text }] },
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

/** The platform binary that the opencode-ai package installs as an optional
 * dependency. Its own bin/ entry is a launcher, not the server. */
function resolveBinary(): string {
  const require = createRequire(import.meta.url);
  const base = `opencode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
  for (const variant of ["", "-baseline", "-musl", "-baseline-musl"]) {
    try {
      const path = join(dirname(require.resolve(`${base}${variant}/package.json`)), "bin", exe);
      if (existsSync(path)) return path;
    } catch {
      // Not installed for this variant; try the next.
    }
  }
  throw new Error(`no opencode binary installed for ${process.platform}-${process.arch}; run npm install`);
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

function waitForListen(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    // Only the tail is kept for the error message; the pipes stay drained
    // after boot so a chatty server never blocks on a full buffer.
    let output = "";
    let listening = false;
    const record = (chunk: unknown) => {
      if (!listening) output = (output + String(chunk)).slice(-4000);
    };
    const fail = (why: string) => {
      clearTimeout(timer);
      reject(new Error(`opencode server ${why}${output.trim() ? `\n${output.trim().slice(-2000)}` : ""}`));
    };
    const timer = setTimeout(() => fail(`did not start within ${BOOT_TIMEOUT_MS} ms`), BOOT_TIMEOUT_MS);
    child.stderr?.on("data", record);
    child.stdout?.on("data", (chunk) => {
      record(chunk);
      const match = !listening && output.match(/listening on\s+(https?:\/\/\S+)/);
      if (match) {
        listening = true;
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    child.once("error", (err) => fail(`failed to spawn: ${err.message}`));
    child.once("exit", (code) => fail(`exited with code ${code}`));
  });
}
