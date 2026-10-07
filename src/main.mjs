// 入口：初始化数据库并启动 HTTP 服务。
import { initDb } from './db.mjs';
import { createServer } from './server.mjs';

const PORT = process.env.PORT || 3000;

await initDb();
const app = createServer();
app.listen(PORT, () => {
  console.log(`血品账系统已启动: http://localhost:${PORT}`);
});
