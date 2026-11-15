import * as vscode from "vscode";
import { l10n } from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ImportReport } from "./types";

// Import skills, MCP servers, and plugins from the machine into the opencode
// config directory. Sources scanned:
//   - ~/.config/opencode/          (global)
//   - project .opencode/            (project-level)
//   - WSL distros under \\wsl$\...  (when running on Windows)

interface Discovered {
  skills: Array<{ name: string; path: string; description?: string }>;
  mcp: Record<string, unknown>;
  plugins: Array<{ name: string; path: string }>;
}

export async function importFromMachine(context: vscode.ExtensionContext): Promise<ImportReport> {
  const report: ImportReport = {
    skills: { total: 0, imported: 0, skipped: 0 },
    mcp: { total: 0, imported: 0, skipped: 0 },
    plugins: { total: 0, imported: 0, skipped: 0 },
    errors: [],
  };

  const configDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode");

  // Discovery
  const discovered = await discover(configDir, report);

  // Ask what to import
  const choices: Array<vscode.QuickPickItem & { id: "skills" | "mcp" | "plugins" }> = [
    { id: "skills", label: l10n.t("Skills ({0})", String(discovered.skills.length)) },
    { id: "mcp", label: l10n.t("MCP servers ({0})", String(Object.keys(discovered.mcp).length)) },
    { id: "plugins", label: l10n.t("Plugins ({0})", String(discovered.plugins.length)) },
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    canPickMany: true,
    placeHolder: l10n.t("Select what to import"),
  });
  if (!picked || picked.length === 0) return report;

  const wantSkills = picked.some((p) => p.id === "skills");
  const wantMcp = picked.some((p) => p.id === "mcp");
  const wantPlugins = picked.some((p) => p.id === "plugins");

  // Import skills
  if (wantSkills) {
    const skillsDir = path.join(configDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const s of discovered.skills) {
      report.skills.total++;
      const dest = path.join(skillsDir, s.name);
      try {
        copyDir(s.path, dest, report.errors);
        report.skills.imported++;
      } catch (err) {
        report.skills.skipped++;
        report.errors.push(`skill ${s.name}: ${(err as Error).message}`);
      }
    }
  }

  // Import MCP servers (merge into opencode.json mcp block)
  if (wantMcp) {
    const cfgPath = path.join(configDir, "opencode.json");
    try {
      const config = loadConfig(cfgPath);
      const mcp = (config.mcp ??= {}) as Record<string, unknown>;
      for (const [name, entry] of Object.entries(discovered.mcp)) {
        report.mcp.total++;
        if (name in mcp) {
          report.mcp.skipped++;
          continue;
        }
        mcp[name] = entry;
        report.mcp.imported++;
      }
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
    } catch (err) {
      report.errors.push(`mcp merge: ${(err as Error).message}`);
    }
  }

  // Import plugins
  if (wantPlugins) {
    const pluginsDir = path.join(configDir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    for (const p of discovered.plugins) {
      report.plugins.total++;
      const dest = path.join(pluginsDir, p.name);
      try {
        if (fs.existsSync(dest)) {
          report.plugins.skipped++;
          continue;
        }
        fs.copyFileSync(p.path, dest);
        report.plugins.imported++;
      } catch (err) {
        report.plugins.skipped++;
        report.errors.push(`plugin ${p.name}: ${(err as Error).message}`);
      }
    }
  }

  return report;
}

async function discover(configDir: string, report: ImportReport): Promise<Discovered> {
  const out: Discovered = { skills: [], mcp: {}, plugins: [] };
  await discoverDir(configDir, out, report);
  await discoverProject(out, report);
  await discoverWsl(out, report);
  return out;
}

async function discoverDir(dir: string, out: Discovered, report: ImportReport) {
  // Skills: dir/skills/<name>/SKILL.md
  const skillsRoot = path.join(dir, "skills");
  if (fs.existsSync(skillsRoot)) {
    for (const name of fs.readdirSync(skillsRoot)) {
      const skillPath = path.join(skillsRoot, name);
      const skillFile = path.join(skillPath, "SKILL.md");
      const description = readSkillDescription(skillFile);
      out.skills.push({ name, path: skillPath, description });
    }
  }

  // Plugins: dir/plugins/*.ts
  const pluginsRoot = path.join(dir, "plugins");
  if (fs.existsSync(pluginsRoot)) {
    for (const file of fs.readdirSync(pluginsRoot)) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      out.plugins.push({ name: file, path: path.join(pluginsRoot, file) });
    }
  }

  // MCP: from opencode.json "mcp" block
  const cfgPath = path.join(dir, "opencode.json");
  if (fs.existsSync(cfgPath)) {
    try {
      const config = loadConfig(cfgPath);
      const mcp = (config.mcp ?? {}) as Record<string, unknown>;
      for (const [name, entry] of Object.entries(mcp)) {
        out.mcp[name] = entry;
      }
    } catch (err) {
      report.errors.push(`parse ${cfgPath}: ${(err as Error).message}`);
    }
  }
}

async function discoverProject(out: Discovered, report: ImportReport) {
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (!wf) return;
  const projectDir = path.join(wf.uri.fsPath, ".opencode");
  if (fs.existsSync(projectDir)) {
    await discoverDir(projectDir, out, report);
  }
}

async function discoverWsl(out: Discovered, report: ImportReport) {
  // Only meaningful on Windows; enumerate WSL distros and their opencode dirs.
  if (process.platform !== "win32") return;
  try {
    const { execFile } = await import("node:child_process");
    const distros = await new Promise<string[]>((resolve) => {
      execFile("wsl.exe", ["-l", "-q"], (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s && !s.includes("\x00")),
        );
      });
    });
    for (const distro of distros) {
      const wslDir = `\\\\wsl$\\${distro}\\home`;
      try {
        const home = `\\\\wsl$\\${distro}\\home`;
        const configDir = path.join(home, "dev", "llmcode"); // heuristic only
        if (fs.existsSync(configDir)) await discoverDir(configDir, out, report);
      } catch {
        // skip inaccessible distro
      }
    }
  } catch {
    // wsl.exe unavailable
  }
}

function loadConfig(cfgPath: string): Record<string, any> {
  const raw = fs.readFileSync(cfgPath, "utf8");
  return JSON.parse(raw);
}

function readSkillDescription(skillFile: string): string | undefined {
  if (!fs.existsSync(skillFile)) return undefined;
  const raw = fs.readFileSync(skillFile, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return undefined;
  const dm = m[1].match(/description:\s*(.+)/);
  return dm?.[1]?.trim();
}

function copyDir(src: string, dest: string, errors: string[]) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d, errors);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}
