import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#FFA94D',
  icon TEXT DEFAULT '📁',
  sort REAL DEFAULT 0,
  archived INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER DEFAULT 0,
  due_at TEXT,
  due_kind TEXT NOT NULL DEFAULT 'on',
  all_day INTEGER DEFAULT 0,
  project_id TEXT,
  tags TEXT DEFAULT '[]',
  parent_id TEXT,
  recurrence TEXT,
  location TEXT,
  sort REAL DEFAULT 0,
  notified_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE TABLE IF NOT EXISTS completions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  title TEXT DEFAULT '',
  completed_at TEXT NOT NULL,
  date_local TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_completions_date ON completions(date_local);
CREATE INDEX IF NOT EXISTS idx_completions_task ON completions(task_id);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'note',
  content TEXT DEFAULT '',
  items TEXT DEFAULT '[]',
  color TEXT,
  pinned INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT,
  from_label TEXT DEFAULT '',
  content TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  suggestion TEXT,
  resolved_task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_external
  ON inbox_items(external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS briefings (
  date_local TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  week_key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT 'Conversation',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT DEFAULT '',
  activity TEXT DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS triage_feedback (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  content TEXT DEFAULT '',
  from_label TEXT DEFAULT '',
  source TEXT DEFAULT 'gmail',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT DEFAULT '',
  refresh_token TEXT DEFAULT '',
  expiry TEXT DEFAULT '',
  email TEXT DEFAULT '',
  scopes TEXT DEFAULT ''
);
`;

export function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

/** Additive column migrations for databases created by older builds. */
function migrate(db: Database.Database): void {
  const taskCols = new Set(
    (db.pragma("table_info(tasks)") as { name: string }[]).map((c) => c.name)
  );
  if (!taskCols.has("location")) {
    db.exec("ALTER TABLE tasks ADD COLUMN location TEXT");
  }
  if (!taskCols.has("due_kind")) {
    db.exec("ALTER TABLE tasks ADD COLUMN due_kind TEXT NOT NULL DEFAULT 'on'");
  }
}

function open(): Database.Database {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "donex.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const globalForDb = globalThis as unknown as { __donexDb?: Database.Database };

export function getDb(): Database.Database {
  if (!globalForDb.__donexDb) {
    globalForDb.__donexDb = open();
  }
  return globalForDb.__donexDb;
}
