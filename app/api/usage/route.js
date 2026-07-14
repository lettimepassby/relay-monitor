// ---- 用量统计（分模型 / 分时间）------------------------------------------------
import { withAuth, json } from "../../../lib/api.js";
import { queryStationUsage } from "../../../lib/providers.js";

// 各站点用量接口逐个查开销不小，按范围缓存 60 秒（缓存挂 rt 上，不用模块级变量）
export const GET = withAuth(async (request, rt) => {
  const { store } = rt;
  const usageCache = (rt._usageCache ||= new Map());
  const sp = new URL(request.url).searchParams;
  const range = ["today", "24h", "7d", "30d"].includes(sp.get("range")) ? sp.get("range") : "today";
  // 用浏览器时区分桶：sub2api 站点面板也是按浏览器时区统计的，
  // 这样「今天」的口径和用户在站点上看到的完全一致
  let tz = String(sp.get("tz") || "");
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = ""; }
  if (!tz) tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const cacheKey = `${range}|${tz}`;
  const hit = usageCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60000) return json(hit.payload);

  const now = Date.now();
  let startMs, granularity;
  if (range === "24h") {
    // 滚动 24 小时窗口（非自然日）
    startMs = now - 24 * 3600000;
    granularity = "hour";
  } else {
    // 该时区的今日零点：用当前时刻在该时区的时分秒往回推
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(now));
    const get = (k) => Number(p.find((x) => x.type === k).value);
    const midnight = now - ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000 - (now % 1000);
    const days = range === "30d" ? 29 : range === "7d" ? 6 : 0;
    startMs = midnight - days * 86400000;
    granularity = range === "today" ? "hour" : "day";
  }
  const endMs = now;

  const stations = await Promise.all(store.list().filter((s) => s.type !== "fixed").map(async (s) => {
    const meta = { id: s.id, name: s.name, type: s.type, cnyPerUsd: s.cnyPerUsd ?? null, isOwn: !!s.isOwn };
    try {
      const u = await queryStationUsage(s, {
        startMs, endMs, granularity, tz,
        exactWindow: range === "24h",
        wantToday: range === "today",
      });
      return { ...meta, ok: true, ...u };
    } catch (err) {
      return { ...meta, ok: false, error: err?.message || String(err) };
    }
  }));
  await store.save(); // sub2api 密码模式可能在查询中轮换了令牌

  const payload = { range, granularity, startMs, endMs, tz, stations, generatedAt: new Date().toISOString() };
  usageCache.set(cacheKey, { at: Date.now(), payload });
  return json(payload);
});
