// Shared types used across the extension host and webview.

export type AgentMode = "primary" | "subagent" | "all";

export interface OpenCodeAgent {
  name: string;
  mode: AgentMode;
  description?: string;
  model?: string;
  prompt?: string;
}

export interface OpenCodeProvider {
  id: string;
  name?: string;
  models: Record<string, { name?: string; id?: string }>;
  options?: Record<string, unknown>;
}

export interface OpenCodeModel {
  id: string;
  name?: string;
  providerID: string;
}

export interface OpenCodeSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface OpenCodeSkill {
  name: string;
  description?: string;
}

export interface OpenCodeMcpServer {
  id: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  enabled: boolean;
  status?: "connected" | "disconnected" | "disabled";
}

export interface OpenCodePlugin {
  id: string;
  file?: string;
}

export interface OpenCodeConfig {
  model?: string;
  providers?: Record<string, OpenCodeProvider>;
  agents?: Record<string, Partial<OpenCodeAgent>>;
  mcp?: Record<string, OpenCodeMcpServer>;
  [key: string]: unknown;
}

// Messages exchanged between the webview and the extension host.
export type HostToWebview =
  | { type: "ready" }
  | { type: "sessions"; sessions: OpenCodeSession[] }
  | { type: "providers"; providers: OpenCodeProvider[] }
  | { type: "models"; models: OpenCodeModel[] }
  | { type: "agents"; agents: OpenCodeAgent[] }
  | { type: "skills"; skills: OpenCodeSkill[] }
  | { type: "mcp"; servers: OpenCodeMcpServer[] }
  | { type: "plugins"; plugins: OpenCodePlugin[] }
  | { type: "config"; config: OpenCodeConfig }
  | { type: "status"; status: ChatStatus }
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; sessionId: string; text: string }
  | { type: "error"; message: string }
  | { type: "import"; report: ImportReport };

export type WebviewToHost =
  | { type: "init" }
  | { type: "send"; sessionId: string; text: string; agent?: string; model?: string }
  | { type: "newSession" }
  | { type: "switchSession"; sessionId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "forkSession"; sessionId: string }
  | { type: "compactSession"; sessionId: string }
  | { type: "editMessage"; sessionId: string; messageId: string; text: string }
  | { type: "stop"; sessionId?: string }
  | { type: "import" }
  | { type: "refresh"; kind: "sessions" | "providers" | "models" | "agents" | "skills" | "mcp" | "plugins" | "config" };

export interface ChatStatus {
  state: "idle" | "thinking" | "streaming" | "working";
  sessionId?: string;
  tokensPerSecond?: number;
  label?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  parts: ChatPart[];
  createdAt: number;
}

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; status: "running" | "done" | "error" };

export interface ImportReport {
  skills: { total: number; imported: number; skipped: number };
  mcp: { total: number; imported: number; skipped: number };
  plugins: { total: number; imported: number; skipped: number };
  errors: string[];
}
