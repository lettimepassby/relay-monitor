// 应用运行时单例：连库→建表→载入 Store/History→会话密钥→启动后台任务。
// Next.js 下用 globalThis 缓存，HMR/多次 import 不会重复初始化。
// 所有 API 路由通过 getRuntime() 取服务实例（等价 v1 server.js 顶部的全局变量）。
import { randomBytes } from "node:crypto";
import { getPool, ensureSchema } from "../db/pool.js";
import { Store } from "../db/store.js";
import { History } from "../db/history.js";
import { SessionManager } from "./auth.js";

async function loadSessionSecret(pool) {
  const [rows] = await pool.query("SELECT v FROM meta WHERE k = 'session_secret'");
  if (rows.length) {
    // mysql2 对 JSON 列的标量值返回已解析的字符串（不带引号）；
    // 仅当拿到的是原始 JSON 文本（带引号）才需要再 parse 一次
    const v = rows[0].v;
    return typeof v === "string" && v.startsWith('"') ? JSON.parse(v) : v;
  }
  const secret = randomBytes(32).toString("hex");
  await pool.query("INSERT INTO meta (k, v) VALUES ('session_secret', ?)", [JSON.stringify(secret)]);
  return secret;
}

async function init() {
  const pool = getPool();
  await ensureSchema(pool);
  // v1 数据迁移不在此处：db/migrate.js 引用 stations.json 等字面量会被 Next
  // 构建追踪连真实凭证一起拷进 standalone 产物。迁移由部署入口显式执行
  //（Docker CMD 链式 node db/migrate.js，或本地 npm run db:migrate），幂等且库非空即跳过。

  const store = await new Store(pool).load();
  const history = await new History(pool).load();
  const sessions = new SessionManager(null);
  sessions.secret = await loadSessionSecret(pool);

  const rt = { pool, store, history, sessions, startedAt: Date.now() };

  // 后台任务：演示站播种 → 全量刷新 → 定时轮询 + 每日日报
  //（模块由 server/ 提供；动态导入使地基阶段也能先行启动）
  try {
    const { seedDemo } = await import("../server/demo.js");
    await seedDemo(rt);
  } catch (err) {
    console.error("  演示站模块未就绪:", err?.message);
  }
  try {
    const { refreshAll, restartPolling } = await import("../server/refresh.js");
    rt.refreshAll = refreshAll;
    rt.restartPolling = restartPolling;
    refreshAll(rt).catch(() => {});
    restartPolling(rt);
  } catch (err) {
    console.error("  后台刷新模块未就绪:", err?.message);
  }
  try {
    const { startReportScheduler } = await import("../server/report.js");
    startReportScheduler(rt);
  } catch (err) {
    console.error("  日报调度模块未就绪:", err?.message);
  }

  console.log(`\n  中转站余额监控面板 v2 已就绪（MySQL: ${process.env.DB_HOST || "127.0.0.1"}/${process.env.DB_NAME || "relay_monitor"}）\n`);
  return rt;
}

export function getRuntime() {
  // 初始化失败不缓存失败态：下次调用重试（例如 MySQL 短暂不可用）
  if (!globalThis.__RELAY_RT) {
    globalThis.__RELAY_RT = init().catch((err) => {
      globalThis.__RELAY_RT = null;
      throw err;
    });
  }
  return globalThis.__RELAY_RT;
}
