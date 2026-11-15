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
    return new Promise((resolve) => {
      const arg = process.platform === "win32" ? "opencode.exe" : "opencode";
      execFile(process.platform === "win32" ? "where.exe" : "which", [arg], (err, stdout) => {
        if (err || !stdout) return resolve(undefined);
        resolve(stdout.trim().split("\n")[0].trim());
      });
    });
  }

  private startPromise: Promise<void> | undefined;

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
    const port = cfg.get<number>("port", 0);
    const hostname = cfg.get<string>("hostname", "127.0.0.1");

    const sdk: SDK = (await import("@opencode-ai/sdk")) as any;
    const created = await sdk.createOpencode({
      hostname,
      port: port === 0 ? 4096 : port,
      config: {},
    });
    this.instance = { client: created.client, url: created.server.url, close: created.server.close };
    await this.subscribeEvents();
    // Warm up: wait until the engine has loaded its agents so the first UI
    // refresh isn't empty (opencode loads config/agents asynchronously).
    void this.warmup();
    this.emitter.emit("status", { state: "idle" } as any);
  }

  private async warmup() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await (await this.client()).app.agents({ query: { directory: this.directory } });
        if ((res.data ?? []).length > 0) return;
      } catch {
        // ignore and retry
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Subscribe to engine events and re-emit them for the extension host. */
  private async subscribeEvents() {
    if (!this.instance) return;
    void (async () => {
      try {
        const result: any = await this.instance!.client.global.event();
        const stream = result?.stream ?? result;
        for await (const event of stream) {
          this.emitter.emit("event", event?.data ?? event);
        }
      } catch (err) {
        console.warn("[llmcode] event stream ended:", err);
      }
    })();
  }

  private async client(): Promise<OpencodeClient> {
    if (!this.instance) await this.start();
    if (!this.instance) throw new Error("opencode engine is not running");
    return this.instance.client;
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    const res = await (await this.client()).session.list({ query: { directory: this.directory } });
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
    const res = await (await this.client()).session.create({ query: { directory: this.directory }, body: { title } });
    const s = res.data!;
    return { id: s.id, title: s.title, createdAt: s.time.created, updatedAt: s.time.updated, archived: false };
  }

  async deleteSession(id: string): Promise<void> {
    await (await this.client()).session.delete({ path: { id }, query: { directory: this.directory } });
  }

  async forkSession(id: string): Promise<OpenCodeSession> {
    const res = await (await this.client()).session.fork({ path: { id }, query: { directory: this.directory } });
    const s = res.data as any;
    return { id: s.id, title: s.title, createdAt: s.time?.created ?? Date.now(), updatedAt: s.time?.updated ?? Date.now(), archived: false };
  }

  async updateSession(id: string, title: string): Promise<void> {
    await (await this.client()).session.update({ path: { id }, query: { directory: this.directory }, body: { title } });
  }

  async listMessages(id: string) {
    const res = await (await this.client()).session.messages({ path: { id }, query: { directory: this.directory } });
    return res.data ?? [];
  }

  /** Send a prompt to a session; returns the full response. */
  async prompt(id: string, text: string, opts?: { agent?: string; model?: string; system?: string }): Promise<any> {
    const body: any = {
      parts: [{ type: "text", text }],
    };
    if (opts?.agent) body.agent = opts.agent;
    if (opts?.model) {
      const [providerID, modelID] = opts.model.split("/");
      body.model = { providerID, modelID };
    }
    if (opts?.system) body.system = opts.system;
    const res = await (await this.client()).session.prompt({ path: { id }, query: { directory: this.directory }, body });
    return res.data;
  }

  async abort(id: string) {
    await (await this.client()).session.abort({ path: { id }, query: { directory: this.directory } });
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

    const res = await (await this.client()).session.prompt({ path: { id }, query: { directory: this.directory }, body });
    const parts = (res.data?.parts ?? []) as any[];
    const full = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
    // Deliver in chunks so consumers that accumulate deltas see incremental text.
    const CHUNK = 64;
    for (let i = 0; i < full.length; i += CHUNK) {
      if (opts.signal?.isCancellationRequested) break;
      opts.onDelta(full.slice(i, i + CHUNK));
    }
    return full;
  }

  async listProviders(): Promise<OpenCodeProvider[]> {
    const res = await (await this.client()).config.providers({ query: { directory: this.directory } });
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
        models.push({ id: `${p.id}/${mid}`, name: m.name ?? mid, providerID: p.id });
      }
    }
    return models;
  }

  async listAgents(): Promise<OpenCodeAgent[]> {
    const res = await (await this.client()).app.agents({ query: { directory: this.directory } });
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
    const res = await (await this.client()).command.list({ query: { directory: this.directory } });
    const commands = res.data ?? [];
    return commands.map((c: any) => ({ name: c.name ?? c.title, description: c.description }));
  }

  async listCommands() {
    const res = await (await this.client()).command.list({ query: { directory: this.directory } });
    return res.data ?? [];
  }

  async listMcp(): Promise<OpenCodeMcpServer[]> {
    const res = await (await this.client()).mcp.status({ query: { directory: this.directory } });
    const statuses = res.data ?? {};
    return Object.entries(statuses).map(([id, s]: [string, any]) => ({
      id,
      type: "local",
      enabled: s.status !== "disabled",
      status: s.status === "connected" ? "connected" : s.status === "disabled" ? "disabled" : "disconnected",
    }));
  }

  async connectMcp(name: string) {
    await (await this.client()).mcp.connect({ path: { name }, query: { directory: this.directory } });
  }

  async disconnectMcp(name: string) {
    await (await this.client()).mcp.disconnect({ path: { name }, query: { directory: this.directory } });
  }

  async listPlugins(): Promise<OpenCodePlugin[]> {
    return [];
  }

  async getConfig(): Promise<OpenCodeConfig> {
    const res = await (await this.client()).config.get({ query: { directory: this.directory } });
    return (res.data ?? {}) as OpenCodeConfig;
  }

  async updateConfig(config: OpenCodeConfig): Promise<void> {
    await (await this.client()).config.update({ query: { directory: this.directory }, body: config as any });
  }

  /**
   * Raw text generation for autocomplete/inline edits. The v1 engine has no
   * dedicated generate endpoint, so we run a throwaway session prompt and
   * read back the concatenated text parts.
   */
  async generateText(prompt: string, model?: string): Promise<string> {
    const session = await this.createSession("_generate");
    try {
      const res: any = await this.prompt(session.id, prompt, { model });
      const parts = res?.parts ?? [];
      return parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("");
    } finally {
      await this.deleteSession(session.id).catch(() => undefined);
    }
  }

  async dispose() {
    if (this.instance) {
      this.instance.close();
      this.instance = undefined;
    }
  }
}
