"""端到端演示:采血车离线作业 -> 回站合并 -> 制备 -> 发放 -> 复检追回 -> 库存。

运行: python3 demo.py
"""

import os
import tempfile
from datetime import datetime

from bloodledger import BloodLedger, MergeInterrupted

NOW = datetime(2026, 10, 7, 12, 0, 0)


def show(led, title):
    print(f"\n=== {title} ===")


def main():
    path = os.path.join(tempfile.mkdtemp(), "blood.db")
    led = BloodLedger.open(path)

    # 1. 两辆采血车下乡,离线记录,回站后按批次合并
    show(led, "1. 采血车1 回站合并(模拟传到一半断电,续传)")
    batch1 = {
        "batch_id": "che1-20261007", "site_id": "采血车1",
        "records": [
            {"type": "donation", "donation_code": "D1001", "donor_name": "张三",
             "blood_type_initial": "A+", "collected_at": "2026-10-01T09:00:00"},
            {"type": "donation", "donation_code": "D1002", "donor_name": "李四",
             "blood_type_initial": "B+", "collected_at": "2026-10-01T10:00:00"},
            {"type": "prepare", "donation_code": "D1001"},
            {"type": "prepare", "donation_code": "D1002"},
        ],
    }
    try:
        led.merge_batch(batch1, now=NOW, _fail_after=2)   # 模拟离线合并中断
    except MergeInterrupted as e:
        print(f"  中断: {e}")
    r = led.merge_batch(batch1, now=NOW)                  # 接着重试
    print(f"  续传结果: {r}")

    show(led, "2. 采血车2 回站合并(D1001 与车1撞码 -> 只收先登记的,晚到列冲突)")
    batch2 = {
        "batch_id": "che2-20261007", "site_id": "采血车2",
        "records": [
            {"type": "donation", "donation_code": "D1001", "donor_name": "王五",
             "blood_type_initial": "O+", "collected_at": "2026-10-02T09:00:00"},
            {"type": "donation", "donation_code": "D1003", "donor_name": "赵六",
             "blood_type_initial": "AB+", "collected_at": "2026-10-02T11:00:00"},
            {"type": "prepare", "donation_code": "D1003"},
        ],
    }
    print(f"  合并结果: {led.merge_batch(batch2, now=NOW)}")
    print(f"  重复上传车1批次: {led.merge_batch(batch1, now=NOW)}")
    for c in led.conflicts():
        print(f"  冲突: 献血码 {c['donation_code']} 采血点[{c['site_id']}] {c['reason']}")

    show(led, "3. 血库存量(按成分+效期)")
    for r in led.inventory():
        print(f"  {r['ctype']:<7} {r['blood_type']:<4} {r['status']:<10} 效期 {r['expires_at'][:10]}  x{r['qty']}")

    show(led, "4. 发放:市一医院 取 D1001 红细胞、D1002 红细胞")
    slip = led.issue("市一医院", ["D1001-RBC", "D1002-RBC"], now=NOW)
    print(f"  发放单 {slip}")

    show(led, "5. 复检结果晚到:D1001 初检 A+ / 复检 A- -> 未发出的挂待定,禁发")
    print(f"  复检结果: {led.receive_recheck('D1001', 'A-', now=NOW)}")
    try:
        led.issue("市二医院", ["D1001-PLASMA"], now=NOW)
    except Exception as e:
        print(f"  尝试发 D1001-PLASMA 被拒: {e}")

    show(led, "6. 复检结论变更:不合格 -> 未发的失效,已发的凭发放单追回")
    led.resolve_recheck("D1001", "invalid", now=NOW)
    for r in led.open_recalls():
        print(f"  追回单#{r['recall_id']}: 成分 {r['component_id']} 凭发放单 {r['slip_id']}"
              f" 向[{r['hospital']}]追回 ({r['reason']})")
    led.confirm_recall(1, now=NOW)
    print("  医院已退回,追回闭环")

    show(led, "7. D1001 一袋血的全程流水账")
    for e in led.ledger("D1001"):
        print(f"  {e['at'][:19]}  {e['kind']:<18} {e['component_id'] or '':<14} {e['detail']}")

    show(led, "8. 最终库存")
    for r in led.inventory(in_stock_only=False):
        print(f"  {r['ctype']:<7} {r['blood_type']:<4} {r['status']:<10} 效期 {r['expires_at'][:10]}  x{r['qty']}")


if __name__ == "__main__":
    main()
