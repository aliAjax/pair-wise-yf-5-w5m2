// 血品账前端逻辑
const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
};

const toast = (msg, type = '') => {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 4000);
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const statusLabel = {
  pending: '待定', valid: '合格', invalid: '失效', issued: '已发放',
  recalled: '追回中', expired: '已过期', reconciled: '已对账',
  conflict: '冲突', applied: '已合并', skipped: '已跳过',
};
const typeName = { red_cells: '红细胞', plasma: '血浆', platelets: '血小板' };

// ---- Tab 切换 ----
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    ({ inventory: loadInventory, donations: loadDonations, merge: loadBatches,
       issues: loadIssues, recalls: loadRecalls, conflicts: loadConflicts }[btn.dataset.tab] || (() => {}))();
  });
});

// ---- 总览 ----
async function loadSummary() {
  const s = await api('/api/summary');
  $('#summary').innerHTML = `
    <span class="chip">献血登记 <b>${s.donations}</b></span>
    <span class="chip">成分 <b>${s.components}</b></span>
    <span class="chip">待定 <b>${s.pending}</b></span>
    <span class="chip">失效 <b>${s.invalid}</b></span>
    <span class="chip">已发放 <b>${s.issued}</b></span>
    <span class="chip">发放单 <b>${s.issues}</b></span>
    <span class="chip">待追回 <b>${s.recalls_pending}</b></span>
    <span class="chip">冲突 <b>${s.conflicts}</b></span>`;
  $('#recall-badge').textContent = s.recalls_pending;
  $('#recall-badge').classList.toggle('hidden', s.recalls_pending === 0);
  $('#conflict-badge').textContent = s.conflicts;
  $('#conflict-badge').classList.toggle('hidden', s.conflicts === 0);
}

// ---- 库存 ----
async function loadInventory() {
  const rows = await api('/api/inventory');
  const tb = $('#inventory-table tbody');
  tb.innerHTML = rows.map((r) => `
    <tr>
      <td>${r.type_name}</td>
      <td>${r.expiry_date}${r.expired ? ' <span class="status expired">已过期</span>' : ''}</td>
      <td><span class="status ${r.status}">${statusLabel[r.status] || r.status}</span></td>
      <td>${r.available_qty}</td>
      <td>${r.total_qty}</td>
      <td class="mini">${r.lot_count} 批</td>
    </tr>`).join('') || '<tr><td colspan="7" class="mini">暂无库存</td></tr>';
}

// ---- 献血登记 ----
$('#donation-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/donations', { method: 'POST', body: {
      donation_code: f.donation_code.value.trim(),
      donor_name: f.donor_name.value.trim(),
      collection_point: f.collection_point.value.trim(),
      collected_at: f.collected_at.value,
      initial_blood_type: f.initial_blood_type.value,
    } });
    f.reset();
    toast('登记成功', 'success');
    loadDonations();
    loadSummary();
  } catch (err) { toast(err.message, 'error'); }
});

async function loadDonations() {
  const list = await api('/api/donations');
  const el = $('#donation-list');
  el.innerHTML = list.map((d) => `
    <div class="donation-card">
      <h4>献血码 ${esc(d.donation_code)} ${d.source === 'offline' ? '<span class="status skipped">离线合并</span>' : '<span class="status applied">在线</span>'}</h4>
      <div class="meta">
        ${esc(d.collection_point)} · 采血 ${esc(d.collected_at)}
        ${d.donor_name ? `· 献血者 ${esc(d.donor_name)}` : ''}
        · 初检血型 <b>${d.initial_blood_type || '未检'}</b>
        · 当前复检 <b>${d.current_test ? d.current_test.blood_type : '未检'}</b>
      </div>
      <div class="actions">
        <button class="primary" onclick="doPrepare('${d.id}')">制备成分</button>
        <form class="test-form" onsubmit="return doTestResult(event, '${d.id}')">
          复检血型
          <select name="blood_type">
            <option value="">--</option>
            <option>A</option><option>B</option><option>O</option><option>AB</option>
          </select>
          <button type="submit">录入复检结论</button>
        </form>
      </div>
      <div id="comps-${d.id}">${d.component_count ? '<span class="mini">成分已制备，展开查看</span>' : '<span class="mini">尚未制备成分</span>'}</div>
      <div id="detail-${d.id}" class="hidden"></div>
    </div>`).join('') || '<p class="mini">暂无登记</p>';
}

window.doPrepare = async (id) => {
  try {
    const r = await api(`/api/donations/${id}/prepare`, { method: 'POST' });
    toast(r.duplicated ? '成分已存在，未重复创建' : '成分制备完成：红细胞/血浆/血小板各记效期', 'success');
    loadDonations(); loadSummary(); loadInventory();
  } catch (err) { toast(err.message, 'error'); }
};

window.doTestResult = async (e, id) => {
  e.preventDefault();
  const bt = e.target.blood_type.value;
  if (!bt) return toast('请选择复检血型', 'error');
  try {
    const r = await api(`/api/donations/${id}/test-results`, { method: 'POST', body: { blood_type: bt } });
    const msg = [`复检结论 #${r.conclusion_no} 已录入`];
    if (r.invalidated.length) msg.push(`${r.invalidated.length} 种未发成分按新结论失效`);
    if (r.released.length) msg.push(`${r.released.length} 种成分复检相符，合格`);
    if (r.recalls_created.length) msg.push(`已发成分生成 ${r.recalls_created.length} 条追回任务`);
    toast(msg.join('，'), r.recalls_created.length ? 'error' : 'success');
    loadDonations(); loadSummary(); loadRecalls();
  } catch (err) { toast(err.message, 'error'); }
  return false;
};

// ---- 离线合并 ----
window.fillMergeExample = () => {
  const code = `X${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${String(Math.floor(Math.random() * 900) + 100)}`;
  $('#merge-form [name=records]').value = JSON.stringify([
    { client_record_id: 'r1', type: 'donation', payload: { donation_code: code, collection_point: '采血车-03', collected_at: '2026-10-07', initial_blood_type: 'A' } },
    { client_record_id: 'r2', type: 'test_result', payload: { donation_code: code, blood_type: 'AB' } },
  ], null, 2);
};

$('#merge-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  let records;
  try { records = JSON.parse(f.records.value); } catch { return toast('记录不是合法 JSON', 'error'); }
  try {
    const r = await api('/api/merge/batches', { method: 'POST', body: {
      batch_id: f.batch_id.value.trim(), client_id: f.client_id.value.trim(), records,
    } });
    const s = r.summary;
    toast(`合并完成：已合并 ${s.applied}，冲突 ${s.conflict}，待重试 ${s.pending}，跳过 ${s.skipped}`,
      s.conflict || s.pending ? 'error' : 'success');
    loadBatches(); loadSummary();
  } catch (err) { toast(err.message, 'error'); }
});

async function loadBatches() {
  const batches = await api('/api/merge/batches');
  $('#batch-list').innerHTML = batches.map((b) => `
    <div class="donation-card">
      <h4>批次 ${esc(b.id)} <span class="status ${b.status}">${b.status === 'completed' ? '已完成' : '待重试'}</span></h4>
      <div class="meta">客户端 ${esc(b.client_id)} · 收到 ${esc(b.received_at)}${b.completed_at ? ` · 完成 ${esc(b.completed_at)}` : ''}</div>
      <table>
        <thead><tr><th>客户端记录</th><th>类型</th><th>状态</th><th>结果</th></tr></thead>
        <tbody>
          ${b.records.map((r) => `<tr>
            <td>${esc(r.client_record_id)}</td>
            <td>${r.record_type === 'donation' ? '献血登记' : '复检结论'}</td>
            <td><span class="status ${r.status}">${statusLabel[r.status] || r.status}</span></td>
            <td class="mini">${esc(r.result)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`).join('') || '<p class="mini">暂无批次</p>';
}

// ---- 发放 ----
window.addIssueItem = () => {
  const row = document.createElement('div');
  row.className = 'issue-row';
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;align-items:center;';
  row.innerHTML = `
    <select name="component_id" required style="flex:2;padding:7px;border:1px solid #ced6e0;border-radius:6px;"></select>
    <input name="quantity" type="number" min="1" value="1" style="width:80px;padding:7px;border:1px solid #ced6e0;border-radius:6px;">
    <button type="button" class="secondary" onclick="this.parentNode.remove()">删</button>`;
  $('#issue-items').appendChild(row);
  loadComponentOptions(row.querySelector('select'));
};

async function loadComponentOptions(select) {
  const comps = await api('/api/components');
  select.innerHTML = comps
    .filter((c) => c.status === 'valid' && (c.quantity - c.issued_quantity) > 0 && c.expiry_date >= new Date().toISOString().slice(0, 10))
    .map((c) => `<option value="${c.id}">${typeName[c.type]} · ${c.donation_code} · 效期 ${c.expiry_date} · 剩 ${c.quantity - c.issued_quantity}</option>`)
    .join('');
}

$('#issue-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const items = [...f.querySelectorAll('.issue-row')].map((row) => ({
    component_id: row.querySelector('[name=component_id]').value,
    quantity: Number(row.querySelector('[name=quantity]').value),
  })).filter((it) => it.component_id);
  try {
    const r = await api('/api/issues', { method: 'POST', body: { hospital: f.hospital.value.trim(), items } });
    toast(`发放单 ${r.issue_no} 已开立`, 'success');
    f.reset();
    $('#issue-items').innerHTML = '';
    loadIssues(); loadInventory(); loadSummary();
  } catch (err) { toast(err.message, 'error'); }
});

async function loadIssues() {
  const issues = await api('/api/issues');
  $('#issue-list').innerHTML = issues.map((i) => `
    <div class="donation-card">
      <h4>发放单 ${esc(i.issue_no)}</h4>
      <div class="meta">${esc(i.hospital)} · ${esc(i.issued_at)}</div>
      <table>
        <thead><tr><th>成分</th><th>献血码</th><th>效期</th><th>数量</th></tr></thead>
        <tbody>${i.items.map((it) => `<tr>
          <td>${typeName[it.type]}</td><td>${esc(it.donation_code)}</td><td>${esc(it.expiry_date)}</td><td>${it.quantity}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`).join('') || '<p class="mini">暂无发放单</p>';
}

// ---- 追回 ----
async function loadRecalls() {
  const rows = await api('/api/recalls');
  const tb = $('#recall-table tbody');
  tb.innerHTML = rows.map((r) => `
    <tr>
      <td>${typeName[r.type]}</td>
      <td>${esc(r.donation_code)}</td>
      <td>${esc(r.issue_no)}</td>
      <td>${esc(r.hospital)}</td>
      <td>${r.quantity}</td>
      <td class="recall-reason mini">${esc(r.reason)}</td>
      <td><span class="status ${r.status}">${statusLabel[r.status]}</span></td>
      <td>${r.status === 'pending' ? `<button onclick="doReconcile('${r.id}')">对账完成</button>` : `<span class="mini">${esc(r.reconciled_at || '')}</span>`}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="mini">暂无追回任务</td></tr>';
}

window.doReconcile = async (id) => {
  try {
    await api(`/api/recalls/${id}/reconcile`, { method: 'POST', body: {} });
    toast('追回任务已对账', 'success');
    loadRecalls(); loadSummary();
  } catch (err) { toast(err.message, 'error'); }
};

// ---- 冲突 ----
async function loadConflicts() {
  const rows = await api('/api/conflicts');
  $('#conflict-table tbody').innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(r.donation_code)}</td>
      <td>${esc(r.collection_point)}</td>
      <td>${esc(r.donor_name || '')}</td>
      <td class="recall-reason mini">${esc(r.reason)}</td>
      <td>${esc(r.detected_at)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="mini">暂无冲突</td></tr>';
}

// 初始加载
loadSummary();
loadInventory();
loadDonations();
setInterval(loadSummary, 15000);
