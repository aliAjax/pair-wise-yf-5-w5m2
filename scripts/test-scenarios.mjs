// 业务场景自动化测试：覆盖需求中的全部关键规则。
// 运行：npm test（会在临时目录启动服务，结束后自动清理）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3199;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blood-ledger-test-'));
const BASE = `http://localhost:${PORT}`;

const server = spawn('node', ['src/main.mjs'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR },
  stdio: 'ignore',
});

const api = async (p, opts = {}) => {
  const res = await fetch(BASE + p, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const waitReady = async () => {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务启动超时');
};

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
};

const run = async () => {
  await waitReady();
  console.log('\n场景 1：两个采血点提交同一献血码 → 只收先登记的，晚到列冲突');
  {
    const first = await api('/api/donations', { method: 'POST', body: {
      donation_code: 'X1', collection_point: '采血点A', collected_at: '2026-10-07', initial_blood_type: 'A' } });
    check('先登记成功', first.status === 200);
    const late = await api('/api/donations', { method: 'POST', body: {
      donation_code: 'X1', collection_point: '采血点B', collected_at: '2026-10-07' } });
    check('晚到返回 409', late.status === 409);
    const conflicts = (await api('/api/conflicts')).data;
    check('冲突已列出晚到采血点', conflicts.length === 1 && conflicts[0].collection_point === '采血点B');
  }

  console.log('\n场景 2：离线合并按献血码落库，重复上传幂等不重建');
  {
    const batch = { batch_id: 'B1', client_id: '采血车-03', records: [
      { client_record_id: 'r1', type: 'donation', payload: {
        donation_code: 'X2', collection_point: '采血车-03', collected_at: '2026-10-07', initial_blood_type: 'B' } },
    ] };
    const b1 = await api('/api/merge/batches', { method: 'POST', body: batch });
    check('批次首次合并成功', b1.data.summary.applied === 1);
    const b2 = await api('/api/merge/batches', { method: 'POST', body: batch });
    check('重复上传记录跳过', b2.data.results[0].skipped === true);
    check('汇总仍为 1 条已合并', b2.data.summary.applied === 1);
    const donations = (await api('/api/donations')).data;
    check('献血记录不重复', donations.filter((d) => d.donation_code === 'X2').length === 1);
  }

  console.log('\n场景 3：合并中断可重试——复检记录先挂起，献血码后到后续做');
  {
    const first = await api('/api/merge/batches', { method: 'POST', body: { batch_id: 'B2', client_id: '采血车-03', records: [
      { client_record_id: 'r1', type: 'test_result', payload: { donation_code: 'X3', blood_type: 'O' } },
    ] } });
    check('献血码未到 → 记录挂起 pending', first.data.results[0].status === 'pending');
    check('批次保持 pending', first.data.summary.pending === 1);

    await api('/api/donations', { method: 'POST', body: {
      donation_code: 'X3', collection_point: '采血点C', collected_at: '2026-10-07', initial_blood_type: 'O' } });

    const retry = await api('/api/merge/batches', { method: 'POST', body: { batch_id: 'B2', client_id: '采血车-03', records: [
      { client_record_id: 'r1', type: 'test_result', payload: { donation_code: 'X3', blood_type: 'O' } },
    ] } });
    check('重试后记录 applied', retry.data.results[0].status === 'applied');
    check('批次完成', retry.data.summary.pending === 0);

    const again = await api('/api/merge/batches', { method: 'POST', body: { batch_id: 'B2', client_id: '采血车-03', records: [
      { client_record_id: 'r1', type: 'test_result', payload: { donation_code: 'X3', blood_type: 'O' } },
    ] } });
    check('再次重复上传跳过', again.data.results[0].skipped === true);
  }

  console.log('\n场景 4：一袋全血拆三成分，各记各的效期；重复制备不重建');
  {
    const x1 = (await api('/api/donations')).data.find((d) => d.donation_code === 'X1');
    const p = await api(`/api/donations/${x1.id}/prepare`, { method: 'POST' });
    check('拆成 3 种成分', p.data.components.length === 3);
    const byType = Object.fromEntries(p.data.components.map((c) => [c.type, c]));
    check('红细胞效期 35 天', byType.red_cells.expiry_date === '2026-11-11');
    check('血浆效期 1 年', byType.plasma.expiry_date === '2027-10-07');
    check('血小板效期 5 天', byType.platelets.expiry_date === '2026-10-12');
    check('无复检结论 → 待定', byType.red_cells.status === 'pending');
    const p2 = await api(`/api/donations/${x1.id}/prepare`, { method: 'POST' });
    check('重复制备不重复建成分', p2.data.duplicated === true);
    check('成分总数仍为 3', p2.data.components.length === 3);
  }

  console.log('\n场景 5：初检复检不符挂待定，不许发给医院');
  {
    const x2 = (await api('/api/donations')).data.find((d) => d.donation_code === 'X2');
    await api(`/api/donations/${x2.id}/prepare`, { method: 'POST' });
    // 制备时已有不符复检结论 → 待定
    await api(`/api/donations/${x2.id}/test-results`, { method: 'POST', body: { blood_type: 'A' } });
    const x2d = await api(`/api/donations/${x2.id}`);
    const rc = x2d.data.components.find((c) => c.type === 'red_cells');
    check('复检不符 → 成分待定/失效', rc.status === 'invalid' || rc.status === 'pending');
    const iss = await api('/api/issues', { method: 'POST', body: {
      hospital: '市二医院', items: [{ component_id: rc.id, quantity: 1 }] } });
    check('不符成分发放被拒 (409)', iss.status === 409);

    // X1 无复检结论 → 待定禁发
    const x1 = (await api('/api/donations')).data.find((d) => d.donation_code === 'X1');
    const x1d = await api(`/api/donations/${x1.id}`);
    const rc1 = x1d.data.components.find((c) => c.type === 'red_cells');
    const iss1 = await api('/api/issues', { method: 'POST', body: {
      hospital: '市二医院', items: [{ component_id: rc1.id, quantity: 1 }] } });
    check('无复检结论 → 待定禁发 (409)', iss1.status === 409);
  }

  console.log('\n场景 6：复检结论变更——未发部分按新结论重算，已发部分按发放单追回');
  {
    const x3 = (await api('/api/donations')).data.find((d) => d.donation_code === 'X3');
    await api(`/api/donations/${x3.id}/prepare`, { method: 'POST' });
    const x3d = await api(`/api/donations/${x3.id}`);
    const rc = x3d.data.components.find((c) => c.type === 'red_cells');
    check('初检复检相符 → 合格可发', rc.status === 'valid');

    const iss = await api('/api/issues', { method: 'POST', body: {
      hospital: '市第一医院', items: [{ component_id: rc.id, quantity: 1 }] } });
    check('发放成功', iss.status === 200);

    // 复检结论由 O 变更为 A（与初检 O 不符）
    const change = await api(`/api/donations/${x3.id}/test-results`, { method: 'POST', body: { blood_type: 'A' } });
    check('未发 2 种成分按新结论失效', change.data.invalidated.length === 2);
    check('已发红细胞生成 1 条追回任务', change.data.recalls_created.length === 1);

    const recalls = (await api('/api/recalls?status=pending')).data;
    const r3 = recalls.find((r) => r.donation_code === 'X3');
    check('追回任务含医院与发放单信息', !!r3 && r3.hospital === '市第一医院' && !!r3.issue_no);
    check('追回数量与发放量一致', r3 && r3.quantity === 1);

    const rec = await api(`/api/recalls/${r3.id}/reconcile`, { method: 'POST', body: {} });
    check('追回对账完成', rec.data.status === 'reconciled');

    // 结论再改回相符 → 未发成分恢复合格
    const back = await api(`/api/donations/${x3.id}/test-results`, { method: 'POST', body: { blood_type: 'O' } });
    check('结论改回相符 → 未发成分恢复合格', back.data.released.length === 2);
  }

  console.log('\n场景 7：血库存量按成分 + 效期显示');
  {
    const inv = await api('/api/inventory');
    check('库存按成分与效期分组', inv.data.length > 0 && inv.data.every((r) => r.type_name && r.expiry_date));
    const keys = new Set(inv.data.map((r) => `${r.type}@${r.expiry_date}@${r.status}`));
    check('分组键唯一（成分+效期+状态）', keys.size === inv.data.length);
    const x3rc = inv.data.find((r) => r.type === 'red_cells' && r.available_qty === 0);
    check('已发完成分可用量为 0', !!x3rc);
  }

  console.log('\n场景 8：汇总与冲突总览');
  {
    const s = await api('/api/summary');
    check('总览含待追回数', s.data.recalls_pending === 0);
    check('总览含冲突数', s.data.conflicts === 1);
  }

  console.log('\n场景 9：离线合并时两个采血点撞同一献血码 → 先登记的收，晚到的列冲突');
  {
    const batch = { batch_id: 'B9', client_id: '采血车-03', records: [
      { client_record_id: 'r1', type: 'donation', payload: {
        donation_code: 'X9', collection_point: '采血车-03', collected_at: '2026-10-07', initial_blood_type: 'A' } },
      { client_record_id: 'r2', type: 'donation', payload: {
        donation_code: 'X9', collection_point: '采血车-05', collected_at: '2026-10-07', initial_blood_type: 'A' } },
    ] };
    const r = await api('/api/merge/batches', { method: 'POST', body: batch });
    check('先到记录 applied', r.data.results[0].status === 'applied');
    check('晚到记录 conflict', r.data.results[1].status === 'conflict');
    check('汇总 1 已合并 1 冲突', r.data.summary.applied === 1 && r.data.summary.conflict === 1);
    const conflicts = (await api('/api/conflicts')).data;
    check('冲突表含晚到采血车-05', conflicts.some((c) => c.donation_code === 'X9' && c.collection_point === '采血车-05'));
    const donations = (await api('/api/donations')).data;
    check('献血记录仍只有一条', donations.filter((d) => d.donation_code === 'X9').length === 1);
  }


  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error(err);
  server.kill();
  process.exit(1);
});
