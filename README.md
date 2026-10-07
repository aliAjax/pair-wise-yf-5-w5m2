# 血品账 bloodledger

献血登记 → 成分制备 → 血库发放的一体化台账。面向"采血车郊区离线作业、回站补录、
复检结果晚到"的实际场景。纯 Python 标准库 + SQLite,无需联网装依赖。

## 需求 → 实现对照

| 业务需求 | 实现 |
| --- | --- |
| 一袋全血拆红细胞/血浆/血小板,各自记效期 | `prepare_components`:按献血码建 3 个成分,效期 = 采血时刻 + 各成分保质期(红细胞 35 天 / 血浆 365 天 / 血小板 5 天,`SHELF_LIFE_DAYS` 可调) |
| 初检和复检对不上的成分先挂待定,不许发 | `receive_recheck` 不符 → 未发出成分转 `PENDING`;`issue` 对待定成分直接拒发 |
| 复检结论一变,没发出去的按新结论失效重算 | `resolve_recheck`:`invalid` → 未发的报废失效;`correct` → 按新血型订正并重算效期;`confirm` → 解除待定 |
| 已经发出去的拿发放单对账追回 | 结论变更时对 `ISSUED` 成分自动生成追回单,关联发放单号与医院;`reconciliation` 按献血码对账;`confirm_recall` 医院退回后闭环报废 |
| 两个采血点同时提交同一献血码,只收先登记的,晚到列冲突 | `donations` 主键即献血码,先提交的事务胜出(SQLite 串行写 + busy_timeout);晚到的进 `conflicts` 表;同人同数据重复上传算 `duplicate` 幂等合并,不报冲突 |
| 离线记录回站按献血码合并,中断能接着重试 | `merge_batch`:每条记录一个事务 + `merge_records` 断点;中断后重调自动跳过已处理记录 |
| 重复上传不重复建成分 | 整批重传:`merge_runs` 已完成直接跳过;单条重传:成分表 `UNIQUE(donation_code, ctype)` + `INSERT OR IGNORE` |
| 血库存量按成分和效期显示 | `inventory`:按 成分 × 血型 × 状态 × 效期 分组;`allocate` 按效期先到期先出(FEFO) |

## 快速开始

```bash
python3 -m unittest discover -s tests   # 16 个业务规则测试
python3 demo.py                          # 端到端演示完整故事
```

## CLI

```bash
# 登记(离线回站补录,--now 可指定业务时间)
python3 -m bloodledger.cli register D1001 --donor 张三 --type A+ \
    --site 采血车1 --collected-at 2026-10-01T09:00:00

python3 -m bloodledger.cli prepare D1001                 # 成分制备
python3 -m bloodledger.cli issue --hospital 市一医院 --component D1001-RBC
python3 -m bloodledger.cli recheck D1001 --type A-       # 复检不符→待定
python3 -m bloodledger.cli resolve D1001 --conclusion invalid   # 结论变更→失效+追回
python3 -m bloodledger.cli merge batch.json              # 离线批次合并(可续传)
python3 -m bloodledger.cli inventory                     # 库存(成分×效期)
python3 -m bloodledger.cli conflicts                     # 同码冲突
python3 -m bloodledger.cli recalls                       # 待追回
python3 -m bloodledger.cli reconcile D1001               # 按献血码对账
python3 -m bloodledger.cli ledger D1001                  # 一袋血的全程流水
```

离线批次 JSON 格式见 `demo.py`;记录类型:`donation` / `prepare` / `recheck` / `resolve`。

## 成分状态机

```
AVAILABLE(可发) ──issue──> ISSUED(已发) ──结论变更──> RECALLED(追回中) ──退回──> DISCARDED
    │  ▲                        ▲
    │  └confirm/correct─────────┘(未发的按新结论失效重算)
    ├─复检不符─> PENDING(待定,禁发) ─invalid─> DISCARDED
    └─效期巡检─> EXPIRED
```

每一步都写 `events` 流水,`ledger <献血码>` 可倒出整袋血的账。
