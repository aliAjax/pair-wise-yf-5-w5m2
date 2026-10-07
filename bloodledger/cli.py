"""血品账命令行。

用法示例:
  python -m bloodledger.cli --db blood.db register D1001 --donor 张三 --type A+ \
      --site 采血车1 --collected-at 2026-10-01T09:00:00
  python -m bloodledger.cli --db blood.db prepare D1001
  python -m bloodledger.cli --db blood.db issue --hospital 市一医院 --component D1001-RBC
  python -m bloodledger.cli --db blood.db recheck D1001 --type A-
  python -m bloodledger.cli --db blood.db resolve D1001 --conclusion invalid
  python -m bloodledger.cli --db blood.db merge batch.json
  python -m bloodledger.cli --db blood.db inventory
"""

import argparse
import json
import sys
from datetime import datetime

from .service import (
    BloodLedger, CTYPE_NAMES, STATUS_NAMES,
    ComponentPending, ComponentUnavailable, ComponentExpired,
    UnknownComponent, UnknownDonation, MergeInterrupted,
)


def _now(args):
    return datetime.fromisoformat(args.now) if getattr(args, "now", None) else datetime.now()


def cmd_register(led, args):
    r = led.register_donation(args.code, args.donor, args.type, args.collected_at,
                              site_id=args.site, now=_now(args))
    print({"registered": f"已登记 {args.code}",
           "duplicate": f"{args.code} 为重复上传,已按献血码合并(不重复建账)",
           "conflict": f"{args.code} 已被先登记,本条列入冲突"}[r])


def cmd_prepare(led, args):
    created = led.prepare_components(args.code, now=_now(args))
    if created:
        for cid in created:
            c = led.component(cid)
            print(f"制备 {cid} [{CTYPE_NAMES[c['ctype']]}] 效期至 {c['expires_at'][:10]}")
    else:
        print(f"{args.code} 成分已存在,不重复制备")


def cmd_recheck(led, args):
    r = led.receive_recheck(args.code, args.type, now=_now(args))
    print({"consistent": f"{args.code} 复检 {args.type} 与初检一致",
           "mismatch": f"{args.code} 复检 {args.type} 与初检不符,未发出成分已挂待定,禁止发放"}[r])


def cmd_resolve(led, args):
    led.resolve_recheck(args.code, args.conclusion, now=_now(args),
                        new_blood_type=args.new_type)
    print(f"{args.code} 复检结论[{args.conclusion}]已生效,未发出的按新结论重算,已发出的凭发放单追回")


def cmd_issue(led, args):
    try:
        slip = led.issue(args.hospital, args.component, now=_now(args))
    except (ComponentPending, ComponentUnavailable, ComponentExpired,
            UnknownComponent) as e:
        print(f"发放被拒: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"发放单 {slip} → [{args.hospital}] {len(args.component)} 袋")


def cmd_expire(led, args):
    n = led.expire_passed(now=_now(args))
    print(f"效期巡检完成,{n} 袋过期")


def cmd_inventory(led, args):
    rows = led.inventory(in_stock_only=not args.all)
    print(f"{'成分':<6}{'血型':<6}{'状态':<6}{'效期':<12}数量")
    for r in rows:
        print(f"{CTYPE_NAMES[r['ctype']]:<6}{r['blood_type']:<6}"
              f"{STATUS_NAMES[r['status']]:<6}{r['expires_at'][:10]:<12}{r['qty']}")


def cmd_merge(led, args):
    with open(args.file, encoding="utf-8") as f:
        batch = json.load(f)
    try:
        r = led.merge_batch(batch, now=_now(args))
    except MergeInterrupted as e:
        print(f"合并中断: {e}", file=sys.stderr)
        sys.exit(2)
    print({"done": f"批次 {batch['batch_id']} 合并完成,本次处理 {r['processed']}/{r['total']} 条",
           "duplicate": f"批次 {batch['batch_id']} 已合并过,跳过(不重复建成分)"}[r["status"]])


def cmd_conflicts(led, args):
    for c in led.conflicts():
        print(f"#{c['id']} 献血码 {c['donation_code']} 采血点[{c['site_id']}] "
              f"{c['reason']} 内容:{c['payload']}")
    if not led.conflicts():
        print("无冲突")


def cmd_recalls(led, args):
    for r in led.open_recalls():
        print(f"追回单#{r['recall_id']} 成分 {r['component_id']} 凭发放单 {r['slip_id']} "
              f"向[{r['hospital']}]追回: {r['reason']}")
    if not led.open_recalls():
        print("无待追回")


def cmd_confirm_recall(led, args):
    led.confirm_recall(args.recall_id, now=_now(args))
    print(f"追回单#{args.recall_id} 已退回,成分报废")


def cmd_reconcile(led, args):
    print(f"{'成分':<16}{'状态':<8}{'发放单':<14}{'医院':<10}{'追回'}")
    for r in led.reconciliation(args.code):
        print(f"{r['component_id']:<16}{STATUS_NAMES[r['status']]:<8}"
              f"{r['slip_id'] or '-':<14}{r['hospital'] or '-':<10}"
              f"{r['recall_status'] or '-'}")


def cmd_ledger(led, args):
    for e in led.ledger(args.code):
        print(f"{e['at'][:19]}  {e['kind']:<20} {e['component_id'] or '':<16} {e['detail']}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="bloodledger", description="血品账:登记-制备-发放一体化台账")
    p.add_argument("--db", default="bloodledger.db", help="SQLite 数据库路径")
    p.add_argument("--now", help="以指定时间运行(ISO 格式),便于补录/演示")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("register", help="献血登记")
    s.add_argument("code"); s.add_argument("--donor", required=True)
    s.add_argument("--type", required=True, help="初检血型")
    s.add_argument("--site", default="", help="采血点")
    s.add_argument("--collected-at", required=True)
    s.set_defaults(fn=cmd_register)

    s = sub.add_parser("prepare", help="成分制备(全血拆红细胞/血浆/血小板)")
    s.add_argument("code"); s.set_defaults(fn=cmd_prepare)

    s = sub.add_parser("recheck", help="录入复检结果")
    s.add_argument("code"); s.add_argument("--type", required=True)
    s.set_defaults(fn=cmd_recheck)

    s = sub.add_parser("resolve", help="复检结论变更生效")
    s.add_argument("code")
    s.add_argument("--conclusion", required=True, choices=["confirm", "correct", "invalid"])
    s.add_argument("--new-type", help="conclusion=correct 时的订正血型")
    s.set_defaults(fn=cmd_resolve)

    s = sub.add_parser("issue", help="开发放单")
    s.add_argument("--hospital", required=True)
    s.add_argument("--component", required=True, nargs="+")
    s.set_defaults(fn=cmd_issue)

    s = sub.add_parser("expire", help="效期巡检"); s.set_defaults(fn=cmd_expire)
    s = sub.add_parser("inventory", help="血库存量(按成分+效期)")
    s.add_argument("--all", action="store_true", help="含已发放/报废等全部状态")
    s.set_defaults(fn=cmd_inventory)

    s = sub.add_parser("merge", help="离线批次回站合并(断点续传)")
    s.add_argument("file"); s.set_defaults(fn=cmd_merge)

    s = sub.add_parser("conflicts", help="同码冲突列表"); s.set_defaults(fn=cmd_conflicts)
    s = sub.add_parser("recalls", help="待追回列表"); s.set_defaults(fn=cmd_recalls)

    s = sub.add_parser("confirm-recall", help="医院退回确认")
    s.add_argument("recall_id", type=int); s.set_defaults(fn=cmd_confirm_recall)

    s = sub.add_parser("reconcile", help="按献血码对账")
    s.add_argument("code"); s.set_defaults(fn=cmd_reconcile)

    s = sub.add_parser("ledger", help="一袋血的全程流水账")
    s.add_argument("code"); s.set_defaults(fn=cmd_ledger)

    args = p.parse_args(argv)
    led = BloodLedger.open(args.db)
    try:
        args.fn(led, args)
    except (UnknownDonation, UnknownComponent) as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
