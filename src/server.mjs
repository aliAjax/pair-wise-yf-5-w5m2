// HTTP 接口层。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import * as domain from './domain.mjs';
import { BizError } from './domain.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).then((out) => res.json(out)).catch(next);

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // 总览
  app.get('/api/summary', wrap(() => domain.getSummary()));

  // 献血登记
  app.get('/api/donations', wrap(() => domain.listDonations()));
  app.post('/api/donations', wrap(async (req) => {
    const result = await domain.registerDonation(req.body);
    if (result.conflict) {
      throw new BizError(409, `献血码 ${result.donation_code} 已存在，晚到记录已列入冲突`);
    }
    return result;
  }));
  app.get('/api/donations/:id', wrap((req) => domain.getDonation(req.params.id)));
  app.post('/api/donations/:id/prepare', wrap((req) => domain.prepareComponents(req.params.id)));
  app.post('/api/donations/:id/test-results', wrap((req) => domain.addTestResult(req.params.id, req.body)));

  // 离线合并
  app.post('/api/merge/batches', wrap((req) => domain.submitMergeBatch(req.body)));
  app.get('/api/merge/batches', wrap(() => domain.listBatches()));

  // 成分 / 库存
  app.get('/api/components', wrap((req) => domain.listComponents({ donation_id: req.query.donation_id })));
  app.get('/api/inventory', wrap(() => domain.getInventory()));

  // 发放
  app.get('/api/issues', wrap(() => domain.listIssues()));
  app.post('/api/issues', wrap((req) => domain.createIssue(req.body)));
  app.get('/api/issues/:id', wrap((req) => domain.getIssue(req.params.id)));

  // 追回
  app.get('/api/recalls', wrap((req) => domain.listRecalls({ status: req.query.status })));
  app.post('/api/recalls/:id/reconcile', wrap((req) => domain.reconcileRecall(req.params.id, req.body?.note)));

  // 冲突
  app.get('/api/conflicts', wrap(() => domain.listConflicts()));

  // 业务错误 → 4xx；其余 → 500
  app.use((err, req, res, next) => {
    if (err instanceof BizError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: err.message || '服务器内部错误' });
  });

  return app;
}
