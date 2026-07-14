// 「我的站点」分析共用辅助：用户/渠道缓存、转售 Key 消费重归、利润计算。
// 供 /api/own/analytics、/api/own/admin-keys 与每日日报共用。
// 约定：不在顶层 import lib/runtime.js；跨请求状态（缓存）一律挂在 rt 字段上。
import {
  queryStationUsage, queryOwnUsers, queryOwnChannels, queryLogStat,
  parseDateLabel, fixedPurchases,
} from "../lib/providers.js";

// 分析结果缓存（admin-keys PUT 改利润口径时要清掉，挂 rt 上跨路由共享）
export function ownCache(rt) {
  return (rt._ownCache ||= new Map());
}

// 用户列表拉取开销不小，缓存 10 分钟
export async function getOwnUsers(rt, own) {
  const c = rt._ownUsersCache;
  if (!c?.list || c.stationId !== own.id || Date.now() - c.at > 600000) {
    rt._ownUsersCache = { at: Date.now(), stationId: own.id, list: await queryOwnUsers(own) };
  }
  return rt._ownUsersCache.list;
}

/**
 * 转售的管理员/root Key 消费重归：从「管理员消耗（成本）」移入「下游收入」。
 * 对每个 (username, tokenName) 用日志统计接口取窗内消费额度（美元）后汇总。
 * 单个 Key 查询失败记为 0 并附带错误，不影响其余；返回调整后的两个口径 + 明细。
 */
export async function computeResold(own, incomeUsd, adminUsageUsd, startMs, endMs) {
  const keys = Array.isArray(own.resoldAdminKeys) ? own.resoldAdminKeys : [];
  if (!keys.length) return { incomeUsd, adminUsageUsd, resoldUsd: 0, breakdown: [] };
  const breakdown = [];
  let resoldUsd = 0;
  await Promise.all(keys.map(async (k) => {
    try {
      const usd = await queryLogStat(own, { username: k.username, tokenName: k.tokenName, startMs, endMs });
      resoldUsd += usd;
      breakdown.push({ username: k.username, tokenName: k.tokenName, usd: Math.round(usd * 10000) / 10000 });
    } catch (err) {
      breakdown.push({ username: k.username, tokenName: k.tokenName, usd: 0, error: err?.message || String(err) });
    }
  }));
  resoldUsd = Math.round(resoldUsd * 10000) / 10000;
  return {
    incomeUsd: incomeUsd + resoldUsd,
    // 转售消费本在管理员桶里，移走它；跨接口口径微差时钳到 0，避免负数
    adminUsageUsd: Math.max(0, adminUsageUsd - resoldUsd),
    resoldUsd,
    breakdown: breakdown.sort((a, b) => b.usd - a.usd),
  };
}

/**
 * 利润 = 收入（下游消费 × 自有站售价汇率）− 成本（各匹配上游的期内成本）
 * 成本口径：配置了每月固定成本的上游按天摊销（月费 ÷ 30 × 窗口天数）；
 * 否则按上游用量接口的实际扣费 × 充值汇率；用量接口不可用时退回余额下降推算。
 * 渠道按 base_url 与监控站点匹配（忽略协议/末尾斜杠/是否带 /api）。
 */
export async function computeProfit(rt, own, incomeUsd, adminUsageUsd, { startMs, now, tz, range, resold }) {
  const { store, history } = rt;
  const r2 = (v) => Math.round(v * 100) / 100;
  try {
    // 渠道列表拉取开销不小，缓存 10 分钟
    const cc = rt._ownChannelsCache;
    if (!cc?.list || cc.stationId !== own.id || Date.now() - cc.at > 600000) {
      rt._ownChannelsCache = { at: Date.now(), stationId: own.id, list: await queryOwnChannels(own) };
    }
    const channels = rt._ownChannelsCache.list;
    const norm = (u) => String(u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const hostOf = (u) => u.split("/")[0].split(":")[0];
    const isBareHost = (u) => !!u && !u.includes("/") && !u.includes(":");
    // 匹配打分：精确 > ±/api 后缀 > 裸主机（站点地址不带端口/路径时，
    // 覆盖该主机所有端口——同一台机器跑多个服务的场景）
    const matchScore = (stUrl, chUrl) => {
      if (!stUrl || !chUrl) return 0;
      if (stUrl === chUrl) return 3;
      if (stUrl === chUrl + "/api" || chUrl === stUrl + "/api") return 2;
      if (isBareHost(stUrl) && hostOf(chUrl) === stUrl) return 1;
      return 0;
    };
    const upstreams = store.list().filter((s) => s.id !== own.id);

    const matched = new Map(); // stationId -> {station, channels[]}
    const unmatched = new Map(); // label -> {label, names[], enabled, total}
    for (const ch of channels) {
      const cu = norm(ch.baseUrl);
      let st = null, best = 0;
      for (const s of upstreams) {
        const score = matchScore(norm(s.baseUrl), cu);
        if (score > best) { best = score; st = s; }
      }
      if (st) {
        const e = matched.get(st.id) || { station: st, channels: [] };
        e.channels.push(ch.name);
        matched.set(st.id, e);
      } else {
        const label = cu || `官方 / 内置渠道（type ${ch.type}）`;
        const e = unmatched.get(label) || { label, names: [], enabled: 0, total: 0 };
        e.names.push(ch.name);
        e.total++;
        if (ch.status === 1) e.enabled++;
        unmatched.set(label, e);
      }
    }

    const windowDays = (now - startMs) / 86400000;
    const rateOf = (s) => (s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1);

    // 固定成本：无论是否匹配到渠道都计入（服务器租金这类可以完全不填地址）。
    // 每笔付费按 [购买日, 购买日+天数] 与展示窗口的重叠部分摊销，多笔叠加求和；
    // 没填日期的按全窗口摊销（自动续费的常驻成本）
    const costs = [];
    for (const s of upstreams) {
      const purchases = fixedPurchases(s);
      if (!purchases.length) continue;
      let cnySum = 0, active = 0, expired = 0;
      for (const p of purchases) {
        const daily = p.amount / p.days;
        const st = p.startDate ? parseDateLabel(p.startDate, tz) : null;
        if (st == null) {
          cnySum += daily * windowDays;
          active++;
          continue;
        }
        const end = st + p.days * 86400000;
        cnySum += daily * (Math.max(0, Math.min(now, end) - Math.max(startMs, st)) / 86400000);
        if (end <= now) expired++;
        else if (st <= now) active++;
      }
      let note = null;
      if (expired === purchases.length) note = purchases.length > 1 ? "已全部到期" : "已到期";
      else if (purchases.length > 1) note = `${active}/${purchases.length} 笔生效中`;
      else if (purchases[0].startDate) {
        const st0 = parseDateLabel(purchases[0].startDate, tz);
        if (st0 != null && st0 > startMs) note = `${purchases[0].startDate} 起`;
      }
      costs.push({
        stationId: s.id, name: s.name, mode: "fixed", note,
        channels: matched.get(s.id)?.channels || ["未匹配渠道 · 通用成本"],
        cny: r2(cnySum),
      });
    }
    // 按用量：匹配到渠道且未配置固定成本的上游
    const usageCosts = await Promise.all(
      [...matched.values()]
        .filter(({ station }) => fixedPurchases(station).length === 0 && station.type !== "fixed")
        .map(async ({ station, channels: chNames }) => {
          const item = { stationId: station.id, name: station.name, channels: chNames };
          try {
            const u = await queryStationUsage(station, {
              startMs, endMs: now, granularity: "day", tz, wantToday: range === "today",
            });
            const usd = range === "today" && u.summary ? u.summary.cost : u.models.reduce((a, m) => a + m.cost, 0);
            return { ...item, mode: "usage", cny: r2(usd * rateOf(station)) };
          } catch {
            return { ...item, mode: "history", cny: r2(history.usedSince(station.id, startMs) * rateOf(station)) };
          }
        })
    );
    costs.push(...usageCosts);

    const ownRate = own.cnyPerUsd != null && own.cnyPerUsd > 0 ? own.cnyPerUsd : 1;
    const incomeCny = r2(incomeUsd * ownRate);
    const totalCostCny = r2(costs.reduce((a, c) => a + c.cny, 0));
    return {
      incomeCny, totalCostCny,
      adminUsageCny: r2((adminUsageUsd || 0) * ownRate),
      // 转售管理员 Key 计入收入的部分（× 售价汇率），供前端拆分展示
      resoldCny: resold ? r2((resold.resoldUsd || 0) * ownRate) : 0,
      resoldKeys: resold ? resold.breakdown.map((b) => ({ ...b, cny: r2(b.usd * ownRate) })) : [],
      profitCny: r2(incomeCny - totalCostCny),
      marginPct: incomeCny > 0 ? Math.round(((incomeCny - totalCostCny) / incomeCny) * 1000) / 10 : null,
      costs: costs.sort((a, b) => b.cny - a.cny),
      unmatched: [...unmatched.values()].sort((a, b) => b.enabled - a.enabled || b.total - a.total),
      windowDays: Math.round(windowDays * 10) / 10,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}
