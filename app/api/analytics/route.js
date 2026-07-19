// ---- 经营分析（v2 新增）：基于 history_points 关系行的 SQL 聚合 --------------------
// GET /api/analytics?days=30
// 消耗口径与 History.usedSince 一致：相邻快照余额下降计消耗，上升视为充值忽略。
// SQL 用窗口函数 LAG 取每站上一快照余额；日期/小时按服务器本地时区分桶
//（FROM_UNIXTIME 走 MySQL 会话时区，与面板同机部署时即本地时区）。
// Node 侧补充：固定成本付费记录在窗口内的日摊销序列 + 每站余额跑道（predict）。
import { withAuth, json } from "../../../lib/api.js";
import { fixedPurchases } from "../../../lib/providers.js";

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const pad2 = (n) => String(n).padStart(2, "0");
// 本地时区的 YYYY-MM-DD（与 SQL 端 DATE_FORMAT 同口径）
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// LAG 子查询：每行带上同站上一快照的余额（表本身只保留 30 天，全表分区扫描可接受；
// 不在子查询内截窗，窗口首个快照才能接住窗口边界前的最后一笔下降）
const DROPS_SQL = `
  SELECT station_id, t, remaining,
         LAG(remaining) OVER (PARTITION BY station_id ORDER BY t) AS prev
  FROM history_points
`;

export const GET = withAuth(async (request, rt) => {
  const { pool, store, history } = rt;
  const sp = new URL(request.url).searchParams;
  let days = Math.floor(Number(sp.get("days")));
  if (!Number.isFinite(days) || days < 1 || days > 30) days = 30;

  // 窗口 = 今天（本地自然日）往前共 days 天，起点取本地零点
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const cutoff = startDate.getTime();

  // 每站每日消耗（$）：余额下降按“后一快照”的时间归桶
  const [dailyRows] = await pool.query(
    `SELECT station_id AS stationId,
            DATE_FORMAT(FROM_UNIXTIME(t / 1000), '%Y-%m-%d') AS date,
            SUM(prev - remaining) AS usd
     FROM (${DROPS_SQL}) x
     WHERE t >= ? AND prev IS NOT NULL AND prev > remaining
     GROUP BY stationId, date
     ORDER BY date, stationId`,
    [cutoff]
  );

  // 星期 × 小时 消耗矩阵（$，按站分组，Node 侧折算 ¥ 后跨站合计）
  // WEEKDAY()：0=周一 … 6=周日
  const [heatRows] = await pool.query(
    `SELECT station_id AS stationId,
            WEEKDAY(FROM_UNIXTIME(t / 1000)) AS weekday,
            HOUR(FROM_UNIXTIME(t / 1000)) AS hour,
            SUM(prev - remaining) AS usd
     FROM (${DROPS_SQL}) x
     WHERE t >= ? AND prev IS NOT NULL AND prev > remaining
     GROUP BY stationId, weekday, hour`,
    [cutoff]
  );

  // 站点文档：汇率折算 + 固定成本 + 跑道预测（已删除站点的残留行直接跳过）
  const stations = store.list();
  const byId = new Map(stations.map((s) => [s.id, s]));
  const rateOf = (s) => (s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1);

  const daily = [];
  const totalUsd = new Map(); // stationId -> 窗口内合计消耗（$）
  for (const r of dailyRows) {
    const s = byId.get(r.stationId);
    if (!s) continue;
    const usd = Number(r.usd);
    daily.push({ date: r.date, stationId: r.stationId, usd: r4(usd), cny: r2(usd * rateOf(s)) });
    totalUsd.set(r.stationId, (totalUsd.get(r.stationId) || 0) + usd);
  }

  // 热力图跨站合计（¥）
  const heatMap = new Map(); // "weekday|hour" -> cny
  for (const r of heatRows) {
    const s = byId.get(r.stationId);
    if (!s || s.isOwn || s.includeInProfit === false) continue;
    const k = `${r.weekday}|${r.hour}`;
    heatMap.set(k, (heatMap.get(k) || 0) + Number(r.usd) * rateOf(s));
  }
  const heatmap = [...heatMap.entries()].map(([k, cny]) => {
    const [weekday, hour] = k.split("|").map(Number);
    return { weekday, hour, cny: r2(cny) };
  });

  // 固定成本日摊销：每笔付费 金额÷天数，摊到 [购买日, 购买日+天数) 与窗口的重叠日；
  // 没填日期的按常驻成本全窗口摊销（口径与 own-helpers.computeProfit 一致）
  const fixedDaily = [];
  const fixedTotal = new Map(); // stationId -> 窗口内固定摊销合计（¥）
  const dayList = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
    dayList.push({ date: dayKey(d), ms: d.getTime() });
  }
  for (const s of stations) {
    const purchases = fixedPurchases(s);
    if (!purchases.length) continue;
    for (const { date, ms } of dayList) {
      let cny = 0;
      for (const p of purchases) {
        if (!(p.amount > 0) || !(p.days > 0)) continue;
        if (p.startDate) {
          const [y, m, d] = p.startDate.split("-").map(Number);
          const st = new Date(y, m - 1, d).getTime();
          if (ms < st || ms >= st + p.days * 86400000) continue;
        }
        cny += p.amount / p.days;
      }
      if (cny > 0) {
        fixedDaily.push({ date, stationId: s.id, cny: r2(cny) });
        fixedTotal.set(s.id, (fixedTotal.get(s.id) || 0) + cny);
      }
    }
  }

  // 每站汇总：合计消耗 + 固定摊销 + 余额跑道（etaDays/burnPerDay，数据不足为 null）
  const outStations = stations.map((s) => {
    const usd = totalUsd.get(s.id) || 0;
    const p = history.predict(s.id);
    return {
      id: s.id,
      name: s.name,
      isOwn: !!s.isOwn,
      includeInProfit: s.includeInProfit !== false,
      cnyPerUsd: s.cnyPerUsd ?? null,
      totalUsd: r4(usd),
      totalCny: r2(usd * rateOf(s)),
      fixedCny: r2(fixedTotal.get(s.id) || 0),
      runway: p ? { etaDays: p.etaDays, burnPerDay: p.burnPerDay, basis: p.basis } : null,
    };
  });

  return json({
    days,
    start: dayList[0].date,
    end: dayList[dayList.length - 1].date,
    stations: outStations,
    daily,
    fixedDaily,
    heatmap,
    generatedAt: new Date().toISOString(),
  });
});
