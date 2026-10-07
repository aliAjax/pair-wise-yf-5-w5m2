// 核心业务逻辑：献血登记、离线合并、成分制备、复检结论、发放、追回、库存。
import crypto from 'node:crypto';
import { all, get, run, withTransaction, now, today, addDays } from './db.mjs';

const uuid = () => crypto.randomUUID();

// 成分定义：一袋全血拆三成分，各自记效期（从采血日起算）。
export const COMPONENT_DEFS = {
  red_cells: { name: '红细胞', shelfDays: 35, quantity: 1 },
  plasma:    { name: '血浆',   shelfDays: 365, quantity: 1 },
  platelets: { name: '血小板', shelfDays: 5,   quantity: 1 },
};

const BLOOD_TYPES = ['A', 'B', 'O', 'AB'];

// 业务错误：HTTP 层据此返回 4xx。
export class BizError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ============ 献血登记 ============

function validateDonationPayload(p) {
  if (!p || typeof p !== 'object') throw new BizError(400, '缺少献血记录内容');
  if (!p.donation_code || !String(p.donation_code).trim()) throw new BizError(400, '献血码不能为空');
  if (!p.collection_point || !String(p.collection_point).trim()) throw new BizError(400, '采血点不能为空');
  if (!p.collected_at) throw new BizError(400, '采血日期不能为空');
  if (p.initial_blood_type && !BLOOD_TYPES.includes(p.initial_blood_type)) {
    throw new BizError(400, `初检血型必须是 ${BLOOD_TYPES.join('/')}`);
  }
}

// 在线登记：献血码全局唯一，先到先得；撞码 → 事务内登记冲突并返回标记，
// 由 HTTP 层转 409（不能抛异常，否则 withTransaction 回滚会把冲突记录一起回滚）。
export function registerDonation(payload) {
  return withTransaction(() => {
    validateDonationPayload(payload);
    const code = String(payload.donation_code).trim();
    const existing = get('SELECT id FROM donations WHERE donation_code = ?', [code]);
    if (existing) {
      recordConflict({
        donation_code: code,
        rejected_donation_id: uuid(),
        donor_name: payload.donor_name || null,
        collection_point: String(payload.collection_point).trim(),
        reason: '两个采血点提交同一献血码，先登记的已收，本条晚到',
      });
      return { conflict: true, donation_code: code };
    }
    const id = uuid();
    try {
      run(
        `INSERT INTO donations (id, donation_code, donor_name, collection_point, collected_at, initial_blood_type, status, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'registered', 'online', ?)`,
        [id, code, payload.donor_name || null,
         String(payload.collection_point).trim(), payload.collected_at.slice(0, 10),
         payload.initial_blood_type || null, now()]
      );
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        recordConflict({
          donation_code: code,
          rejected_donation_id: id,
          donor_name: payload.donor_name || null,
          collection_point: String(payload.collection_point).trim(),
          reason: '两个采血点提交同一献血码，先登记的已收，本条晚到',
        });
        return { conflict: true, donation_code: code };
      }
      throw err;
    }
    return { conflict: false, id, donation_code: code, status: 'registered' };
  });
}

function recordConflict(c) {
  run(
    `INSERT INTO conflicts (id, donation_code, rejected_donation_id, donor_name, collection_point, reason, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), c.donation_code, c.rejected_donation_id, c.donor_name, c.collection_point, c.reason, now()]
  );
}

// ============ 离线合并 ============
// 采血点离线作业，回站按献血码合并。批次幂等：同一 batch_id 重复上传时，
// 已处理的记录跳过、未处理的继续，中断可重试，不重复建成分。

export function submitMergeBatch({ batch_id, client_id, records }) {
  if (!batch_id) throw new BizError(400, '缺少批次号 batch_id');
  if (!client_id) throw new BizError(400, '缺少客户端标识 client_id');
  if (!Array.isArray(records) || records.length === 0) throw new BizError(400, '批次记录为空');

  return withTransaction(() => {
    let batch = get('SELECT * FROM merge_batches WHERE id = ?', [batch_id]);
    if (!batch) {
      run(
        `INSERT INTO merge_batches (id, client_id, status, received_at) VALUES (?, ?, 'pending', ?)`,
        [batch_id, client_id, now()]
      );
      batch = { id: batch_id, status: 'pending' };
    }

    const results = [];
    let deferred = 0;
    for (const rec of records) {
      if (!rec.client_record_id) throw new BizError(400, '批次内记录缺少 client_record_id');
      // 幂等：同批次同 client_record_id 已处理过 → 跳过；
      // 但上次挂起（pending）的记录要接着重试，不能跳过。
      const existing = get('SELECT * FROM merge_records WHERE batch_id = ? AND client_record_id = ?',
        [batch_id, rec.client_record_id]);
      if (existing && existing.status !== 'pending') {
        results.push({ client_record_id: rec.client_record_id, status: existing.status, skipped: true });
        continue;
      }

      let outcome;
      try {
        if (rec.type === 'donation') outcome = applyDonationRecord(rec.payload);
        else if (rec.type === 'test_result') outcome = applyTestResultRecord(rec.payload);
        else outcome = { status: 'skipped', message: `未知记录类型 ${rec.type}` };
      } catch (err) {
        if (err instanceof BizError && err.status === 409) {
          outcome = { status: 'conflict', message: err.message };
        } else {
          throw err;
        }
      }

      if (existing) {
        run(
          `UPDATE merge_records SET payload = ?, status = ?, result = ? WHERE id = ?`,
          [JSON.stringify(rec.payload || {}), outcome.status, JSON.stringify(outcome), existing.id]
        );
      } else {
        run(
          `INSERT INTO merge_records (id, batch_id, client_record_id, record_type, payload, status, result, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuid(), batch_id, rec.client_record_id, rec.type, JSON.stringify(rec.payload || {}),
           outcome.status, JSON.stringify(outcome), now()]
        );
      }
      if (outcome.status === 'pending') deferred += 1;
      results.push({ client_record_id: rec.client_record_id, ...outcome });
    }

    const allRecords = all('SELECT status FROM merge_records WHERE batch_id = ?', [batch_id]);
    const pendingCount = allRecords.filter(r => r.status === 'pending').length;
    const summary = {
      total: allRecords.length,
      applied: allRecords.filter(r => r.status === 'applied').length,
      conflict: allRecords.filter(r => r.status === 'conflict').length,
      pending: pendingCount,
      skipped: allRecords.filter(r => r.status === 'skipped').length,
    };
    run(
      `UPDATE merge_batches SET status = ?, completed_at = ?, summary = ? WHERE id = ?`,
      [pendingCount > 0 ? 'pending' : 'completed', pendingCount > 0 ? null : now(),
       JSON.stringify(summary), batch_id]
    );
    return { batch_id, client_id, results, summary };
  });
}

// 合并一条献血记录：按献血码落库，撞码 → 冲突（晚到的列出冲突）。
function applyDonationRecord(payload) {
  validateDonationPayload(payload);
  const id = uuid();
  try {
    run(
      `INSERT INTO donations (id, donation_code, donor_name, collection_point, collected_at, initial_blood_type, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'registered', 'offline', ?)`,
      [id, String(payload.donation_code).trim(), payload.donor_name || null,
       String(payload.collection_point).trim(), payload.collected_at.slice(0, 10),
       payload.initial_blood_type || null, now()]
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      recordConflict({
        donation_code: String(payload.donation_code).trim(),
        rejected_donation_id: id,
        donor_name: payload.donor_name || null,
        collection_point: String(payload.collection_point).trim(),
        reason: '两个采血点提交同一献血码，先登记的已收，本条晚到（离线合并）',
      });
      return { status: 'conflict', message: `献血码 ${payload.donation_code} 已存在，晚到记录已列入冲突` };
    }
    throw err;
  }
  return { status: 'applied', donation_id: id, donation_code: payload.donation_code };
}

// 合并一条复检记录：献血码还没对上 → 挂起（pending），批次保持 pending，重试时续做。
function applyTestResultRecord(payload) {
  if (!payload || !payload.donation_code) throw new BizError(400, '复检记录缺少献血码');
  if (!payload.blood_type || !BLOOD_TYPES.includes(payload.blood_type)) {
    throw new BizError(400, `复检血型必须是 ${BLOOD_TYPES.join('/')}`);
  }
  const donation = get('SELECT * FROM donations WHERE donation_code = ?',
    [String(payload.donation_code).trim()]);
  if (!donation) {
    return { status: 'pending', message: `献血码 ${payload.donation_code} 尚未登记，复检记录挂起待重试` };
  }
  const result = applyTestConclusion(donation, payload.blood_type, payload.tested_at || now());
  return { status: 'applied', ...result };
}

// ============ 成分制备 ============
// 一袋全血拆成红细胞、血浆、血小板，每种成分各自记效期。
// UNIQUE(donation_id, type) 保证重复制备/重复上传不重复建成分。

export function prepareComponents(donationId) {
  return withTransaction(() => {
    const donation = get('SELECT * FROM donations WHERE id = ?', [donationId]);
    if (!donation) throw new BizError(404, '献血记录不存在');

    const existing = all('SELECT * FROM components WHERE donation_id = ?', [donationId]);
    if (existing.length > 0) {
      return { donation_id: donationId, components: existing, duplicated: true };
    }

    const test = get('SELECT * FROM test_results WHERE donation_id = ? AND is_current = 1', [donationId]);
    const components = [];
    for (const [type, def] of Object.entries(COMPONENT_DEFS)) {
      const expiry = addDays(donation.collected_at, def.shelfDays);
      const status = componentStatusAtPrep(donation, test, expiry);
      const comp = {
        id: uuid(),
        donation_id: donationId,
        type,
        batch_no: `${donation.donation_code}-${type}`,
        quantity: def.quantity,
        expiry_date: expiry,
        status,
        invalid_reason: status === 'invalid' ? mismatchReason(donation, test) : null,
        created_at: now(),
        updated_at: now(),
      };
      run(
        `INSERT INTO components (id, donation_id, type, batch_no, quantity, expiry_date, status, invalid_reason, issued_quantity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [comp.id, comp.donation_id, comp.type, comp.batch_no, comp.quantity, comp.expiry_date,
         comp.status, comp.invalid_reason, comp.created_at, comp.updated_at]
      );
      components.push(comp);
    }
    return { donation_id: donationId, components, duplicated: false };
  });
}

// 制备时状态：初检复检不符 → 待定；未有复检 → 待定；相符且未过期 → 合格。
function componentStatusAtPrep(donation, test, expiryDate) {
  if (!test) return 'pending';
  if (!donation.initial_blood_type) return 'pending';
  if (test.blood_type !== donation.initial_blood_type) return 'pending';
  if (expiryDate < today()) return 'expired';
  return 'valid';
}

function mismatchReason(donation, test) {
  return `复检血型 ${test.blood_type} 与初检 ${donation.initial_blood_type} 不符`;
}

// ============ 复检结论 ============
// 复检结论可能晚到、可能改结论。结论一变：
//  - 没发出去的成分按新结论重算（相符 → 合格，不符 → 失效）；
//  - 已发出去的成分按发放单生成追回任务，对账追回。

export function addTestResult(donationId, payload) {
  if (!payload || !payload.blood_type || !BLOOD_TYPES.includes(payload.blood_type)) {
    throw new BizError(400, `复检血型必须是 ${BLOOD_TYPES.join('/')}`);
  }
  return withTransaction(() => {
    const donation = get('SELECT * FROM donations WHERE id = ?', [donationId]);
    if (!donation) throw new BizError(404, '献血记录不存在');
    return applyTestConclusion(donation, payload.blood_type, payload.tested_at || now());
  });
}

function applyTestConclusion(donation, bloodType, testedAt) {
  const prev = get('SELECT MAX(conclusion_no) AS m FROM test_results WHERE donation_id = ?', [donation.id]);
  const conclusionNo = (prev && prev.m ? prev.m : 0) + 1;
  run('UPDATE test_results SET is_current = 0 WHERE donation_id = ?', [donation.id]);
  run(
    `INSERT INTO test_results (id, donation_id, blood_type, tested_at, conclusion_no, is_current, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [uuid(), donation.id, bloodType, testedAt.slice(0, 10), conclusionNo, now()]
  );

  const components = all('SELECT * FROM components WHERE donation_id = ?', [donation.id]);
  const invalidated = [];
  const released = [];
  const recallsCreated = [];

  for (const comp of components) {
    const def = COMPONENT_DEFS[comp.type];
    const remaining = comp.quantity - comp.issued_quantity;

    // 已发出的部分：按发放单逐单生成追回任务（已存在未结追回的不重复生成）。
    if (comp.issued_quantity > 0) {
      const items = all(
        `SELECT ii.*, i.hospital, i.issue_no FROM issue_items ii
         JOIN issues i ON i.id = ii.issue_id
         WHERE ii.component_id = ?`, [comp.id]);
      for (const item of items) {
        // 同一发放明细已有追回任务（待追回或已对账）的，不重复生成。
        const exists = get(
          `SELECT id FROM recalls WHERE component_id = ? AND issue_item_id = ?`,
          [comp.id, item.id]);
        if (exists) continue;
        const recall = {
          id: uuid(),
          component_id: comp.id,
          issue_id: item.issue_id,
          issue_item_id: item.id,
          quantity: item.quantity,
          reason: `复检结论变更为 ${bloodType}（初检 ${donation.initial_blood_type || '未知'}），需向 ${item.hospital} 追回发放单 ${item.issue_no} 上的 ${def.name}`,
          status: 'pending',
        };
        run(
          `INSERT INTO recalls (id, component_id, issue_id, issue_item_id, quantity, reason, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [recall.id, comp.id, recall.issue_id, recall.issue_item_id, recall.quantity, recall.reason, now()]
        );
        recallsCreated.push(recall);
      }
    }

    // 未发出的部分：按新结论重算。
    let newStatus;
    let invalidReason = null;
    if (comp.issued_quantity >= comp.quantity) {
      newStatus = 'recalled'; // 全量已发，进入追回
    } else if (donation.initial_blood_type && bloodType !== donation.initial_blood_type) {
      newStatus = 'invalid';
      invalidReason = `复检结论变更为 ${bloodType}，与初检 ${donation.initial_blood_type} 不符，按新结论失效`;
    } else if (comp.expiry_date < today()) {
      newStatus = 'expired';
    } else {
      newStatus = 'valid';
    }

    if (newStatus === 'invalid') invalidated.push({ component_id: comp.id, type: comp.type, reason: invalidReason });
    if (newStatus === 'valid' && comp.status !== 'valid') released.push({ component_id: comp.id, type: comp.type });

    run(
      `UPDATE components SET status = ?, invalid_reason = ?, updated_at = ? WHERE id = ?`,
      [newStatus, invalidReason, now(), comp.id]
    );
  }

  return {
    donation_id: donation.id,
    conclusion_no: conclusionNo,
    blood_type: bloodType,
    components_reevaluated: components.length,
    invalidated,
    released,
    recalls_created: recallsCreated,
  };
}

// ============ 血库发放 ============
// 待定/失效/过期/追回中的成分不许发给医院；发放扣减库存，发完标记已发放。

export function createIssue({ hospital, items }) {
  if (!hospital || !String(hospital).trim()) throw new BizError(400, '医院不能为空');
  if (!Array.isArray(items) || items.length === 0) throw new BizError(400, '发放明细为空');

  return withTransaction(() => {
    // 先逐行校验，全部通过才落库（任一失败整单回滚）。
    const checked = [];
    for (const it of items) {
      if (!it.component_id) throw new BizError(400, '明细缺少 component_id');
      const qty = Number(it.quantity);
      if (!Number.isInteger(qty) || qty <= 0) throw new BizError(400, '发放数量必须为正整数');
      const comp = get('SELECT * FROM components WHERE id = ?', [it.component_id]);
      if (!comp) throw new BizError(404, `成分 ${it.component_id} 不存在`);
      const donation = get('SELECT * FROM donations WHERE id = ?', [comp.donation_id]);
      const test = get('SELECT * FROM test_results WHERE donation_id = ? AND is_current = 1', [comp.donation_id]);
      const defName = COMPONENT_DEFS[comp.type].name;

      if (!test) {
        throw new BizError(409, `${defName}（献血码 ${donation.donation_code}）尚无复检结果，待定，不许发放`);
      }
      if (comp.status === 'pending') {
        throw new BizError(409, `${defName}（献血码 ${donation.donation_code}）初检复检不符，挂待定，不许发放`);
      }
      if (comp.status === 'invalid') {
        throw new BizError(409, `${defName}（献血码 ${donation.donation_code}）已失效：${comp.invalid_reason || '复检不符'}`);
      }
      if (comp.status === 'recalled') {
        throw new BizError(409, `${defName}（献血码 ${donation.donation_code}）已在追回中，不许发放`);
      }
      if (comp.expiry_date < today()) {
        throw new BizError(409, `${defName}（献血码 ${donation.donation_code}）已过效期 ${comp.expiry_date}，不许发放`);
      }
      const remaining = comp.quantity - comp.issued_quantity;
      if (remaining <= 0) {
        throw new BizError(409, `${defName}（献血码 ${donation.donation_code}）库存已发完`);
      }
      if (qty > remaining) {
        throw new BizError(409, `${defName}（献血码 ${donation.donation_code}）库存仅剩 ${remaining}，不足发放 ${qty}`);
      }
      checked.push({ comp, qty });
    }

    const issueNo = `LY${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
    const issueId = uuid();
    run(
      `INSERT INTO issues (id, issue_no, hospital, issued_at, status, created_at) VALUES (?, ?, ?, ?, 'issued', ?)`,
      [issueId, issueNo, String(hospital).trim(), now(), now()]
    );
    for (const { comp, qty } of checked) {
      run(
        `INSERT INTO issue_items (id, issue_id, component_id, quantity) VALUES (?, ?, ?, ?)`,
        [uuid(), issueId, comp.id, qty]
      );
      const issued = comp.issued_quantity + qty;
      run(
        `UPDATE components SET issued_quantity = ?, status = ?, updated_at = ? WHERE id = ?`,
        [issued, issued >= comp.quantity ? 'issued' : 'valid', now(), comp.id]
      );
    }
    return getIssue(issueId);
  });
}

export function getIssue(issueId) {
  const issue = get('SELECT * FROM issues WHERE id = ?', [issueId]);
  if (!issue) throw new BizError(404, '发放单不存在');
  issue.items = all(
    `SELECT ii.*, c.type, c.batch_no, c.expiry_date, d.donation_code
     FROM issue_items ii
     JOIN components c ON c.id = ii.component_id
     JOIN donations d ON d.id = c.donation_id
     WHERE ii.issue_id = ?`, [issueId]);
  return issue;
}

// ============ 追回对账 ============

export function reconcileRecall(recallId, note) {
  return withTransaction(() => {
    const recall = get('SELECT * FROM recalls WHERE id = ?', [recallId]);
    if (!recall) throw new BizError(404, '追回任务不存在');
    if (recall.status === 'reconciled') throw new BizError(409, '该追回任务已对账');
    run(
      `UPDATE recalls SET status = 'reconciled', reconciled_at = ? WHERE id = ?`,
      [now(), recallId]
    );
    return get('SELECT * FROM recalls WHERE id = ?', [recallId]);
  });
}

// ============ 查询 ============

export function listDonations() {
  const donations = all('SELECT * FROM donations ORDER BY created_at DESC');
  for (const d of donations) {
    d.component_count = get('SELECT COUNT(*) AS c FROM components WHERE donation_id = ?', [d.id]).c;
    d.current_test = get('SELECT * FROM test_results WHERE donation_id = ? AND is_current = 1', [d.id]);
  }
  return donations;
}

export function getDonation(donationId) {
  const donation = get('SELECT * FROM donations WHERE id = ?', [donationId]);
  if (!donation) throw new BizError(404, '献血记录不存在');
  donation.components = all('SELECT * FROM components WHERE donation_id = ? ORDER BY type', [donationId]);
  donation.test_results = all('SELECT * FROM test_results WHERE donation_id = ? ORDER BY conclusion_no DESC', [donationId]);
  donation.issues = all(
    `SELECT i.*, ii.component_id, ii.quantity, c.type
     FROM issue_items ii
     JOIN issues i ON i.id = ii.issue_id
     JOIN components c ON c.id = ii.component_id
     WHERE c.donation_id = ? ORDER BY i.issued_at DESC`, [donationId]);
  return donation;
}

export function listComponents({ donation_id } = {}) {
  if (donation_id) {
    return all(
      `SELECT c.*, d.donation_code, d.collection_point FROM components c
       JOIN donations d ON d.id = c.donation_id
       WHERE c.donation_id = ? ORDER BY c.type`, [donation_id]);
  }
  return all(
    `SELECT c.*, d.donation_code, d.collection_point FROM components c
     JOIN donations d ON d.id = c.donation_id
     ORDER BY c.expiry_date, c.type`);
}

export function listIssues() {
  const issues = all('SELECT * FROM issues ORDER BY created_at DESC');
  for (const i of issues) {
    i.items = all(
      `SELECT ii.*, c.type, c.batch_no, d.donation_code
       FROM issue_items ii
       JOIN components c ON c.id = ii.component_id
       JOIN donations d ON d.id = c.donation_id
       WHERE ii.issue_id = ?`, [i.id]);
  }
  return issues;
}

export function listRecalls({ status } = {}) {
  let rows = all(
    `SELECT r.*, c.type, c.batch_no, d.donation_code, i.issue_no, i.hospital
     FROM recalls r
     JOIN components c ON c.id = r.component_id
     JOIN donations d ON d.id = c.donation_id
     JOIN issues i ON i.id = r.issue_id
     ORDER BY r.created_at DESC`);
  if (status) rows = rows.filter(r => r.status === status);
  return rows;
}

export function listConflicts() {
  return all('SELECT * FROM conflicts ORDER BY detected_at DESC');
}

export function listBatches() {
  const batches = all('SELECT * FROM merge_batches ORDER BY received_at DESC');
  for (const b of batches) {
    b.records = all('SELECT * FROM merge_records WHERE batch_id = ? ORDER BY created_at', [b.id]);
  }
  return batches;
}

// 血库存量：按成分 + 效期显示可用量。
export function getInventory() {
  const rows = all(
    `SELECT c.type, c.expiry_date, c.status,
            SUM(c.quantity - c.issued_quantity) AS available_qty,
            SUM(c.quantity) AS total_qty,
            COUNT(*) AS lot_count
     FROM components c
     GROUP BY c.type, c.expiry_date, c.status
     ORDER BY c.expiry_date, c.type`);
  const t = today();
  for (const r of rows) {
    r.type_name = COMPONENT_DEFS[r.type].name;
    r.expired = r.expiry_date < t;
  }
  return rows;
}

export function getSummary() {
  const donations = get('SELECT COUNT(*) AS c FROM donations').c;
  const components = get('SELECT COUNT(*) AS c FROM components').c;
  const pending = get("SELECT COUNT(*) AS c FROM components WHERE status = 'pending'").c;
  const invalid = get("SELECT COUNT(*) AS c FROM components WHERE status = 'invalid'").c;
  const issued = get("SELECT COUNT(*) AS c FROM components WHERE status = 'issued'").c;
  const issues = get('SELECT COUNT(*) AS c FROM issues').c;
  const recallsPending = get("SELECT COUNT(*) AS c FROM recalls WHERE status = 'pending'").c;
  const conflicts = get('SELECT COUNT(*) AS c FROM conflicts').c;
  return { donations, components, pending, invalid, issued, issues, recalls_pending: recallsPending, conflicts };
}
