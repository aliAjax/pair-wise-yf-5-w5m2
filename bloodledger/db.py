"""数据库连接与表结构。

表设计(一袋血一本账):
  donations     献血登记(献血码唯一,先登记者有效)
  rechecks      复检结果(晚到,可订正)
  components    成分(一袋全血拆 红细胞/血浆/血小板,各自效期与状态)
  issue_slips   发放单(头)
  issue_lines   发放单(行,对账追回的依据)
  recalls       追回单(凭发放单向医院追回)
  conflicts     同码冲突(晚到的登记)
  merge_runs    离线批次合并进度(断点续传)
  merge_records 批次内已处理记录(幂等)
  events        事件流水(血品账的"账")
"""

import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS donations (
    donation_code      TEXT PRIMARY KEY,          -- 献血码
    donor_name         TEXT NOT NULL,
    blood_type_initial TEXT NOT NULL,             -- 初检血型
    collected_at       TEXT NOT NULL,             -- 采血时间(ISO)
    site_id            TEXT NOT NULL DEFAULT '',  -- 采血点/采血车
    source_batch       TEXT,                      -- 来源离线批次
    registered_at      TEXT NOT NULL              -- 登记入库时间
);

CREATE TABLE IF NOT EXISTS rechecks (
    donation_code      TEXT PRIMARY KEY REFERENCES donations(donation_code),
    blood_type_recheck TEXT NOT NULL,
    received_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS components (
    component_id  TEXT PRIMARY KEY,               -- 献血码-成分类型,天然幂等
    donation_code TEXT NOT NULL REFERENCES donations(donation_code),
    ctype         TEXT NOT NULL,                  -- RBC/PLASMA/PLT
    blood_type    TEXT NOT NULL,                  -- 当前采用血型(可被复检订正)
    collected_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL,                  -- 该成分自己的效期
    status        TEXT NOT NULL,                  -- AVAILABLE/PENDING/ISSUED/RECALLED/DISCARDED/EXPIRED
    UNIQUE (donation_code, ctype)                 -- 重复上传不重复建成分
);

CREATE TABLE IF NOT EXISTS issue_slips (
    slip_id   TEXT PRIMARY KEY,
    hospital  TEXT NOT NULL,
    issued_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_lines (
    slip_id      TEXT NOT NULL REFERENCES issue_slips(slip_id),
    component_id TEXT NOT NULL REFERENCES components(component_id),
    status       TEXT NOT NULL DEFAULT 'issued',  -- issued/recalled
    PRIMARY KEY (slip_id, component_id)
);

CREATE TABLE IF NOT EXISTS recalls (
    recall_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    component_id TEXT NOT NULL REFERENCES components(component_id),
    slip_id      TEXT NOT NULL REFERENCES issue_slips(slip_id),
    hospital     TEXT NOT NULL,
    reason       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open'     -- open/recovered
);

CREATE TABLE IF NOT EXISTS conflicts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    donation_code TEXT NOT NULL,
    site_id       TEXT,
    payload       TEXT NOT NULL,                  -- 晚到登记的原始内容(JSON)
    reason        TEXT NOT NULL,
    received_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merge_runs (
    batch_id  TEXT PRIMARY KEY,
    site_id   TEXT,
    total     INTEGER NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    status    TEXT NOT NULL DEFAULT 'running'     -- running/interrupted/done
);

CREATE TABLE IF NOT EXISTS merge_records (
    batch_id   TEXT NOT NULL,
    record_key TEXT NOT NULL,
    outcome    TEXT NOT NULL,
    PRIMARY KEY (batch_id, record_key)
);

CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    kind          TEXT NOT NULL,
    donation_code TEXT,
    component_id  TEXT,
    detail        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_components_donation ON components(donation_code);
CREATE INDEX IF NOT EXISTS idx_components_stock    ON components(ctype, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_events_donation     ON events(donation_code);
"""


def connect(path: str) -> sqlite3.Connection:
    """打开数据库(自动提交模式,事务由 service 层显式控制)。"""
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")  # 两个采血点同时写时等待而非报错
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
