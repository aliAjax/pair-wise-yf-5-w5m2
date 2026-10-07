"""血品账核心业务逻辑。

状态机(成分):
  AVAILABLE  可发放(初检合格,复检未回或已确认)
  PENDING    待定(初复检不符,禁止发放)
  ISSUED     已发放(凭发放单可对账追回)
  RECALLED   追回中(已通知医院,待退回)
  DISCARDED  已报废/失效(含追回退回)
  EXPIRED    已过效期
"""

import contextlib
import json
import sqlite3
import uuid
from datetime import datetime, timedelta

from .db import connect, init_schema

# 各成分效期(天),自采血时刻起算;可按血站规程调整
SHELF_LIFE_DAYS = {"RBC": 35, "PLASMA": 365, "PLT": 5}
CTYPE_NAMES = {"RBC": "红细胞", "PLASMA": "血浆", "PLT": "血小板"}

AVAILABLE, ISSUED, PENDING = "AVAILABLE", "ISSUED", "PENDING"
RECALLED, DISCARDED, EXPIRED = "RECALLED", "DISCARDED", "EXPIRED"
STATUS_NAMES = {
    AVAILABLE: "可用", PENDING: "待定", ISSUED: "已发放",
    RECALLED: "追回中", DISCARDED: "已报废", EXPIRED: "已过期",
}


class MergeInterrupted(Exception):
    """合并中断(断电/进程被杀)。批次已处理部分已落库,重新调用即可续传。"""

    def __init__(self, batch_id, done, total):
        self.batch_id, self.done, self.total = batch_id, done, total
        super().__init__(f"批次 {batch_id} 合并中断于 {done}/{total},可重新执行续传")


class UnknownDonation(Exception):
    pass


class UnknownComponent(Exception):
    pass


class ComponentPending(Exception):
    """待定成分禁止发放。"""


class ComponentUnavailable(Exception):
    pass


class ComponentExpired(Exception):
    pass


def _iso(t):
    if isinstance(t, datetime):
        return t.replace(microsecond=0).isoformat()
    return str(t)


def _parse(s):
    return datetime.fromisoformat(s)


_TX_DEPTH = {}  # sqlite3.Connection 不支持自定义属性,按连接跟踪事务深度


@contextlib.contextmanager
def _tx(conn):
    """可重入事务:外层是真实事务,内层用 SAVEPOINT。

    内层回滚只退到保存点(如登记冲突时只撤销本条插入),
    不拖垮外层合并循环的事务。
    """
    depth = _TX_DEPTH.get(id(conn), 0)
    sp = f"sp_{depth}"
    if depth == 0:
        conn.execute("BEGIN IMMEDIATE")
    else:
        conn.execute(f"SAVEPOINT {sp}")
    _TX_DEPTH[id(conn)] = depth + 1
    try:
        yield
    except Exception:
        _TX_DEPTH[id(conn)] = depth
        if depth == 0:
            conn.execute("ROLLBACK")
        else:
            conn.execute(f"ROLLBACK TO SAVEPOINT {sp}")
            conn.execute(f"RELEASE {sp}")
        raise
    else:
        _TX_DEPTH[id(conn)] = depth
        if depth == 0:
            conn.execute("COMMIT")
        else:
            conn.execute(f"RELEASE {sp}")


class BloodLedger:
    def __init__(self, conn):
        self.conn = conn

    @classmethod
    def open(cls, path):
        conn = connect(path)
        init_schema(conn)
        return cls(conn)

    # ---------------------------------------------------------------- 事件账
    def _event(self, now, kind, donation_code=None, component_id=None, detail=""):
        self.conn.execute(
            "INSERT INTO events(at, kind, donation_code, component_id, detail) VALUES (?,?,?,?,?)",
            (_iso(now), kind, donation_code, component_id, detail),
        )

    def ledger(self, donation_code):
        """一袋血的完整流水账。"""
        return list(self.conn.execute(
            "SELECT * FROM events WHERE donation_code = ? OR component_id LIKE ? ORDER BY id",
            (donation_code, f"{donation_code}-%"),
        ))

    # ---------------------------------------------------------------- 登记
    def register_donation(self, donation_code, donor_name, blood_type_initial,
                          collected_at, site_id="", now=None, source_batch=None):
        """献血登记。同一献血码只收先登记的那条:
        - 同人同数据重复上传 -> 'duplicate'(幂等合并,不算冲突)
        - 不同内容抢同一码   -> 'conflict',晚到的进冲突表
        """
        now = now or datetime.now()
        try:
            with _tx(self.conn):
                self.conn.execute(
                    "INSERT INTO donations(donation_code, donor_name, blood_type_initial,"
                    " collected_at, site_id, source_batch, registered_at)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (donation_code, donor_name, blood_type_initial, _iso(collected_at),
                     site_id, source_batch, _iso(now)),
                )
                self._event(now, "REGISTERED", donation_code,
                            detail=f"采血点[{site_id}] 初检血型 {blood_type_initial}")
            return "registered"
        except sqlite3.IntegrityError:
            existing = self._donation(donation_code)
            same = (
                existing["donor_name"] == donor_name
                and existing["blood_type_initial"] == blood_type_initial
                and existing["collected_at"] == _iso(collected_at)
                and existing["site_id"] == site_id
            )
            if same:
                return "duplicate"
            with _tx(self.conn):
                self.conn.execute(
                    "INSERT INTO conflicts(donation_code, site_id, payload, reason, received_at)"
                    " VALUES (?,?,?,?,?)",
                    (donation_code, site_id,
                     json.dumps({"donor_name": donor_name,
                                 "blood_type_initial": blood_type_initial,
                                 "collected_at": _iso(collected_at)},
                                ensure_ascii=False),
                     "献血码已被先登记,晚到登记拒收", _iso(now)),
                )
                self._event(now, "CONFLICT", donation_code,
                            detail=f"采血点[{site_id}] 同码晚到,已列入冲突")
            return "conflict"

    def _donation(self, donation_code):
        row = self.conn.execute(
            "SELECT * FROM donations WHERE donation_code = ?", (donation_code,)).fetchone()
        if not row:
            raise UnknownDonation(donation_code)
        return row

    def _set_status(self, component_id, status):
        self.conn.execute("UPDATE components SET status = ? WHERE component_id = ?",
                          (status, component_id))

    # ---------------------------------------------------------------- 制备
    def prepare_components(self, donation_code, now=None):
        """一袋全血拆成红细胞/血浆/血小板,各自记效期。重复调用不重复建成分。"""
        now = now or datetime.now()
        don = self._donation(donation_code)
        created = []
        with _tx(self.conn):
            for ctype, days in SHELF_LIFE_DAYS.items():
                cid = f"{donation_code}-{ctype}"
                expires = _iso(_parse(don["collected_at"]) + timedelta(days=days))
                cur = self.conn.execute(
                    "INSERT OR IGNORE INTO components"
                    "(component_id, donation_code, ctype, blood_type, collected_at, expires_at, status)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (cid, donation_code, ctype, don["blood_type_initial"],
                     don["collected_at"], expires, AVAILABLE),
                )
                if cur.rowcount:
                    created.append(cid)
                    self._event(now, "PREPARED", donation_code, cid,
                                f"制备{CTYPE_NAMES[ctype]},效期至 {expires[:10]}")
        return created

    # ---------------------------------------------------------------- 复检
    def receive_recheck(self, donation_code, blood_type_recheck, now=None):
        """复检结果回站。与初检不符 -> 未发出的成分挂待定,禁止发放。"""
        now = now or datetime.now()
        don = self._donation(donation_code)
        with _tx(self.conn):
            self.conn.execute(
                "INSERT INTO rechecks(donation_code, blood_type_recheck, received_at)"
                " VALUES (?,?,?)"
                " ON CONFLICT(donation_code) DO UPDATE SET"
                " blood_type_recheck = excluded.blood_type_recheck,"
                " received_at = excluded.received_at",
                (donation_code, blood_type_recheck, _iso(now)),
            )
            if blood_type_recheck == don["blood_type_initial"]:
                self._event(now, "RECHECK_CONSISTENT", donation_code,
                            detail=f"复检 {blood_type_recheck} 与初检一致")
                return "consistent"
            held = 0
            for row in self.conn.execute(
                    "SELECT component_id, status FROM components WHERE donation_code = ?",
                    (donation_code,)):
                if row["status"] == AVAILABLE:
                    self._set_status(row["component_id"], PENDING)
                    held += 1
            self._event(now, "RECHECK_MISMATCH", donation_code,
                        detail=f"初检 {don['blood_type_initial']} / 复检 {blood_type_recheck}"
                               f" 不符,{held} 个未发成分挂待定")
            return "mismatch"

    def resolve_recheck(self, donation_code, conclusion, now=None, new_blood_type=None):
        """复检结论变更,按新结论结账:
        - confirm : 待定解除,恢复可发
        - correct : 未发出的按新血型订正并重算效期;已发出的凭发放单追回
        - invalid : 未发出的失效报废;已发出的凭发放单追回
        """
        now = now or datetime.now()
        self._donation(donation_code)
        if conclusion == "correct" and not new_blood_type:
            raise ValueError("conclusion='correct' 需要 new_blood_type")
        with _tx(self.conn):
            rows = list(self.conn.execute(
                "SELECT * FROM components WHERE donation_code = ?", (donation_code,)))
            for row in rows:
                cid = row["component_id"]
                if conclusion == "confirm":
                    if row["status"] == PENDING:
                        self._set_status(cid, AVAILABLE)
                        self._event(now, "RELEASED", donation_code, cid, "复检确认初检,待定解除")
                elif conclusion == "correct":
                    if row["status"] in (PENDING, AVAILABLE):
                        expires = _iso(_parse(row["collected_at"])
                                       + timedelta(days=SHELF_LIFE_DAYS[row["ctype"]]))
                        self.conn.execute(
                            "UPDATE components SET blood_type = ?, expires_at = ?, status = ?"
                            " WHERE component_id = ?",
                            (new_blood_type, expires, AVAILABLE, cid))
                        self._event(now, "TYPE_CORRECTED", donation_code, cid,
                                    f"按复检结论订正血型为 {new_blood_type},效期重算至 {expires[:10]}")
                    elif row["status"] == ISSUED:
                        self._recall(cid, now, f"复检血型订正为 {new_blood_type}")
                elif conclusion == "invalid":
                    if row["status"] in (PENDING, AVAILABLE):
                        self.conn.execute(
                            "UPDATE components SET status = ?, expires_at = ?"
                            " WHERE component_id = ?", (DISCARDED, _iso(now), cid))
                        self._event(now, "DISCARDED", donation_code, cid,
                                    "复检结论不合格,未发出部分失效")
                    elif row["status"] == ISSUED:
                        self._recall(cid, now, "复检结论不合格")
                else:
                    raise ValueError(f"未知结论: {conclusion}")

    def _recall(self, component_id, now, reason):
        """拿发放单对账,向医院追回已发出的成分。"""
        line = self.conn.execute(
            "SELECT il.slip_id, s.hospital, c.donation_code"
            " FROM issue_lines il"
            " JOIN issue_slips s ON s.slip_id = il.slip_id"
            " JOIN components c ON c.component_id = il.component_id"
            " WHERE il.component_id = ? AND il.status = 'issued'",
            (component_id,)).fetchone()
        if not line:
            raise ComponentUnavailable(f"{component_id} 无在途发放单可对账")
        self.conn.execute("UPDATE components SET status = ? WHERE component_id = ?",
                          (RECALLED, component_id))
        self.conn.execute(
            "UPDATE issue_lines SET status = 'recalled' WHERE slip_id = ? AND component_id = ?",
            (line["slip_id"], component_id))
        self.conn.execute(
            "INSERT INTO recalls(component_id, slip_id, hospital, reason, created_at)"
            " VALUES (?,?,?,?,?)",
            (component_id, line["slip_id"], line["hospital"], reason, _iso(now)))
        self._event(now, "RECALLED", line["donation_code"], component_id,
                    f"凭发放单 {line['slip_id']} 向[{line['hospital']}]追回:{reason}")

    def confirm_recall(self, recall_id, now=None):
        """医院退回,追回闭环。退回血一律报废,不得再发。"""
        now = now or datetime.now()
        with _tx(self.conn):
            rec = self.conn.execute("SELECT * FROM recalls WHERE recall_id = ?",
                                    (recall_id,)).fetchone()
            if not rec or rec["status"] != "open":
                raise UnknownComponent(f"追回单 {recall_id} 不存在或已关闭")
            self.conn.execute("UPDATE recalls SET status = 'recovered' WHERE recall_id = ?",
                              (recall_id,))
            self.conn.execute("UPDATE components SET status = ? WHERE component_id = ?",
                              (DISCARDED, rec["component_id"]))
            self._event(now, "RECOVERED", component_id=rec["component_id"],
                        detail=f"追回单 {recall_id} 已退回,报废处理")

    def open_recalls(self):
        return list(self.conn.execute(
            "SELECT * FROM recalls WHERE status = 'open' ORDER BY recall_id"))

    # ---------------------------------------------------------------- 发放
    def issue(self, hospital, component_ids, now=None):
        """开发放单。待定/已过期/非在库成分一律拒发,整单原子生效。"""
        now = now or datetime.now()
        slip_id = "IS" + uuid.uuid4().hex[:10].upper()
        with _tx(self.conn):
            rows = []
            for cid in component_ids:
                row = self.conn.execute(
                    "SELECT * FROM components WHERE component_id = ?", (cid,)).fetchone()
                if not row:
                    raise UnknownComponent(cid)
                if row["status"] == PENDING:
                    raise ComponentPending(f"{cid} 初复检不符待定中,禁止发放")
                if row["status"] != AVAILABLE:
                    raise ComponentUnavailable(f"{cid} 状态 {row['status']} 不可发放")
                if _parse(row["expires_at"]) <= _parse(_iso(now)):
                    raise ComponentExpired(f"{cid} 已过效期 {row['expires_at'][:10]}")
                rows.append(row)
            self.conn.execute(
                "INSERT INTO issue_slips(slip_id, hospital, issued_at) VALUES (?,?,?)",
                (slip_id, hospital, _iso(now)))
            for row in rows:
                cid = row["component_id"]
                self.conn.execute("UPDATE components SET status = ? WHERE component_id = ?",
                                  (ISSUED, cid))
                self.conn.execute(
                    "INSERT INTO issue_lines(slip_id, component_id) VALUES (?,?)",
                    (slip_id, cid))
                self._event(now, "ISSUED", row["donation_code"], cid,
                            f"发放单 {slip_id} → [{hospital}]")
        return slip_id

    def allocate(self, ctype, blood_type, qty, now=None):
        """按效期先到期先出(FEFO)挑选可发成分,供开单参考。"""
        now = _iso(now or datetime.now())
        return [r["component_id"] for r in self.conn.execute(
            "SELECT component_id FROM components"
            " WHERE ctype = ? AND blood_type = ? AND status = ? AND expires_at > ?"
            " ORDER BY expires_at LIMIT ?",
            (ctype, blood_type, AVAILABLE, now, qty))]

    # ---------------------------------------------------------------- 效期
    def expire_passed(self, now=None):
        """效期巡检:过期的在库/待定成分转为已过期。返回处理数量。"""
        now = _iso(now or datetime.now())
        rows = list(self.conn.execute(
            "SELECT component_id, donation_code FROM components"
            " WHERE status IN (?, ?) AND expires_at <= ?",
            (AVAILABLE, PENDING, now)))
        with _tx(self.conn):
            for r in rows:
                self.conn.execute("UPDATE components SET status = ? WHERE component_id = ?",
                                  (EXPIRED, r["component_id"]))
                self._event(now, "EXPIRED", r["donation_code"], r["component_id"], "效期已过")
        return len(rows)

    # ---------------------------------------------------------------- 库存
    def inventory(self, in_stock_only=True):
        """血库存量,按成分+效期分组显示。"""
        sql = ("SELECT ctype, blood_type, status, expires_at, COUNT(*) AS qty"
               " FROM components")
        if in_stock_only:
            sql += f" WHERE status IN ('{AVAILABLE}', '{PENDING}')"
        sql += " GROUP BY ctype, blood_type, status, expires_at ORDER BY ctype, expires_at"
        return list(self.conn.execute(sql))

    def reconciliation(self, donation_code):
        """按献血码对账:每一袋成分的发放单/追回情况。"""
        return list(self.conn.execute(
            "SELECT c.component_id, c.ctype, c.status, il.slip_id, s.hospital,"
            "       il.status AS line_status, r.recall_id, r.status AS recall_status"
            " FROM components c"
            " LEFT JOIN issue_lines il ON il.component_id = c.component_id"
            " LEFT JOIN issue_slips s ON s.slip_id = il.slip_id"
            " LEFT JOIN recalls r ON r.component_id = c.component_id"
            " WHERE c.donation_code = ? ORDER BY c.component_id",
            (donation_code,)))

    # ---------------------------------------------------------------- 离线合并
    def merge_batch(self, batch, now=None, _fail_after=None):
        """离线批次回站合并。

        - 按献血码幂等合并:重复上传整批/单条都不重复建成分
        - 每条记录一个事务并记断点,中断后重新调用即可续传
        - _fail_after: 测试用,处理 N 条后模拟断电
        """
        now = now or datetime.now()
        batch_id = batch["batch_id"]
        site_id = batch.get("site_id", "")
        records = batch["records"]

        run = self.conn.execute("SELECT * FROM merge_runs WHERE batch_id = ?",
                                (batch_id,)).fetchone()
        if run and run["status"] == "done":
            return {"status": "duplicate", "processed": 0, "total": len(records)}
        if not run:
            with _tx(self.conn):
                self.conn.execute(
                    "INSERT INTO merge_runs(batch_id, site_id, total, processed, status)"
                    " VALUES (?,?,?,0,'running')", (batch_id, site_id, len(records)))
                self._event(now, "MERGE_START",
                            detail=f"批次 {batch_id} 来自[{site_id}],共 {len(records)} 条")

        processed = 0
        for i, rec in enumerate(records):
            key = f"{i:05d}:{rec['type']}:{rec.get('donation_code', '')}"
            done = self.conn.execute(
                "SELECT 1 FROM merge_records WHERE batch_id = ? AND record_key = ?",
                (batch_id, key)).fetchone()
            if done:
                continue  # 断点续传:已处理的跳过
            if _fail_after is not None and processed >= _fail_after:
                with _tx(self.conn):
                    self.conn.execute(
                        "UPDATE merge_runs SET status = 'interrupted' WHERE batch_id = ?",
                        (batch_id,))
                raise MergeInterrupted(batch_id, i, len(records))
            with _tx(self.conn):
                outcome = self._apply_record(rec, site_id, batch_id, now)
                self.conn.execute(
                    "INSERT INTO merge_records(batch_id, record_key, outcome) VALUES (?,?,?)",
                    (batch_id, key, outcome))
                self.conn.execute(
                    "UPDATE merge_runs SET processed = processed + 1 WHERE batch_id = ?",
                    (batch_id,))
            processed += 1

        with _tx(self.conn):
            self.conn.execute("UPDATE merge_runs SET status = 'done' WHERE batch_id = ?",
                              (batch_id,))
            self._event(now, "MERGE_DONE", detail=f"批次 {batch_id} 合并完成")
        return {"status": "done", "processed": processed, "total": len(records)}

    def _apply_record(self, rec, site_id, batch_id, now):
        t = rec["type"]
        code = rec.get("donation_code")
        if t == "donation":
            return self.register_donation(
                code, rec["donor_name"], rec["blood_type_initial"], rec["collected_at"],
                site_id=rec.get("site_id", site_id), now=now, source_batch=batch_id)
        if t == "prepare":
            return "prepared" if self.prepare_components(code, now=now) else "already_prepared"
        if t == "recheck":
            return "recheck_" + self.receive_recheck(code, rec["blood_type_recheck"], now=now)
        if t == "resolve":
            self.resolve_recheck(code, rec["conclusion"], now=now,
                                 new_blood_type=rec.get("new_blood_type"))
            return "resolved"
        raise ValueError(f"未知离线记录类型: {t}")

    # ---------------------------------------------------------------- 查询
    def conflicts(self):
        return list(self.conn.execute("SELECT * FROM conflicts ORDER BY id"))

    def component(self, component_id):
        return self.conn.execute(
            "SELECT * FROM components WHERE component_id = ?", (component_id,)).fetchone()

    def components_of(self, donation_code):
        return list(self.conn.execute(
            "SELECT * FROM components WHERE donation_code = ? ORDER BY component_id",
            (donation_code,)))
