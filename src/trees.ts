import * as vscode from "vscode";
import type { OpencodeBridge } from "./opencode";

// Tree views for sessions, providers, agents, skills, MCP servers, plugins.

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionNode> {
  private onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  constructor(private readonly bridge: OpencodeBridge) {}
  refresh() {
    this.onDidChangeTreeDataEmitter.fire();
  }
  getTreeItem(node: SessionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label ?? node.sessionId, vscode.TreeItemCollapsibleState.None);
    item.id = node.sessionId;
    item.iconPath = new vscode.ThemeIcon("comment-discussion");
    item.contextValue = "session";
    return item;
  }
  async getChildren(): Promise<SessionNode[]> {
    try {
      const sessions = await this.bridge.listSessions();
      return sessions.map((s) => new SessionNode(s.title || s.id, s.id));
    } catch {
      return [];
    }
  }
}

export class SessionNode extends vscode.TreeItem {
  constructor(label: string, public readonly sessionId: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

export class GenericTreeProvider<T> implements vscode.TreeDataProvider<GenericNode> {
  private onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  constructor(
    private readonly id: string,
    private readonly label: string,
    private readonly load: () => Promise<GenericNode[]>,
  ) {}
  refresh() {
    this.onDidChangeTreeDataEmitter.fire();
  }
  getTreeItem(node: GenericNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.contextValue = node.contextValue;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    return item;
  }
  async getChildren(): Promise<GenericNode[]> {
    return this.load();
  }
}

export class GenericNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description?: string,
    public readonly icon?: string,
    public readonly contextValue?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

// Builders for each entity type.
export function providersTree(bridge: OpencodeBridge) {
  return new GenericTreeProvider<unknown>("providers", "Providers", async () => {
    const providers = await bridge.listProviders();
    const nodes: GenericNode[] = [];
    for (const p of providers) {
      for (const [mid, m] of Object.entries((p.models ?? {}) as Record<string, any>)) {
        nodes.push(new GenericNode(`${p.id}/${mid}`, m?.name ?? "", "file-code", "model"));
      }
    }
    if (nodes.length === 0) nodes.push(new GenericNode("No providers", undefined, "warning"));
    return nodes;
  });
}

export function agentsTree(bridge: OpencodeBridge) {
  return new GenericTreeProvider<unknown>("agents", "Agents", async () => {
    const agents = await bridge.listAgents();
    const nodes = agents.map(
      (a) =>
        new GenericNode(
          a.name,
          a.mode,
          a.mode === "primary" ? "star-full" : "person",
          "agent",
        ),
    );
    if (nodes.length === 0) nodes.push(new GenericNode("No agents", undefined, "warning"));
    return nodes;
  });
}

export function skillsTree(bridge: OpencodeBridge) {
  return new GenericTreeProvider<unknown>("skills", "Skills", async () => {
    const skills = await bridge.listSkills();
    const nodes = skills.map((s) => new GenericNode(s.name, s.description, "lightbulb", "skill"));
    if (nodes.length === 0) nodes.push(new GenericNode("No skills", undefined, "warning"));
    return nodes;
  });
}

export function mcpTree(bridge: OpencodeBridge) {
  return new GenericTreeProvider<unknown>("mcp", "MCP", async () => {
    const servers = await bridge.listMcp();
    const nodes = servers.map(
      (s) =>
        new GenericNode(
          s.id,
          s.status,
          s.status === "connected" ? "plug" : "debug-disconnect",
          "mcp",
        ),
    );
    if (nodes.length === 0) nodes.push(new GenericNode("No MCP servers", undefined, "warning"));
    return nodes;
  });
}

export function pluginsTree(bridge: OpencodeBridge) {
  return new GenericTreeProvider<unknown>("plugins", "Plugins", async () => {
    const plugins = await bridge.listPlugins();
    const nodes = plugins.map((p) => new GenericNode(p.id ?? p.file ?? "plugin", undefined, "extensions", "plugin"));
    if (nodes.length === 0) nodes.push(new GenericNode("No plugins", undefined, "warning"));
    return nodes;
  });
}
