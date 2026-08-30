// Skill / MCP / plugin capability discovery across adapted applications and
// platforms. Read-only scans of each app's real config files; nothing is
// executed. MCP tool USAGE comes separately from ingested tool_calls
// (`mcp__<server>__<tool>`).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { DatabaseSync } from 'node:sqlite';
import { discoverPlatforms, LOCAL_PLATFORM_ID, type Platform } from './platforms.js';

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
  detail?: string; // plugin version / enabled state / agent description
}

export interface AppCapabilities {
  app: string;
  platform?: string; // set when not the local host, e.g. 'wsl:Ubuntu-26.04'
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

// dirs that exist in every tool home but are never skills/plugins
const JUNK_DIRS = new Set([
  'node_modules', '.git', 'bin', 'lib', 'cache', 'tmp', 'logs', 'data',
  'backups', 'downloads', 'snapshots', 'sessions', 'state', 'crashes',
  'scratch', 'bin-', 'builtin', 'implicit', 'knowledge',
]);

function listSkillDirs(dir: string): SkillInfo[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !JUNK_DIRS.has(e.name.toLowerCase()))
      .map((e) => ({ name: e.name, source: dir }));
  } catch {
    return [];
  }
}

interface CapsCtx {
  home: string; // platform home root
  platform: string; // platform id ('local' for the host)
}

function claudeCodeCaps(ctx: CapsCtx): AppCapabilities {
  const servers: McpServerInfo[] = [];
  const cfg = readJsonSafe(path.join(ctx.home, '.claude.json'));
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
  const caps: AppCapabilities = {
    app: 'claude-code',
    mcpServers: servers,
    skills: listSkillDirs(path.join(ctx.home, '.claude', 'skills')),
  };
  if (ctx.platform !== LOCAL_PLATFORM_ID) caps.platform = ctx.platform;
  return caps;
}

function codexCaps(ctx: CapsCtx): AppCapabilities {
  const servers: McpServerInfo[] = [];
  const file = path.join(ctx.home, '.codex', 'config.toml');
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
  const caps: AppCapabilities = {
    app: 'codex',
    mcpServers: servers,
    skills: listSkillDirs(path.join(ctx.home, '.codex', 'skills')),
  };
  if (ctx.platform !== LOCAL_PLATFORM_ID) caps.platform = ctx.platform;
  return caps;
}

function opencodeCaps(ctx: CapsCtx): AppCapabilities {
  const servers: McpServerInfo[] = [];
  for (const f of [path.join(ctx.home, '.config', 'opencode', 'opencode.json'), path.join(ctx.home, '.config', 'opencode', 'opencode.jsonc')]) {
    const cfg = readJsonSafe(f);
    for (const [name, spec] of Object.entries<any>(cfg?.mcp ?? {})) {
      servers.push({ name, scope: 'global', ...classifyServer(spec) });
    }
  }
  const caps: AppCapabilities = { app: 'opencode', mcpServers: servers, skills: [] };
  if (ctx.platform !== LOCAL_PLATFORM_ID) caps.platform = ctx.platform;
  return caps;
}

function dshCaps(ctx: CapsCtx): AppCapabilities {
  // dsh exposes extensions via harness plugins/bundles; surface the profile
  // directories as its "skill" equivalent instead of inventing an MCP view.
  const caps: AppCapabilities = {
    app: 'dsh',
    mcpServers: [],
    skills: listSkillDirs(path.join(ctx.home, '.dsh', 'profiles')),
    notes: 'dsh plugins live in its profile layers (~/.dsh/profiles)',
  };
  if (ctx.platform !== LOCAL_PLATFORM_ID) caps.platform = ctx.platform;
  return caps;
}

function piCaps(ctx: CapsCtx): AppCapabilities {
  const cfg = readJsonSafe(path.join(ctx.home, '.pi', 'agent', 'settings.json'));
  const servers: McpServerInfo[] = [];
  for (const [name, spec] of Object.entries<any>(cfg?.mcpServers ?? cfg?.mcp ?? {})) {
    servers.push({ name, scope: 'global', ...classifyServer(spec) });
  }
  const caps: AppCapabilities = { app: 'pi', mcpServers: servers, skills: [] };
  if (ctx.platform !== LOCAL_PLATFORM_ID) caps.platform = ctx.platform;
  return caps;
}

function antigravityCaps(ctx: CapsCtx): AppCapabilities {
  const servers: McpServerInfo[] = [];
  for (const f of [path.join(ctx.home, '.agy', 'config.json'), path.join(ctx.home, '.gemini', 'antigravity-cli', 'settings.json')]) {
    const cfg = readJsonSafe(f);
    for (const [name, spec] of Object.entries<any>(cfg?.mcpServers ?? cfg?.mcp ?? {})) {
      servers.push({ name, scope: 'global', ...classifyServer(spec) });
    }
  }
  const caps: AppCapabilities = {
    app: 'antigravity',
    mcpServers: servers,
    // only real workflow/skill subdirs, not the whole antigravity home
    skills: ['skills', 'workflows'].flatMap((d) =>
      listSkillDirs(path.join(ctx.home, '.gemini', 'antigravity', d)).map((s) => ({ ...s, source: d }))),
    notes: 'antigravity skills/workflows live under ~/.gemini/antigravity/{skills,workflows}/',
  };
  if (ctx.platform !== LOCAL_PLATFORM_ID) caps.platform = ctx.platform;
  return caps;
}

/** qoder / qoder-cn: MCP (mcp.json), plugins (installed_plugins_v2.json),
 *  custom agents (agents/*.md) and skills (~/.qoder[-cn]/skills). */
function qoderCaps(variant: 'qoder' | 'qoder-cn', ctx: CapsCtx): AppCapabilities {
  const home = path.join(ctx.home, variant === 'qoder' ? '.qoder' : '.qoder-cn');
  const servers: McpServerInfo[] = [];
  const mcp = readJsonSafe(path.join(home, 'mcp.json'));
  for (const [name, spec] of Object.entries<any>(mcp?.mcpServers ?? {})) {
    servers.push({ name, scope: 'global', ...classifyServer(spec) });
  }
  const skills: SkillInfo[] = listSkillDirs(path.join(home, 'skills'));
  // plugins with enabled state
  const plugins = readJsonSafe(path.join(home, 'plugins', 'installed_plugins_v2.json'));
  for (const [name, installs] of Object.entries<any>(plugins?.plugins ?? {})) {
    for (const inst of Array.isArray(installs) ? installs : []) {
      skills.push({
        name,
        source: 'plugins',
        detail: `v${inst.version ?? '?'} · ${inst.enabled === false ? 'disabled' : 'enabled'}`,
      });
    }
  }
  // custom sub-agents
  const agentsDir = path.join(home, 'agents');
  if (existsSync(agentsDir)) {
    try {
      for (const e of readdirSync(agentsDir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.md')) {
          skills.push({ name: e.name.replace(/\.md$/, ''), source: 'agents', detail: 'agent' });
        }
      }
    } catch {
      /* ignore */
    }
  }
  const caps: AppCapabilities = {
    app: variant,
    mcpServers: servers,
    skills,
    notes: 'qoder config: ~/.qoder[-cn]/{mcp.json,plugins,agents,skills}',
  };
  if (ctx.platform !== LOCAL_PLATFORM_ID) caps.platform = ctx.platform;
  return caps;
}

function capsForPlatform(p: Platform): AppCapabilities[] {
  const ctx: CapsCtx = { home: p.home, platform: p.id };
  const all = [
    claudeCodeCaps(ctx),
    codexCaps(ctx),
    opencodeCaps(ctx),
    dshCaps(ctx),
    piCaps(ctx),
    antigravityCaps(ctx),
    qoderCaps('qoder', ctx),
    qoderCaps('qoder-cn', ctx),
  ];
  // skip cards for apps that have nothing at all on this platform
  return all.filter((c) => c.mcpServers.length || c.skills.length || existsSync(path.join(p.home, `.${c.app.replace('-cn', '')}`)));
}

export async function discoverCapabilities(): Promise<AppCapabilities[]> {
  const platforms = await discoverPlatforms();
  const out: AppCapabilities[] = [];
  for (const p of platforms) {
    if (!p.available) continue;
    try {
      out.push(...capsForPlatform(p));
    } catch {
      /* a platform that half-exists shouldn't kill the whole scan */
    }
  }
  return out;
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
