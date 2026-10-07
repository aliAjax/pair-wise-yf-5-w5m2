# 血品账（献血-制备-发放 一体化台账）

献血车离线作业、回站补录；初检与复检结果先后到达。本系统把**献血登记、成分制备、血库发放**接成一份血品账，覆盖待定禁发、复检结论变更重算与追回、离线合并幂等续传、撞码冲突登记、按成分与效期显示库存。

## 运行

```bash
npm install
npm start      # http://localhost:3000 （PORT / DATA_DIR 可配）
npm test       # 业务场景自动化测试（临时目录，自动清理）
```

零原生依赖：Express + [sql.js](https://github.com/sql-js/sql.js)（WASM 版 SQLite，真实唯一约束与事务），数据原子落盘到 `data/blood-ledger.db`。

## 业务规则 → 代码

| 业务规则 | 实现 |
| --- | --- |
| 一袋全血拆红细胞、血浆、血小板，各记效期 | `COMPONENT_DEFS`：红细胞 35 天、血浆 365 天、血小板 5 天，从采血日起算 |
| 初检复检对不上 → 待定，不许发医院 | 制备时 `componentStatusAtPrep` 判 `pending`；发放校验拦截 `pending/invalid/expired/recalled` 及无复检结论 |
| 复检结论一变：未发部分按新结论重算 | `applyTestConclusion`：相符 → `valid`，不符 → `invalid`（记原因） |
| 复检结论一变：已发部分按发放单对账追回 | 对每条 `issue_items` 生成 `recalls`（含医院、发放单、数量、原因），追回后可对账 |
| 两个采血点提交同一献血码：只收先登记的，晚到列冲突 | `donations.donation_code` 全局唯一；先 SELECT 查重，撞码写 `conflicts` 并返回冲突标记（在线 409 / 离线 `conflict`） |
| 离线记录回站按献血码合并 | `POST /api/merge/batches`，按 `donation_code` 落库 |
| 合并中断能接着重试 | 批次 + 记录两级幂等键；`pending` 记录重试时续做，已完成记录跳过 |
| 重复上传不重复建成分 | `components` 上 `UNIQUE(donation_id, type)`；重复制备返回 `duplicated` |
| 库存按成分和效期显示 | `GET /api/inventory` 按 `type + expiry_date + status` 分组，标过期 |

## 接口

- `GET /api/summary` 总览；`GET /api/inventory` 库存
- `GET/POST /api/donations`、`GET /api/donations/:id`
- `POST /api/donations/:id/prepare` 制备成分
- `POST /api/donations/:id/test-results` 录入复检结论（触发重算/追回）
- `POST /api/merge/batches` 离线批次合并；`GET /api/merge/batches` 批次与记录
- `GET/POST /api/issues` 发放；`GET /api/issues/:id`
- `GET /api/recalls`、`POST /api/recalls/:id/reconcile` 追回对账
- `GET /api/conflicts` 冲突列表
