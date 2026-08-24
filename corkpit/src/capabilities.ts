// Skill / MCP capability discovery across adapted applications.
// Read-only scans of each app's real config files; nothing is executed.
// MCP tool USAGE comes separately from ingested tool_calls (`mcp__<server>__<tool>`).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { DatabaseSync } from 'node:sqlite';

const H = homedir();

export interface McpServerInfo {
  name: string;
  scope: 'global' | 'project';
  transport: 'stdio' | 'http' | 'unknown';
  target: string; // command line or url
  project?: string;
}

export interface SkillInfo {
  name: string;
  source: string; // directory it was discovered in
}

export interface AppCapabilities {
  app: string;
  mcpServers: McpServerInfo[];
  skills: SkillInfo[];
  notes?: string;
}

function readJsonSafe(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function classifyServer(spec: any): { transport: McpServerInfo['transport']; target: string } {
  if (!spec || typeof spec !== 'object') return { transport: 'unknown', target: '' };
  if (spec.url) return { transport: 'http', target: String(spec.url) };
  if (spec.command) {
    const args = Array.isArray(spec.args) ? spec.args.join(' ') : '';
    return { transport: 'stdio', target: [spec.command, args].filter(Boolean).join(' ') };
  }
  return { transport: 'unknown', target: JSON.stringify(spec).slice(0, 120) };
}

function listSkillDirs(dir: string): SkillInfo[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, source: dir }));
  } catch {
    return [];
  }
}

function claudeCodeCaps(): AppCapabilities {
  const servers: McpServerInfo[] = [];
  const cfg = readJsonSafe(path.join(H, '.claude.json'));
  if (cfg) {
    for (const [name, spec] of Object.entries(cfg.mcpServers ?? {})) {
      servers.push({ name, scope: 'global', ...classifyServer(spec) });
    }
    for (const [proj, pcfg] of Object.entries<any>(cfg.projects ?? {})) {
      for (const [name, spec] of Object.entries(pcfg?.mcpServers ?? {})) {
        servers.push({ name, scope: 'project', project: proj, ...classifyServer(spec) });
      }
    }
  }
  return { app: 'claude-code', mcpServers: servers, skills: listSkillDirs(path.join(H, '.claude', 'skills')) };
}

function codexCaps(): AppCapabilities {
  const servers: McpServerInfo[] = [];
  const file = path.join(H, '.codex', 'config.toml');
  if (existsSync(file)) {
    try {
      const cfg = parseToml(readFileSync(file, 'utf8')) as any;
      for (const [name, spec] of Object.entries<any>(cfg.mcp_servers ?? {})) {
        servers.push({ name, scope: 'global', ...classifyServer(spec) });
      }
    } catch {
      /* malformed toml — skip */
    }
  }
  return { app: 'codex', mcpServers: servers, skills: listSkillDirs(path.join(H, '.codex', 'skills')) };
}

function opencodeCaps(): AppCapabilities {
  const servers: McpServerInfo[] = [];
  for (const f of [path.join(H, '.config', 'opencode', 'opencode.json'), path.join(H, '.config', 'opencode', 'opencode.jsonc')]) {
    const cfg = readJsonSafe(f);
    for (const [name, spec] of Object.entries<any>(cfg?.mcp ?? {})) {
      servers.push({ name, scope: 'global', ...classifyServer(spec) });
    }
  }
  return { app: 'opencode', mcpServers: servers, skills: [] };
}

function dshCaps(): AppCapabilities {
  // dsh exposes extensions via harness plugins/bundles; surface the profile
  // directories as its "skill" equivalent instead of inventing an MCP view.
  const skills: SkillInfo[] = [];
  const profiles = path.join(H, '.dsh', 'profiles');
  if (existsSync(profiles)) {
    try {
      for (const e of readdirSync(profiles, { withFileTypes: true })) {
        if (e.isDirectory()) skills.push({ name: e.name, source: profiles });
      }
    } catch {
      /* ignore */
    }
  }
  return { app: 'dsh', mcpServers: [], skills, notes: 'dsh plugins live in its profile layers (~/.dsh/profiles)' };
}

function piCaps(): AppCapabilities {
  const cfg = readJsonSafe(path.join(H, '.pi', 'agent', 'settings.json'));
  const servers: McpServerInfo[] = [];
  for (const [name, spec] of Object.entries<any>(cfg?.mcpServers ?? cfg?.mcp ?? {})) {
    servers.push({ name, scope: 'global', ...classifyServer(spec) });
  }
  return { app: 'pi', mcpServers: servers, skills: [] };
}

function antigravityCaps(): AppCapabilities {
  const servers: McpServerInfo[] = [];
  for (const f of [path.join(H, '.agy', 'config.json'), path.join(H, '.gemini', 'antigravity-cli', 'settings.json')]) {
    const cfg = readJsonSafe(f);
    for (const [name, spec] of Object.entries<any>(cfg?.mcpServers ?? cfg?.mcp ?? {})) {
      servers.push({ name, scope: 'global', ...classifyServer(spec) });
    }
  }
  return {
    app: 'antigravity',
    mcpServers: servers,
    skills: listSkillDirs(path.join(H, '.gemini', 'antigravity')),
    notes: 'antigravity skills/workflows live under ~/.gemini/antigravity/',
  };
}

export function discoverCapabilities(): AppCapabilities[] {
  return [claudeCodeCaps(), codexCaps(), opencodeCaps(), dshCaps(), piCaps(), antigravityCaps()];
}

/** Aggregate mcp__server__tool usage from ingested tool_calls. */
export function mcpUsage(db: DatabaseSync): { server: string; tool: string; count: number }[] {
  const rows = db.prepare(`
    SELECT name, COUNT(*) AS count FROM tool_calls
    WHERE name LIKE 'mcp\\_\\_%' ESCAPE '\\'
    GROUP BY name`).all() as { name: string; count: number }[];
  const byTool = new Map<string, { server: string; tool: string; count: number }>();
  for (const r of rows) {
    const parts = r.name.split('__');
    if (parts.length < 3) continue;
    const server = parts[1];
    const tool = parts.slice(2).join('__');
    const key = `${server}::${tool}`;
    const cur = byTool.get(key);
    if (cur) cur.count += r.count;
    else byTool.set(key, { server, tool, count: r.count });
  }
  return [...byTool.values()].sort((a, b) => b.count - a.count);
}
