import * as vscode from "vscode";
import { EventEmitter } from "node:events";
import type {
  OpenCodeAgent,
  OpenCodeConfig,
  OpenCodeMcpServer,
  OpenCodeModel,
  OpenCodePlugin,
  OpenCodeProvider,
  OpenCodeSession,
} from "./types";

// Dynamic ESM import types for the opencode SDK (ESM-only package in a CJS host).
type OpencodeClient = any;
type SDK = {
  createOpencode: (options?: any) => Promise<{ client: OpencodeClient; server: { url: string; close(): void } }>;
  createOpencodeClient: (config?: any) => OpencodeClient;
};

/** Find an available TCP port on the loopback interface. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const net = require("node:net");
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// The opencode engine bridge. Uses the official SDK, which spawns a managed
// `opencode serve` child process and returns a client pointed at it. All engine
// calls go through the OpencodeClient (REST + SSE).

interface ServerInstance {
  client: OpencodeClient;
  url: string;
  close(): void;
  directory?: string;
}

export class OpencodeBridge {
  private instance: ServerInstance | undefined;
  private readonly emitter = new EventEmitter();
  private directory: string | undefined;

  get on() {
    return this.emitter.on.bind(this.emitter);
  }
  get off() {
    return this.emitter.off.bind(this.emitter);
  }

  isConnected() {
    return this.instance !== undefined;
  }

  /** Detect whether the opencode CLI is available on PATH. */
  static async detectCli(): Promise<string | undefined> {
    const { execFile } = await import("node:child_process");
    const run = (cmd: string, args: string[]): Promise<string | undefined> =>
      new Promise((resolve) => {
        execFile(cmd, args, (err, stdout) => {
          if (err || !stdout) return resolve(undefined);
          resolve(stdout.trim().split("\n")[0].trim());
        });
      });
    const arg = process.platform === "win32" ? "opencode.exe" : "opencode";
    const which = await run(process.platform === "win32" ? "where.exe" : "which", [arg]);
    if (which) return which;
    // On Windows, opencode may only be installed inside WSL. Detect it there so
    // we don't install a second copy on Windows unnecessarily.
    if (process.platform === "win32") {
      const wsl = await run("wsl.exe", ["--", "sh", "-lc", "command -v opencode"]);
      if (wsl) return wsl;
    }
    return undefined;
  }

  /** Check whether opencode is available inside a WSL distribution (Windows). */
  static async detectWsl(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile("wsl.exe", ["--", "sh", "-lc", "command -v opencode"], (err, stdout) => {
        resolve(!err && !!stdout && stdout.trim().length > 0);
      });
    });
  }

  private startPromise: Promise<void> | undefined;

  /**
   * Make sure the `opencode` binary is resolvable on the process PATH. The SDK
   * spawns a bare `opencode` via cross-spawn; the extension host PATH may miss
   * common locations (/snap/bin, ~/.local/bin, /usr/local/bin, ~/.opencode/bin),
   * which yields `spawn opencode ENOENT`.
   */
  private async ensureOpencodeOnPath(): Promise<void> {
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");

    // 1. Respect an explicit configured command path.
    const configured = vscode.workspace.getConfiguration("llmcode.opencode").get<string>("command", "").trim();
    const candidates: string[] = [];
    if (configured && configured !== "opencode") candidates.push(configured);
    // 2. Detected CLI (already checks PATH + WSL).
    const detected = await OpencodeBridge.detectCli();
    if (detected) candidates.push(detected);
    // 3. Common install locations.
    const home = os.homedir();
    candidates.push(
      "/snap/bin/opencode",
      path.join(home, ".opencode", "bin", "opencode"),
      path.join(home, ".local", "bin", "opencode"),
      path.join(home, ".bun", "bin", "opencode"),
      "/usr/local/bin/opencode",
      "/usr/bin/opencode",
    );

    const existing = candidates.find((c) => {
      try {
        return c && fs.existsSync(c);
      } catch {
        return false;
      }
    });
    if (existing) {
      const dir = path.dirname(existing);
      const parts = (process.env.PATH ?? "").split(path.delimiter);
      if (!parts.includes(dir)) {
        process.env.PATH = [dir, ...parts].join(path.delimiter);
      }
    }
  }

  /** Start the engine (idempotent). Resolves once the client is ready. */
  start(directory?: string): Promise<void> {
    if (this.instance) return Promise.resolve();
    if (!this.startPromise) {
      this.startPromise = this.doStart(directory).catch((err) => {
        this.startPromise = undefined;
        throw err;
      });
    }
    return this.startPromise;
  }

  private async doStart(directory?: string): Promise<void> {
    this.directory = directory ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const cfg = vscode.workspace.getConfiguration("llmcode.opencode");
    const configuredPort = cfg.get<number>("port", 0);
    const hostname = cfg.get<string>("hostname", "127.0.0.1");

    // The SDK spawns a bare `opencode` command via cross-spawn, resolving it
    // from process.env.PATH. The VS Code extension host often lacks the shell's
    // PATH entries (e.g. /snap/bin), causing `spawn opencode ENOENT`. Resolve the
    // binary now and add its directory to PATH so the spawn succeeds.
    await this.ensureOpencodeOnPath();

    const sdk: SDK = (await import("@opencode-ai/sdk")) as any;

    // Try the configured/free port, then fall back to other free ports. A stale
    // `opencode serve` from a previous session can occupy 4096, which makes the
    // spawned server exit with code 1 (ServeError). Picking a free port avoids it.
    const candidates = configuredPort > 0 ? [configuredPort] : [4096, 0];
    let lastErr: unknown;
    for (const port of candidates) {
      const tryPort = port === 0 ? await findFreePort() : port;
      try {
        const created = await sdk.createOpencode({ hostname, port: tryPort, config: {} });
        this.instance = { client: created.client, url: created.server.url, close: created.server.close };
        await this.subscribeEvents();
        void this.warmup();
        this.emitter.emit("status", { state: "idle" } as any);
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`[llmcode] opencode serve failed on port ${tryPort}:`, (err as Error).message);
      }
    }
    throw lastErr ?? new Error("failed to start opencode engine");
  }

  private async warmup() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await this.call((c) => c.app.agents({ query: { directory: this.directory } }));
        if ((res.data ?? []).length > 0) return;
      } catch {
        // ignore and retry
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Subscribe to engine events and re-emit them for the extension host.
   *  Reconnects automatically if the stream ends (e.g. after a restart). */
  private async subscribeEvents() {
    if (!this.instance) return;
    const currentUrl = this.instance.url;
    void (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const instance = this.instance;
          if (!instance || instance.url !== currentUrl) return; // instance was replaced
          const result: any = await instance.client.global.event();
          const stream = result?.stream ?? result;
          for await (const event of stream) {
            this.emitter.emit("event", event?.data ?? event);
          }
        } catch (err) {
          console.warn("[llmcode] event stream ended, will reconnect:", (err as Error).message);
        }
        // Wait before reconnecting; stop if the instance was replaced or disposed.
        await new Promise((r) => setTimeout(r, 1500));
        if (!this.instance || this.instance.url !== currentUrl) return;
      }
    })();
  }

  private async client(): Promise<OpencodeClient> {
    if (!this.instance) await this.start();
    if (!this.instance) throw new Error("opencode engine is not running");
    return this.instance.client;
  }

  /** True when an error means the managed server process is gone/unreachable. */
  private static isConnectionError(err: unknown): boolean {
    const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
    const cause = String((err as any)?.cause?.code ?? "").toLowerCase();
    return (
      msg.includes("fetch failed") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("socket hang up") ||
      msg.includes("network") ||
      cause.includes("econnrefused") ||
      cause.includes("econnreset")
    );
  }

  /** Tear down a dead instance so the next call restarts the engine. */
  private async resetInstance() {
    if (this.instance) {
      try {
        this.instance.close();
      } catch {
        // ignore
      }
    }
    this.instance = undefined;
    this.startPromise = undefined;
  }

  /**
   * Run an engine call, transparently recovering from a dead `opencode serve`
   * process (the common "fetch failed" error). On a connection error the engine
   * is restarted once and the call is retried, so the user never has to reload
   * the window.
   */
  private async call<T = any>(fn: (client: OpencodeClient) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.client());
    } catch (err) {
      if (!OpencodeBridge.isConnectionError(err)) throw err;
      console.warn("[llmcode] engine unreachable, restarting:", (err as Error).message);
      this.emitter.emit("status", { state: "connecting" } as any);
      await this.resetInstance();
      const client = await this.client();
      this.emitter.emit("status", { state: "idle" } as any);
      return await fn(client);
    }
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    const res = await this.call((c) => c.session.list({ query: { directory: this.directory } }));
    const sessions = res.data ?? [];
    return sessions.map((s: any) => ({
      id: s.id,
      title: s.title,
      createdAt: s.time.created,
      updatedAt: s.time.updated,
      archived: false,
    }));
  }

  async createSession(title?: string): Promise<OpenCodeSession> {
    const res = await this.call((c) => c.session.create({ query: { directory: this.directory }, body: { title } }));
    const s = res.data!;
    return { id: s.id, title: s.title, createdAt: s.time.created, updatedAt: s.time.updated, archived: false };
  }

  async deleteSession(id: string): Promise<void> {
    await this.call((c) => c.session.delete({ path: { id }, query: { directory: this.directory } }));
  }

  async forkSession(id: string): Promise<OpenCodeSession> {
    const res = await this.call((c) => c.session.fork({ path: { id }, query: { directory: this.directory } }));
    const s = res.data as any;
    return { id: s.id, title: s.title, createdAt: s.time?.created ?? Date.now(), updatedAt: s.time?.updated ?? Date.now(), archived: false };
  }

  async updateSession(id: string, title: string): Promise<void> {
    await this.call((c) => c.session.update({ path: { id }, query: { directory: this.directory }, body: { title } }));
  }

  async listMessages(id: string) {
    const res = await this.call((c) => c.session.messages({ path: { id }, query: { directory: this.directory } }));
    return res.data ?? [];
  }

  /** Send a prompt to a session; returns the full response. */
  async prompt(id: string, text: string, opts?: { agent?: string; model?: string; system?: string; noTools?: boolean }): Promise<any> {
    const body: any = {
      parts: [{ type: "text", text }],
    };
    if (opts?.agent) body.agent = opts.agent;
    if (opts?.model) {
      const [providerID, modelID] = opts.model.split("/");
      body.model = { providerID, modelID };
    }
    if (opts?.system) body.system = opts.system;
    if (opts?.noTools) body.tools = {};
    const res = await this.call((c) => c.session.prompt({ path: { id }, query: { directory: this.directory }, body }));
    return res.data;
  }

  async abort(id: string) {
    await this.call((c) => c.session.abort({ path: { id }, query: { directory: this.directory } }));
  }

  /**
   * Send a prompt and deliver the assistant text through the callback.
   *
   * The v1 engine's global event stream does not reliably emit
   * `message.part.updated` deltas to SDK clients, so we use the synchronous
   * `session.prompt` (which returns the full assistant message) and deliver the
   * text in ordered chunks. This guarantees the native chat UI receives the
   * complete response from opencode.
   */
  async promptStream(
    id: string,
    text: string,
    opts: { agent?: string; model?: string; system?: string; onDelta: (t: string) => void; signal?: { readonly isCancellationRequested: boolean } },
  ): Promise<string> {
    const body: any = { parts: [{ type: "text", text }] };
    if (opts.agent) body.agent = opts.agent;
    if (opts.model) {
      const [providerID, modelID] = opts.model.split("/");
      body.model = { providerID, modelID };
    }
    if (opts.system) body.system = opts.system;

    const query = { directory: this.directory };

    // Fire the prompt without blocking, then poll the session: while it is busy
    // the UI shows a live working state; assistant text is emitted as it grows.
    await this.call((c) => c.session.promptAsync({ path: { id }, query, body }));

    let emitted = "";
    const deadline = Date.now() + 15 * 60 * 1000;
    let sawBusy = false;
    while (Date.now() < deadline) {
      if (opts.signal?.isCancellationRequested) {
        await this.call((c) => c.session.abort({ path: { id }, query })).catch(() => undefined);
        break;
      }
      await new Promise((r) => setTimeout(r, 350));

      const assistantText = await this.readAssistantText(id);
      if (assistantText.length > emitted.length) {
        const delta = assistantText.slice(emitted.length);
        emitted = assistantText;
        opts.onDelta(delta);
      }

      const status = await this.client()
        .then((c) => c.session.status?.({ path: { id }, query }))
        .then((r: any) => r?.data?.[id]?.type)
        .catch(() => undefined);
      if (status === "busy") {
        sawBusy = true;
      } else if (status === "idle" || (sawBusy && status === undefined && emitted.length > 0)) {
        // One final read to capture anything written right at completion.
        const finalText = await this.readAssistantText(id);
        if (finalText.length > emitted.length) {
          opts.onDelta(finalText.slice(emitted.length));
          emitted = finalText;
        }
        break;
      }
    }
    return emitted;
  }

  /** Read the concatenated assistant text for a session from its messages. */
  private async readAssistantText(id: string): Promise<string> {
    const res = await this.call((c) => c.session.messages({ path: { id }, query: { directory: this.directory } }));
    const messages = (res.data ?? []) as any[];
    let text = "";
    for (const m of messages) {
      if (m?.info?.role !== "assistant") continue;
      for (const p of m.parts ?? []) {
        if (p.type === "text" && typeof p.text === "string") text += p.text;
      }
    }
    return text;
  }

  async listProviders(): Promise<OpenCodeProvider[]> {
    const res = await this.call((c) => c.config.providers({ query: { directory: this.directory } }));
    const payload = res.data as any;
    const providers = payload?.providers ?? [];
    return providers.map((p: any) => ({
      id: p.id,
      name: p.name,
      models: p.models ?? {},
      options: p.options ?? {},
    }));
  }

  async listModels(): Promise<OpenCodeModel[]> {
    const providers = await this.listProviders();
    const models: OpenCodeModel[] = [];
    for (const p of providers) {
      for (const [mid, m] of Object.entries(p.models as Record<string, any>)) {
        models.push({
          id: `${p.id}/${mid}`,
          name: m.name ?? mid,
          providerID: p.id,
          limit: m.limit ?? undefined,
          capabilities: m.capabilities
            ? { toolcall: m.capabilities.toolcall, reasoning: m.capabilities.reasoning, attachment: m.capabilities.attachment }
            : undefined,
        });
      }
    }
    return models;
  }

  async listAgents(): Promise<OpenCodeAgent[]> {
    const res = await this.call((c) => c.app.agents({ query: { directory: this.directory } }));
    const agents = res.data ?? [];
    return agents.map((a: any) => ({
      name: a.name,
      mode: a.mode as OpenCodeAgent["mode"],
      description: a.description,
      model: a.model ? `${a.model.providerID}/${a.model.modelID}` : undefined,
      prompt: a.prompt,
    }));
  }

  async listSkills(): Promise<{ name: string; description?: string }[]> {
    const res = await this.call((c) => c.command.list({ query: { directory: this.directory } }));
    const commands = res.data ?? [];
    return commands.map((c: any) => ({ name: c.name ?? c.title, description: c.description }));
  }

  async listCommands() {
    const res = await this.call((c) => c.command.list({ query: { directory: this.directory } }));
    return res.data ?? [];
  }

  async listMcp(): Promise<OpenCodeMcpServer[]> {
    const res = await this.call((c) => c.mcp.status({ query: { directory: this.directory } }));
    const statuses = res.data ?? {};
    return Object.entries(statuses).map(([id, s]: [string, any]) => ({
      id,
      type: "local",
      enabled: s.status !== "disabled",
      status: s.status === "connected" ? "connected" : s.status === "disabled" ? "disabled" : "disconnected",
    }));
  }

  async connectMcp(name: string) {
    await this.call((c) => c.mcp.connect({ path: { name }, query: { directory: this.directory } }));
  }

  async disconnectMcp(name: string) {
    await this.call((c) => c.mcp.disconnect({ path: { name }, query: { directory: this.directory } }));
  }

  async listPlugins(): Promise<OpenCodePlugin[]> {
    return [];
  }

  async getConfig(): Promise<OpenCodeConfig> {
    const res = await this.call((c) => c.config.get({ query: { directory: this.directory } }));
    return (res.data ?? {}) as OpenCodeConfig;
  }

  async updateConfig(config: OpenCodeConfig): Promise<void> {
    await this.call((c) => c.config.update({ query: { directory: this.directory }, body: config as any }));
  }

  /**
   * Raw text generation for autocomplete/inline edits. The v1 engine has no
   * dedicated generate endpoint, so we run a throwaway session prompt and
   * read back the concatenated text parts.
   */
  // A long-lived session reused for autocomplete/inline generation so repeated
  // prompts stay "warm" (the first cold prompt is several times slower).
  /**
   * One-shot text generation for autocomplete/inline edits.
   *
   * Each call uses a FRESH session so no conversation history bleeds between
   * unrelated completions (a shared session made the model "continue" previous
   * prompts, producing off-topic answers). The engine keeps the provider warm,
   * so fresh sessions are still fast after the first call.
   */
  // A warm session reused for autocomplete so the model stays hot (first call
  // is slow, subsequent ~1-2s). Reset when the model changes or on error.
  private genSessionId: string | undefined;
  private genSessionModel: string | undefined;

  async generateText(
    prompt: string,
    model?: string,
    system?: string,
    opts?: { noTools?: boolean; agent?: string; warm?: boolean },
  ): Promise<{ text: string; model?: string }> {
    const warm = opts?.warm === true;
    let sessionId: string | undefined;
    let temporary = false;
    if (warm) {
      if (this.genSessionId && this.genSessionModel !== (model ?? "")) {
        const old = this.genSessionId;
        this.genSessionId = undefined;
        void this.deleteSession(old).catch(() => undefined);
      }
      if (!this.genSessionId) {
        this.genSessionId = (await this.createSession("_generate")).id;
        this.genSessionModel = model ?? "";
      }
      sessionId = this.genSessionId;
    } else {
      sessionId = (await this.createSession("_generate")).id;
      temporary = true;
    }
    try {
      const res: any = await this.prompt(sessionId, prompt, {
        model,
        system,
        noTools: opts?.noTools,
        agent: opts?.agent,
      });
      const parts = res?.parts ?? [];
      const text = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("");
      const info = res?.info;
      const actualModel =
        info?.providerID && info?.modelID ? `${info.providerID}/${info.modelID}` : undefined;
      return { text, model: actualModel };
    } catch (err) {
      // Drop the warm session on failure so the next call recreates it.
      if (warm) {
        const old = this.genSessionId;
        this.genSessionId = undefined;
        if (old) void this.deleteSession(old).catch(() => undefined);
      }
      throw err;
    } finally {
      if (temporary) await this.deleteSession(sessionId).catch(() => undefined);
    }
  }

  async dispose() {
    if (this.instance) {
      this.instance.close();
      this.instance = undefined;
    }
    this.genSessionId = undefined;
  }
}
