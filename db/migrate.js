// 建表 + v1 数据一次性迁移（stations.json / history.json / secret.key → MySQL）。
// 幂等：仅当库里还没有数据时才导入，绝不覆盖已有数据。
// 用法：npm run db:migrate（或应用启动时自动调用 importV1IfEmpty）
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPool, ensureSchema } from "./pool.js";

export async function importV1IfEmpty(pool) {
  // 显式配置才导入：避免误把构建产物同目录下的任何 data/ 当迁移源，
  // 也让 Next 构建追踪不会把真实凭证目录拷进 standalone 产物
  const dir = process.env.V1_DATA_DIR;
  if (!dir) return { imported: false, reason: "未配置 V1_DATA_DIR，跳过 v1 导入" };
  const [[{ n: stationCount }]] = await pool.query("SELECT COUNT(*) AS n FROM stations");
  const [[{ n: metaCount }]] = await pool.query("SELECT COUNT(*) AS n FROM meta");
  if (stationCount > 0 || metaCount > 0) return { imported: false, reason: "库中已有数据" };

  let v1;
  try {
    v1 = JSON.parse(await readFile(join(dir, "stations.json"), "utf8"));
  } catch {
    return { imported: false, reason: `未找到 v1 数据（${dir}/stations.json），跳过导入` };
  }

  const conn = await pool.getConnection();
  const result = { imported: true, stations: 0, points: 0, secret: false };
  try {
    await conn.beginTransaction();
    // 站点文档原样入库
    const stations = Array.isArray(v1.stations) ? v1.stations : [];
    if (stations.length) {
      await conn.query("INSERT INTO stations (id, pos, doc) VALUES ?", [
        stations.map((s, i) => [s.id, i, JSON.stringify(s)]),
      ]);
      result.stations = stations.length;
    }
    const metas = [];
    if (v1.settings) metas.push(["settings", JSON.stringify(v1.settings)]);
    if (v1.auth) metas.push(["auth", JSON.stringify(v1.auth)]);
    if (v1.notifications) metas.push(["notifications", JSON.stringify(v1.notifications)]);
    // 会话密钥沿用 v1（已有登录态不失效）
    try {
      const secret = (await readFile(join(dir, "secret.key"), "utf8")).trim();
      if (secret) { metas.push(["session_secret", JSON.stringify(secret)]); result.secret = true; }
    } catch {}
    if (metas.length) {
      await conn.query("INSERT INTO meta (k, v) VALUES ?", [metas]);
    }
    // 历史快照
    try {
      const hist = JSON.parse(await readFile(join(dir, "history.json"), "utf8"));
      const rows = [];
      for (const [stationId, pts] of Object.entries(hist || {})) {
        if (!Array.isArray(pts)) continue;
        for (const p of pts) {
          if (Array.isArray(p) && p.length >= 2) rows.push([stationId, p[0], p[1], p[2] ?? 0]);
        }
      }
      // 分批插入，避免超大 packet
      for (let i = 0; i < rows.length; i += 5000) {
        await conn.query(
          "INSERT IGNORE INTO history_points (station_id, t, remaining, used) VALUES ?",
          [rows.slice(i, i + 5000)]
        );
      }
      result.points = rows.length;
    } catch {}
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  return result;
}

// 独立运行：node db/migrate.js
if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.loadEnvFile(".env"); } catch {}
  try { process.loadEnvFile(".env.local"); } catch {}
  const pool = getPool();
  await ensureSchema(pool);
  const r = await importV1IfEmpty(pool);
  console.log(r.imported
    ? `导入完成：${r.stations} 个站点，${r.points} 个历史点${r.secret ? "，会话密钥已沿用" : ""}`
    : `未导入：${r.reason}`);
  await pool.end();
}
