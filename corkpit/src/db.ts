import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DATA_DIR = path.join(homedir(), '.cockpit');
export const DB_PATH = path.join(DATA_DIR, 'cockpit.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  base_url TEXT,
  key_source TEXT,          -- env:<NAME> | inline | none
  notes TEXT
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  display_name TEXT,
  context_window INTEGER,
  max_tokens INTEGER,
  reasoning INTEGER DEFAULT 0,
  PRIMARY KEY (id, provider_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subject_id INTEGER REFERENCES subjects(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS note_links (
  note_id INTEGER NOT NULL REFERENCES knowledge_notes(id),
  target_type TEXT NOT NULL,  -- session | problem | agent | project | model | provider
  target_id TEXT NOT NULL,
  PRIMARY KEY (note_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  cwd TEXT,
  started_at TEXT,
  last_activity TEXT,
  provider_id TEXT,
  model_id TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  provider_locked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  ts TEXT,
  model_id TEXT,
  provider_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  name TEXT NOT NULL,
  ts TEXT
);

CREATE TABLE IF NOT EXISTS problem_sessions (
  problem_id INTEGER NOT NULL REFERENCES problems(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  PRIMARY KEY (problem_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
`;

export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // migrate: manual provider assignments should survive re-ingest
  const sessCols = db.prepare(`PRAGMA table_info(sessions)`).all().map((c: any) => c.name);
  if (!sessCols.includes('provider_locked')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN provider_locked INTEGER NOT NULL DEFAULT 0`);
  }
  return db;
}
