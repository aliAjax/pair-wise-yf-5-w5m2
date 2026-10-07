// 数据层：基于 sql.js（WASM 版 SQLite），零原生编译。
// 所有写操作经 withTransaction 串行化（互斥 + 事务），提交后原子落盘，
// 即使合并中途进程被杀，重试时靠幂等键也能续传且不重复建成分。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'blood-ledger.db');

let db = null;

export function now() {
  return new Date().toISOString();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY,
  donation_code TEXT NOT NULL UNIQUE,
  donor_name TEXT,
  collection_point TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  initial_blood_type TEXT,
  status TEXT NOT NULL DEFAULT 'registered',
  source TEXT NOT NULL DEFAULT 'online',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_results (
  id TEXT PRIMARY KEY,
  donation_id TEXT NOT NULL REFERENCES donations(id),
  blood_type TEXT NOT NULL,
  tested_at TEXT NOT NULL,
  conclusion_no INTEGER NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY,
  donation_id TEXT NOT NULL REFERENCES donations(id),
  type TEXT NOT NULL,
  batch_no TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  expiry_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  invalid_reason TEXT,
  issued_quantity INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(donation_id, type)
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  issue_no TEXT NOT NULL UNIQUE,
  hospital TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_items (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  component_id TEXT NOT NULL REFERENCES components(id),
  quantity INTEGER NOT NULL,
  UNIQUE(issue_id, component_id)
);
CREATE TABLE IF NOT EXISTS recalls (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id),
  issue_id TEXT NOT NULL REFERENCES issues(id),
  issue_item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  reconciled_at TEXT
);
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  donation_code TEXT NOT NULL,
  rejected_donation_id TEXT NOT NULL,
  donor_name TEXT,
  collection_point TEXT NOT NULL,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS merge_batches (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  received_at TEXT NOT NULL,
  completed_at TEXT,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS merge_records (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES merge_batches(id),
  client_record_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, client_record_id)
);
`;

export async function initDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  persist();
  return db;
}

export function getDb() {
  if (!db) throw new Error('数据库未初始化');
  return db;
}

// 原子落盘：先写临时文件再 rename，避免中途写坏。
function persist() {
  const data = db.export();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, DB_FILE);
}

// 互斥 + 事务：所有写操作串行执行，提交后落盘。
let chain = Promise.resolve();
export function withTransaction(fn) {
  const run = chain.then(() => {
    const d = getDb();
    d.run('BEGIN');
    try {
      const result = fn();
      d.run('COMMIT');
      persist();
      return result;
    } catch (err) {
      try { d.run('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  });
  chain = run.catch(() => { /* 不让互斥链断裂 */ });
  return run;
}

// ---- 查询辅助 ----
export function all(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function get(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function run(sql, params = []) {
  getDb().run(sql, params);
}
