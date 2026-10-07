"""血品账规则测试:逐条对应业务需求。"""

import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta

from bloodledger import BloodLedger, MergeInterrupted
from bloodledger.service import (
    ComponentPending, ComponentExpired, ComponentUnavailable,
    AVAILABLE, PENDING, ISSUED, RECALLED, DISCARDED, EXPIRED,
)

NOW = datetime(2026, 10, 7, 12, 0, 0)
COLLECTED = "2026-10-01T09:00:00"


class LedgerTestCase(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        os.unlink(self.path)
        self.led = BloodLedger.open(self.path)

    def tearDown(self):
        self.led.conn.close()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(self.path + suffix)
            except OSError:
                pass

    def _register(self, code="D1001", site="采血车1", btype="A+", donor="张三"):
        return self.led.register_donation(code, donor, btype, COLLECTED,
                                          site_id=site, now=NOW)

    def _prepare(self, code="D1001"):
        self._register(code)
        return self.led.prepare_components(code, now=NOW)

    # 一袋全血拆成红细胞、血浆和血小板后,每种成分各自记效期
    def test_prepare_splits_with_own_expiry(self):
        created = self._prepare()
        self.assertEqual(sorted(created), ["D1001-PLASMA", "D1001-PLT", "D1001-RBC"])
        exp = {c["ctype"]: c["expires_at"] for c in self.led.components_of("D1001")}
        base = datetime(2026, 10, 1, 9, 0, 0)
        self.assertEqual(exp["RBC"], (base + timedelta(days=35)).isoformat())
        self.assertEqual(exp["PLASMA"], (base + timedelta(days=365)).isoformat())
        self.assertEqual(exp["PLT"], (base + timedelta(days=5)).isoformat())

    # 初检和复检对不上的成分先挂待定,不许发给医院
    def test_recheck_mismatch_holds_pending_and_blocks_issue(self):
        self._prepare()
        self.assertEqual(self.led.receive_recheck("D1001", "A-", now=NOW), "mismatch")
        for c in self.led.components_of("D1001"):
            self.assertEqual(c["status"], PENDING)
        with self.assertRaises(ComponentPending):
            self.led.issue("市一医院", ["D1001-RBC"], now=NOW)

    # 复检结论一变,没发出去的部分按新结论失效重算
    def test_invalid_conclusion_discards_unissued(self):
        self._prepare()
        self.led.receive_recheck("D1001", "A-", now=NOW)
        self.led.resolve_recheck("D1001", "invalid", now=NOW)
        for c in self.led.components_of("D1001"):
            self.assertEqual(c["status"], DISCARDED)
            self.assertEqual(c["expires_at"], NOW.replace(microsecond=0).isoformat())

    # 已经发出去的拿发放单对账追回
    def test_invalid_conclusion_recalls_issued_via_slip(self):
        self._prepare()
        slip = self.led.issue("市一医院", ["D1001-RBC"], now=NOW)
        self.led.receive_recheck("D1001", "A-", now=NOW)
        self.led.resolve_recheck("D1001", "invalid", now=NOW)

        rbc = self.led.component("D1001-RBC")
        self.assertEqual(rbc["status"], RECALLED)
        recalls = self.led.open_recalls()
        self.assertEqual(len(recalls), 1)
        self.assertEqual(recalls[0]["slip_id"], slip)          # 凭发放单对账
        self.assertEqual(recalls[0]["hospital"], "市一医院")
        # 未发出的两个成分失效
        self.assertEqual(self.led.component("D1001-PLT")["status"], DISCARDED)
        self.assertEqual(self.led.component("D1001-PLASMA")["status"], DISCARDED)
        # 医院退回后闭环报废
        self.led.confirm_recall(recalls[0]["recall_id"], now=NOW)
        self.assertEqual(self.led.component("D1001-RBC")["status"], DISCARDED)
        self.assertEqual(self.led.open_recalls(), [])

    # 复检结论订正血型:未发的按新结论重算,已发的追回
    def test_correct_conclusion_retypes_and_recalls(self):
        self._prepare()
        self.led.issue("市一医院", ["D1001-PLASMA"], now=NOW)
        self.led.receive_recheck("D1001", "A-", now=NOW)
        self.led.resolve_recheck("D1001", "correct", new_blood_type="A-", now=NOW)

        rbc = self.led.component("D1001-RBC")
        self.assertEqual(rbc["blood_type"], "A-")
        self.assertEqual(rbc["status"], AVAILABLE)             # 订正后恢复可发
        self.assertEqual(rbc["expires_at"],
                         (datetime(2026, 10, 1, 9) + timedelta(days=35)).isoformat())
        self.assertEqual(self.led.component("D1001-PLASMA")["status"], RECALLED)
        self.assertEqual(len(self.led.open_recalls()), 1)

    # 待定后复检确认初检 -> 解除待定
    def test_confirm_releases_pending(self):
        self._prepare()
        self.led.receive_recheck("D1001", "A-", now=NOW)
        self.led.resolve_recheck("D1001", "confirm", now=NOW)
        for c in self.led.components_of("D1001"):
            self.assertEqual(c["status"], AVAILABLE)

    # 两个采血点同时提交同一个献血码时只收先登记的那条,晚到的列出冲突
    def test_same_code_first_wins_late_conflicts(self):
        self.assertEqual(self._register("D2001", site="采血车1", donor="张三"), "registered")
        # 不同人抢同一码 -> 冲突
        r = self.led.register_donation("D2001", "王五", "O+", COLLECTED,
                                       site_id="采血车2", now=NOW)
        self.assertEqual(r, "conflict")
        don = self.led._donation("D2001")
        self.assertEqual(don["donor_name"], "张三")            # 先登记者有效
        self.assertEqual(don["site_id"], "采血车1")
        conflicts = self.led.conflicts()
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["site_id"], "采血车2")

    def test_same_code_concurrent_writers(self):
        def worker(site, donor, results):
            led = BloodLedger.open(self.path)
            try:
                results.append(led.register_donation(
                    "D2002", donor, "A+", COLLECTED, site_id=site, now=NOW))
            finally:
                led.conn.close()

        results = []
        threads = [threading.Thread(target=worker, args=(f"采血车{i}", f"献血者{i}", results))
                   for i in (1, 2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(results), ["conflict", "registered"])
        self.assertEqual(len(self.led.conflicts()), 1)

    # 同人同数据重复上传 -> 幂等合并,不算冲突
    def test_identical_reupload_is_duplicate_not_conflict(self):
        self._register("D2003")
        r = self._register("D2003")
        self.assertEqual(r, "duplicate")
        self.assertEqual(self.led.conflicts(), [])

    # 离线记录回站按献血码合并,合并中断能接着重试
    def test_merge_resume_after_interruption(self):
        batch = {
            "batch_id": "che1-20261007", "site_id": "采血车1",
            "records": [
                {"type": "donation", "donation_code": "D3001", "donor_name": "张三",
                 "blood_type_initial": "A+", "collected_at": COLLECTED},
                {"type": "donation", "donation_code": "D3002", "donor_name": "李四",
                 "blood_type_initial": "B+", "collected_at": COLLECTED},
                {"type": "prepare", "donation_code": "D3001"},
                {"type": "prepare", "donation_code": "D3002"},
            ],
        }
        with self.assertRaises(MergeInterrupted):
            self.led.merge_batch(batch, now=NOW, _fail_after=2)   # 模拟回站途中断电
        # 已处理的 2 条已落库
        self.assertEqual(self.led._donation("D3001")["donor_name"], "张三")
        # 接着重试:从断点续传
        r = self.led.merge_batch(batch, now=NOW)
        self.assertEqual(r["status"], "done")
        self.assertEqual(r["processed"], 2)                        # 只补剩下的
        self.assertEqual(len(self.led.components_of("D3001")), 3)
        self.assertEqual(len(self.led.components_of("D3002")), 3)

    # 重复上传不重复建成分
    def test_merge_idempotent_no_duplicate_components(self):
        batch = {
            "batch_id": "che1-20261007", "site_id": "采血车1",
            "records": [
                {"type": "donation", "donation_code": "D4001", "donor_name": "张三",
                 "blood_type_initial": "A+", "collected_at": COLLECTED},
                {"type": "prepare", "donation_code": "D4001"},
            ],
        }
        self.led.merge_batch(batch, now=NOW)
        r = self.led.merge_batch(batch, now=NOW)                   # 整批重传
        self.assertEqual(r["status"], "duplicate")
        self.assertEqual(len(self.led.components_of("D4001")), 3)
        # 换个批次号重传同样内容:按献血码合并,仍不重复
        batch2 = dict(batch, batch_id="che1-20261007-retry")
        self.led.merge_batch(batch2, now=NOW)
        self.assertEqual(len(self.led.components_of("D4001")), 3)
        self.assertEqual(self.led.conflicts(), [])

    # 离线合并中的同码冲突:先合并入站的登记有效,晚到的列出
    def test_merge_late_batch_conflicts(self):
        self._register("D5001", site="采血车1", donor="张三")
        batch = {
            "batch_id": "che2-20261007", "site_id": "采血车2",
            "records": [
                {"type": "donation", "donation_code": "D5001", "donor_name": "王五",
                 "blood_type_initial": "O+", "collected_at": COLLECTED},
            ],
        }
        self.led.merge_batch(batch, now=NOW)
        self.assertEqual(self.led._donation("D5001")["donor_name"], "张三")
        self.assertEqual(len(self.led.conflicts()), 1)

    # 血库存量按成分和效期显示
    def test_inventory_by_ctype_and_expiry(self):
        self._register("D6001", btype="A+")
        self.led.prepare_components("D6001", now=NOW)
        self.led.register_donation("D6002", "李四", "A+", "2026-10-03T09:00:00",
                                   site_id="采血车2", now=NOW)
        self.led.prepare_components("D6002", now=NOW)
        inv = {(r["ctype"], r["expires_at"]): r["qty"] for r in self.led.inventory()}
        self.assertEqual(inv[("RBC", "2026-11-05T09:00:00")], 1)   # D6001 的红细胞
        self.assertEqual(inv[("RBC", "2026-11-07T09:00:00")], 1)   # D6002 的红细胞
        self.assertEqual(inv[("PLT", "2026-10-06T09:00:00")], 1)
        self.assertEqual(sum(q for (t, _), q in inv.items() if t == "PLASMA"), 2)

    # 过期成分不许发,效期巡检转状态
    def test_expired_cannot_issue(self):
        self._prepare()
        later = NOW + timedelta(days=6)                            # 血小板(5天)已过期
        self.assertEqual(self.led.expire_passed(now=later), 1)
        self.assertEqual(self.led.component("D1001-PLT")["status"], EXPIRED)
        with self.assertRaises(ComponentUnavailable):
            self.led.issue("市一医院", ["D1001-PLT"], now=later)
        # 红细胞还在效期内,可以发
        self.led.issue("市一医院", ["D1001-RBC"], now=later)

    # 发放单对账视图
    def test_reconciliation_view(self):
        self._prepare()
        slip = self.led.issue("市一医院", ["D1001-RBC"], now=NOW)
        self.led.receive_recheck("D1001", "A-", now=NOW)
        self.led.resolve_recheck("D1001", "invalid", now=NOW)
        rec = {r["component_id"]: r for r in self.led.reconciliation("D1001")}
        self.assertEqual(rec["D1001-RBC"]["slip_id"], slip)
        self.assertEqual(rec["D1001-RBC"]["recall_status"], "open")
        self.assertIsNone(rec["D1001-PLT"]["slip_id"])

    # 一袋血的流水账完整可查
    def test_ledger_trail(self):
        self._prepare()
        self.led.issue("市一医院", ["D1001-RBC"], now=NOW)
        self.led.receive_recheck("D1001", "A-", now=NOW)
        self.led.resolve_recheck("D1001", "invalid", now=NOW)
        kinds = [e["kind"] for e in self.led.ledger("D1001")]
        self.assertEqual(kinds[0], "REGISTERED")
        self.assertIn("PREPARED", kinds)
        self.assertIn("ISSUED", kinds)
        self.assertIn("RECHECK_MISMATCH", kinds)
        self.assertIn("DISCARDED", kinds)
        self.assertIn("RECALLED", kinds)


if __name__ == "__main__":
    unittest.main()
