// ---- 「我的站点」下游分析（分时段 / 分模型 / 分用户 + 消费预测）------------------
import { withAuth, json } from "../../../../lib/api.js";
import { queryOwnData, dateStrInTz, parseDateLabel } from "../../../../lib/providers.js";
import { forecastDaily, forecastHourly } from "../../../../lib/forecast.js";
import { ownCache, getOwnUsers, computeResold, computeProfit } from "../../../../server/own-helpers.js";

export const GET = withAuth(async (request, rt) => {
  const { store } = rt;
  const own = store.list().find((s) => s.isOwn && s.type === "newapi");
  if (!own) {
    return json({
      error: "还没有标记「我的中转站」：添加/编辑你的 New API 站点，勾选「这是我自己的中转站」（需管理员令牌）",
    }, 400);
  }
  const sp = new URL(request.url).searchParams;
  const range = ["today", "7d", "30d"].includes(sp.get("range")) ? sp.get("range") : "7d";
  let tz = String(sp.get("tz") || "");
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = ""; }
  if (!tz) tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const cache = ownCache(rt);
  const cacheKey = `${range}|${tz}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 120000) return json(hit.payload);

  const now = Date.now();
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(now));
  const get = (k) => Number(p.find((x) => x.type === k).value);
  const midnight = now - ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000 - (now % 1000);
  const days = range === "30d" ? 29 : range === "7d" ? 6 : 0;
  const startMs = midnight - days * 86400000;
  const wideStart = midnight - 34 * 86400000; // 预测需要更长的历史

  try {
    // 模型行一次拉 35 天（窗口展示 + 日消费预测共用）；用户行只拉展示窗口
    const [modelRows, userRows] = await Promise.all([
      queryOwnData(own, wideStart, now, "model"),
      queryOwnData(own, startMs, now, "user"),
    ]);

    const winModel = modelRows.filter((r) => r.t >= startMs);
    const aggBy = (rows, field) => {
      const m = new Map();
      for (const r of rows) {
        const acc = m.get(r.key) || { [field]: r.key, tokens: 0, cost: 0, requests: 0 };
        acc.tokens += r.tokens; acc.cost += r.cost; acc.requests += r.requests;
        m.set(r.key, acc);
      }
      return [...m.values()].sort((a, b) => b.cost - a.cost);
    };

    // 时段趋势：今天按小时，7/30 天按 tz 自然日
    const hourly = range === "today";
    const tmap = new Map();
    for (const r of winModel) {
      const key = hourly ? Math.floor(r.t / 3600000) * 3600000 : parseDateLabel(dateStrInTz(r.t, tz), tz);
      const acc = tmap.get(key) || { t: key, tokens: 0, cost: 0, requests: 0 };
      acc.tokens += r.tokens; acc.cost += r.cost; acc.requests += r.requests;
      tmap.set(key, acc);
    }

    // 预测底料：35 天完整日消费（缺日补 0，不含今天的不完整数据）
    const dmap = new Map();
    for (const r of modelRows) {
      if (r.t >= midnight) continue;
      const dt = parseDateLabel(dateStrInTz(r.t, tz), tz);
      dmap.set(dt, (dmap.get(dt) || 0) + r.cost);
    }
    const daily = [];
    if (dmap.size) {
      const firstDay = Math.min(...dmap.keys());
      for (let t = firstDay; t < midnight; t += 86400000) {
        daily.push({ t, cost: Math.round((dmap.get(t) || 0) * 10000) / 10000 });
      }
    }
    // 用户列表：识别管理员（role >= 10）并取各用户余额
    let ownUsers = null;
    try {
      ownUsers = await getOwnUsers(rt, own);
    } catch { /* 拿不到就退化为不区分管理员 */ }
    const adminSet = new Set((ownUsers || []).filter((u) => u.role >= 10).map((u) => u.username));

    // 小时级序列（近 28 天，缺时补 0，不含当前未完小时）→ 未来 24 小时预测
    // modelRows 本就拉了 35 天：更长的序列让画像与 conformal 校准都有足够原点
    const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit" });
    const hodOf = (ms) => Number(hourFmt.format(new Date(ms))) % 24;
    const hmap = new Map();
    for (const r of modelRows) {
      const hk = Math.floor(r.t / 3600000) * 3600000;
      hmap.set(hk, (hmap.get(hk) || 0) + r.cost);
    }
    const lastFullHour = Math.floor(now / 3600000) * 3600000 - 3600000;
    const hourlyStart = Math.max(lastFullHour - 28 * 86400000, hmap.size ? Math.min(...hmap.keys()) : lastFullHour);
    const hourlySeries = [];
    for (let t = hourlyStart; t <= lastFullHour; t += 3600000) {
      hourlySeries.push({ t, cost: Math.round((hmap.get(t) || 0) * 10000) / 10000 });
    }
    const hf = forecastHourly(hourlySeries, hodOf, 24);
    let hourlyForecast = null;
    if (hf) {
      const todaySoFar = modelRows.filter((r) => r.t >= midnight).reduce((a, r) => a + r.cost, 0);
      // 今天预计全天 = 已发生 + 预测里落在今天的剩余小时
      const dayEndMs = midnight + 86400000;
      const restToday = hf.points.filter((p) => p.t < dayEndMs).reduce((a, p) => a + p.cost, 0);
      hourlyForecast = {
        past: hourlySeries.slice(-24),
        next: hf.points,
        next24Total: hf.next24Total,
        backtestWapePct: hf.backtestWapePct,
        todaySoFar: Math.round(todaySoFar * 100) / 100,
        todayEst: Math.round((todaySoFar + restToday) * 100) / 100,
      };
    }

    const byUser = aggBy(userRows, "user").map((u) => ({ ...u, isAdmin: adminSet.has(u.user) }));
    // 收入 = 普通用户的期内消费；管理员/root 自己用不产生收入，但上游成本照付
    const rawIncomeUsd = byUser.filter((u) => !u.isAdmin).reduce((a, u) => a + u.cost, 0);
    const rawAdminUsd = byUser.filter((u) => u.isAdmin).reduce((a, u) => a + u.cost, 0);
    // 转售的管理员 Key：其消费改计入收入（详见 computeResold）
    const resold = await computeResold(own, rawIncomeUsd, rawAdminUsd, startMs, now);
    const incomeUsd = resold.incomeUsd;
    const adminUsageUsd = resold.adminUsageUsd;

    const payload = {
      range, tz, startMs, endMs: now,
      station: { id: own.id, name: own.name, cnyPerUsd: own.cnyPerUsd ?? null },
      byModel: aggBy(winModel, "model"),
      byUser,
      userBalances: ownUsers
        ? ownUsers
            .filter((u) => u.role < 10)
            .map((u) => ({ user: u.username, balanceUsd: Math.round(u.quotaUsd * 10000) / 10000, usedUsd: Math.round(u.usedUsd * 100) / 100, status: u.status }))
            .sort((a, b) => b.balanceUsd - a.balanceUsd)
        : null,
      trend: [...tmap.values()].sort((a, b) => a.t - b.t),
      daily: daily.slice(-14),
      forecast: forecastDaily(daily, 7),
      hourly: hourlyForecast,
      profit: await computeProfit(rt, own, incomeUsd, adminUsageUsd, { startMs, now, tz, range, resold }),
      generatedAt: new Date().toISOString(),
    };
    cache.set(cacheKey, { at: Date.now(), payload });
    return json(payload);
  } catch (err) {
    return json({ error: err?.message || String(err) }, 502);
  }
});
