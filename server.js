import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

import { Store } from "./lib/store.js";
import {
  queryStation, queryStationUsage, queryOwnData, queryOwnChannels, queryOwnUsers,
  queryAdminTokens, queryLogStat,
  dateStrInTz, parseDateLabel, fixedPurchases, STATION_TYPES,
} from "./lib/providers.js";
import { forecastDaily, forecastHourly } from "./lib/forecast.js";
import { SessionManager, verifyPassword } from "./lib/auth.js";
import { History } from "./lib/history.js";
import { evaluateStation } from "./lib/alerts.js";
import { CHANNEL_TYPES, sendToChannel, broadcast } from "./lib/notify.js";
import { fmtEta } from "./lib/alerts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || "127.0.0.1";

// 版本信息：版本号来自 package.json，commit 由 Docker 构建时注入（APP_COMMIT）
const pkg = JSON.parse(await readFile(join(__dirname, "package.json"), "utf8"));
const APP_INFO = {
  version: pkg.version,
  commit: (process.env.APP_COMMIT || "").slice(0, 7) || null,
};

const store = new Store(join(__dirname, "data", "stations.json"));
try {
  await store.load();
} catch (err) {
  // 数据文件损坏/不可读：store.load() 已备份并中止，此处打印致命信息并退出，
  // 绝不带着空状态继续运行（那会覆盖掉现有站点凭证）。
  console.error(`\n[致命] ${err.message}\n`);
  process.exit(1);
}
const history = await new History(join(__dirname, "data", "history.json")).load();
const sessions = await new SessionManager(join(__dirname, "data", "secret.key")).init();

const app = express();
app.disable("x-powered-by");
app.use(express.json());

// ---------------------------------------------------------------------------
// 内置演示中转站（mock relay）
// 让面板在没有真实凭证时也能展示真实的查询链路与数据。
// Sub2API 部分完整模拟：登录（邮箱+密码）→ 短时令牌（5 分钟）→ 过期 401
// TOKEN_EXPIRED → 刷新/重登录，用于演示「账号密码自动续期」。
// ---------------------------------------------------------------------------
const QUOTA_PER_UNIT = 500000;
const BOOT = Date.now();
const MOCK_TOKEN_TTL_SEC = 300;
// drain 单位：美元/分钟（换算成 $/天 约为 ×1440）
const MOCK_ACCOUNTS = {
  "np-pro": { name: "演示·Pro账号", grantUsd: 200, baseUsedUsd: 41.2, drain: 0.006 },
  "np-key": { name: "演示·Key账号", grantUsd: 50, baseUsedUsd: 18.6, drain: 0.0025 },
  "s2-team": { name: "演示·拼车团队", grantUsd: 100, baseUsedUsd: 63.5, drain: 0.0045 },
  "s2-low": { name: "演示·即将耗尽", grantUsd: 20, baseUsedUsd: 17.4, drain: 0.002 },
  "s2-pw": { name: "演示·账密登录", grantUsd: 150, baseUsedUsd: 25.8, drain: 0.0055 },
};
function mockState(acc) {
  const a = MOCK_ACCOUNTS[acc] || MOCK_ACCOUNTS["np-pro"];
  const minutes = (Date.now() - BOOT) / 60000;
  const used = Math.min(a.baseUsedUsd + minutes * a.drain, a.grantUsd);
  return { name: a.name, grantUsd: a.grantUsd, usedUsd: used, drain: a.drain };
}
const mock = express.Router();
const needAuth = (req, res) => {
  if (!req.get("authorization")) { res.status(401).json({ message: "未授权" }); return false; }
  return true;
};
mock.get("/newapi/:acc/api/user/self", (req, res) => {
  if (!needAuth(req, res)) return;
  const s = mockState(req.params.acc);
  res.json({
    success: true,
    data: {
      username: s.name,
      quota: Math.round((s.grantUsd - s.usedUsd) * QUOTA_PER_UNIT),
      used_quota: Math.round(s.usedUsd * QUOTA_PER_UNIT),
      request_count: 1200 + Math.round(s.usedUsd * 20),
    },
  });
});
mock.get("/newapi/:acc/dashboard/billing/subscription", (req, res) => {
  if (!needAuth(req, res)) return;
  const s = mockState(req.params.acc);
  res.json({ object: "billing_subscription", hard_limit_usd: s.grantUsd, access_until: 0 });
});
mock.get("/newapi/:acc/dashboard/billing/usage", (req, res) => {
  const s = mockState(req.params.acc);
  res.json({ object: "list", total_usage: Math.round(s.usedUsd * 100) });
});
// Sub2API 模拟：登录 / 刷新 / me（契约与 Wei-Shaw/sub2api 一致）
mock.post("/sub2api/:acc/api/v1/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (email !== "demo@example.com" || password !== "demo123") {
    return res.status(401).json({ code: 401, message: "invalid email or password", reason: "INVALID_CREDENTIALS" });
  }
  const acc = req.params.acc;
  res.json({
    code: 0,
    message: "success",
    data: {
      access_token: `mt.${acc}.${Date.now() + MOCK_TOKEN_TTL_SEC * 1000}`,
      refresh_token: `mr.${acc}`,
      expires_in: MOCK_TOKEN_TTL_SEC,
      token_type: "Bearer",
    },
  });
});
mock.post("/sub2api/:acc/api/v1/auth/refresh", (req, res) => {
  const rt = req.body?.refresh_token || "";
  if (!rt.startsWith("mr.")) {
    return res.status(401).json({ code: 401, message: "invalid refresh token" });
  }
  const acc = req.params.acc;
  res.json({
    code: 0,
    message: "success",
    data: {
      access_token: `mt.${acc}.${Date.now() + MOCK_TOKEN_TTL_SEC * 1000}`,
      refresh_token: `mr.${acc}`,
      expires_in: MOCK_TOKEN_TTL_SEC,
      token_type: "Bearer",
    },
  });
});
mock.get("/sub2api/:acc/api/v1/auth/me", (req, res) => {
  const auth = req.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ code: "UNAUTHORIZED", message: "missing token" });
  if (token.startsWith("mt.")) {
    const exp = Number(token.split(".")[2] || 0);
    if (!exp || exp < Date.now()) {
      return res.status(401).json({ code: "TOKEN_EXPIRED", message: "Token has expired" });
    }
  } else if (token !== "demo-jwt") {
    return res.status(401).json({ code: "INVALID_TOKEN", message: "invalid token" });
  }
  const acc = req.params.acc;
  const s = mockState(acc);
  const balance = Number((s.grantUsd - s.usedUsd).toFixed(2));
  if (acc === "s2-pw") {
    // 余额制账号：balance + total_recharged（对应真实 Sub2API 的响应形态）
    res.json({
      code: 0, message: "success",
      data: { username: s.name, email: "demo@example.com", balance, total_recharged: s.grantUsd, frozen_balance: 0 },
    });
  } else {
    // 配额制账号
    res.json({
      code: 0, message: "success",
      data: { username: s.name, balance, quota: s.grantUsd, quota_used: Number(s.usedUsd.toFixed(2)) },
    });
  }
});
// 管理员数据看板（与真实 new-api 的 /api/data/、/api/data/users 契约一致），
// 生成确定性的演示数据：白天高、周末低、多模型/多用户权重
function mockOwnRows(startSec, endSec, kind) {
  const models = [["claude-sonnet-4-5", 5], ["gpt-4o", 3], ["deepseek-v3", 1.5], ["gemini-2.5-pro", 0.8]];
  const users = [["alice", 4], ["bob", 2.5], ["carol", 1.2], ["dave", 0.6]];
  const list = kind === "user" ? users : models;
  const rows = [];
  const HOUR = 3600;
  for (let t = Math.ceil(startSec / HOUR) * HOUR; t <= endSec; t += HOUR) {
    const hod = Math.floor(t / HOUR) % 24;
    const dow = Math.floor(t / 86400 + 4) % 7; // epoch 是周四
    const rhythm = (0.35 + Math.max(0, Math.sin(((hod - 3) / 24) * 2 * Math.PI))) * (dow === 0 || dow === 6 ? 0.55 : 1);
    for (const [name, w] of list) {
      const noise = ((t * 2654435761 + name.length * 2246822519) >>> 16) % 1000 / 1000; // 确定性噪声
      const usd = w * rhythm * (0.5 + noise) * 0.03;
      rows.push({
        [kind === "user" ? "username" : "model_name"]: name,
        created_at: t,
        count: Math.max(1, Math.round(usd * 40)),
        quota: Math.round(usd * QUOTA_PER_UNIT),
        token_used: Math.round(usd * 250000),
      });
    }
  }
  return rows;
}
mock.get("/newapi/:acc/api/data/", (req, res) => {
  if (!needAuth(req, res)) return;
  res.json({ success: true, message: "", data: mockOwnRows(Number(req.query.start_timestamp) || 0, Number(req.query.end_timestamp) || 0, "model") });
});
mock.get("/newapi/:acc/api/data/users", (req, res) => {
  if (!needAuth(req, res)) return;
  res.json({ success: true, message: "", data: mockOwnRows(Number(req.query.start_timestamp) || 0, Number(req.query.end_timestamp) || 0, "user") });
});
mock.get("/newapi/:acc/api/user/", (req, res) => {
  if (!needAuth(req, res)) return;
  res.json({
    success: true, message: "",
    data: { items: [
      { id: 1, username: "root", display_name: "Root", role: 100, status: 1, quota: 99500000, used_quota: 4200000 },
      { id: 2, username: "alice", display_name: "", role: 1, status: 1, quota: 5250000, used_quota: 61500000 },
      { id: 3, username: "bob", display_name: "", role: 1, status: 1, quota: 1200000, used_quota: 38200000 },
      { id: 4, username: "carol", display_name: "", role: 1, status: 1, quota: 0, used_quota: 17800000 },
      { id: 5, username: "dave", display_name: "", role: 10, status: 1, quota: 800000, used_quota: 9200000 },
    ], total: 5 },
  });
});
mock.get("/newapi/:acc/api/channel/", (req, res) => {
  if (!needAuth(req, res)) return;
  const local = `http://${HOST}:${PORT}/mock`;
  res.json({
    success: true, message: "",
    data: { items: [
      { id: 1, name: "上游A-高速", type: 1, status: 1, base_url: `${local}/newapi/np-pro` },
      { id: 2, name: "上游A-备用", type: 1, status: 2, base_url: `${local}/newapi/np-pro` },
      { id: 3, name: "拼车团队", type: 14, status: 1, base_url: `${local}/sub2api/s2-team` },
      { id: 4, name: "官方直连-DeepSeek", type: 43, status: 1, base_url: "" },
      { id: 5, name: "包月自建", type: 14, status: 1, base_url: "http://10.0.0.8:13800" },
    ], total: 5 },
  });
});

// 用户仪表盘统计（与真实 Sub2API 的 /usage/dashboard/stats 契约一致）
mock.get("/sub2api/:acc/api/v1/usage/dashboard/stats", (req, res) => {
  if (!needAuth(req, res)) return;
  const s = mockState(req.params.acc);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const minToday = (Date.now() - midnight.getTime()) / 60000;
  const todayCost = Math.min(minToday * s.drain, s.usedUsd);
  res.json({
    code: 0, message: "success",
    data: {
      today_actual_cost: Number(todayCost.toFixed(4)),
      today_cost: Number((todayCost * 1.15).toFixed(4)),
      today_requests: Math.round(todayCost * 40),
      today_tokens: Math.round(todayCost * 250000),
      total_actual_cost: Number(s.usedUsd.toFixed(4)),
    },
  });
});
app.use("/mock", mock);

async function seedDemo() {
  const local = `http://${HOST}:${PORT}/mock`;
  if (store.list().length === 0) {
    const demos = [
      { name: "Pro 中转站（演示）", type: "newapi", baseUrl: `${local}/newapi/np-pro`, accessToken: "demo-token", userId: "1" },
      { name: "Key 计费站（演示）", type: "newapi-key", baseUrl: `${local}/newapi/np-key`, apiKey: "sk-demo-key" },
      { name: "拼车团队（演示）", type: "sub2api", baseUrl: `${local}/sub2api/s2-team`, accessToken: "demo-jwt" },
      { name: "低余额告警（演示）", type: "sub2api", baseUrl: `${local}/sub2api/s2-low`, accessToken: "demo-jwt", lowBalanceUsd: 5 },
    ];
    for (const d of demos) await store.add({ ...d, demo: true });
  }
  // 追加「账密自动续期」演示站（仅当全部是演示站且还没有该类型时）
  const list = store.list();
  if (list.every((s) => s.demo) && !list.some((s) => s.type === "sub2api-password")) {
    await store.add({
      name: "账密自动续期（演示）",
      type: "sub2api-password",
      baseUrl: `${local}/sub2api/s2-pw`,
      email: "demo@example.com",
      password: "demo123",
      demo: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 余额刷新 + 历史 + 告警
// ---------------------------------------------------------------------------
// 同一站点同时只允许一个刷新在途：定时器、手动刷新、保存后刷新可能重叠，
// 并发会重复发告警、并让 Sub2API 轮换的 refresh_token 相互作废
const inflightRefresh = new Map();
function refreshOne(station) {
  if (station.type === "fixed") return Promise.resolve(null); // 固定成本渠道不访问任何接口
  const running = inflightRefresh.get(station.id);
  if (running) return running;
  const p = doRefreshOne(station).finally(() => inflightRefresh.delete(station.id));
  inflightRefresh.set(station.id, p);
  return p;
}

// 查询失败后的快速重试：不等下一次轮询（可能是几分钟），隔 errorRetrySec 秒再探一次，
// 好尽快累积「连续失败」次数、达到通知阈值。只在仍失败且未达阈值时续排，天然自限。
const errorRetryTimers = new Map();
function scheduleErrorRetry(station) {
  const old = errorRetryTimers.get(station.id);
  if (old) { clearTimeout(old); errorRetryTimers.delete(station.id); }

  const r = store.rules || {};
  const delaySec = Number(r.errorRetrySec);
  if (!Number.isFinite(delaySec) || delaySec <= 0) return; // 0/未配置 = 关闭快速重试

  const failing = station.balance && !station.balance.ok;
  const threshold = Math.max(1, Math.floor(Number(r.errorThreshold) || 1));
  const count = station.alertState?.errorCount || 0;
  if (!failing || count >= threshold) return; // 已恢复或已达阈值（已通知）就交回常规轮询

  const t = setTimeout(() => {
    errorRetryTimers.delete(station.id);
    const cur = store.get(station.id); // 期间可能已被删除
    if (cur) refreshOne(cur).catch(() => {});
  }, delaySec * 1000);
  if (t.unref) t.unref();
  errorRetryTimers.set(station.id, t);
}

async function doRefreshOne(station) {
  const { result } = await queryStation(station);
  // 查询在途期间站点可能已被删除：丢弃结果，避免复活历史记录或发幽灵告警
  if (!store.get(station.id)) return result;
  station.balance = result;
  if (result.ok) history.append(station.id, result.remaining, result.used);

  // 告警评估（异步失败不影响主流程）
  try {
    const prediction = history.predict(station.id);
    const next = await evaluateStation(
      station, prediction, store.rules, store.channels, store.settings.lowBalanceUsd
    );
    if (next) station.alertState = next;
  } catch (err) {
    console.error("告警评估失败:", err?.message);
  }

  await store.save(); // balance / s2Tokens / alertState 一并落盘
  scheduleErrorRetry(station); // 失败未达阈值则安排一次快速重试
  return result;
}

async function refreshAll() {
  return Promise.all(store.list().map((s) => refreshOne(s)));
}

// ---------------------------------------------------------------------------
// 认证接口（不需要会话）
// ---------------------------------------------------------------------------
app.post("/api/auth/login", (req, res) => {
  const ip = req.ip || "unknown";
  if (sessions.isLocked(ip)) {
    return res.status(429).json({ error: "尝试次数过多，请 5 分钟后再试" });
  }
  const { username, password } = req.body || {};
  const auth = store.auth;
  const userOk = String(username || "") === auth.username;
  const passOk = verifyPassword(password || "", auth.salt, auth.hash);
  if (!userOk || !passOk) {
    sessions.recordFailure(ip);
    return res.status(401).json({ error: "用户名或密码错误" });
  }
  sessions.recordSuccess(ip);
  const token = sessions.issue(auth.username);
  res.setHeader("Set-Cookie", sessions.cookieHeader(token));
  res.json({ ok: true, username: auth.username, isDefaultPassword: !!auth.isDefault });
});

// ---- 以下 /api/* 全部需要登录 -----------------------------------------------
app.use("/api", sessions.middleware());

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", sessions.clearCookieHeader());
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ username: req.session.u, isDefaultPassword: !!store.auth.isDefault });
});

app.post("/api/auth/password", async (req, res) => {
  const { oldPassword, newPassword, username } = req.body || {};
  if (!verifyPassword(oldPassword || "", store.auth.salt, store.auth.hash)) {
    return res.status(400).json({ error: "原密码错误" });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "新密码至少 6 位" });
  }
  await store.setPassword(username ? String(username).trim() : undefined, String(newPassword));
  // 旧会话继续有效（同一秘钥签名）；仅更新凭证
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
app.get("/api/meta", (req, res) => {
  res.json({
    types: STATION_TYPES,
    channelTypes: CHANNEL_TYPES,
    settings: store.settings,
    rules: store.rules,
    app: APP_INFO,
  });
});

app.get("/api/stations", (req, res) => {
  res.json({ stations: store.list().map(redact), settings: store.settings });
});

app.post("/api/stations", async (req, res) => {
  const b = req.body || {};
  if (!b.type || !STATION_TYPES.some((t) => t.value === b.type))
    return res.status(400).json({ error: "无效的中转站类型" });
  if (!b.baseUrl && b.type !== "fixed") return res.status(400).json({ error: "请填写站点地址" });
  const s = await store.add(b);
  refreshOne(s).catch(() => {});
  res.json({ station: redact(s) });
});

app.put("/api/stations/:id", async (req, res) => {
  const b = req.body || {};
  if ("type" in b && !STATION_TYPES.some((t) => t.value === b.type))
    return res.status(400).json({ error: "无效的中转站类型" });
  const s = await store.update(req.params.id, b);
  if (!s) return res.status(404).json({ error: "未找到该中转站" });
  refreshOne(s).catch(() => {});
  res.json({ station: redact(s) });
});

app.delete("/api/stations/:id", async (req, res) => {
  const ok = await store.remove(req.params.id);
  history.remove(req.params.id);
  res.json({ ok });
});

app.post("/api/stations/:id/refresh", async (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).json({ error: "未找到该中转站" });
  const balance = await refreshOne(s);
  res.json({ balance, station: redact(s) });
});

app.post("/api/refresh", async (req, res) => {
  await refreshAll();
  res.json({ stations: store.list().map(redact), refreshedAt: new Date().toISOString() });
});

// 总览图表用：全部站点的余额历史（只含时间与余额，前端聚合）
app.get("/api/history/overview", (req, res) => {
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
  res.json({
    hours,
    series: store.list().map((s) => ({
      id: s.id,
      name: s.name,
      points: history.points(s.id, hours).map((p) => [p[0], p[1]]),
    })),
  });
});

// 历史数据（趋势图用）
app.get("/api/stations/:id/history", (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).json({ error: "未找到该中转站" });
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 72));
  res.json({
    points: history.points(s.id, hours),
    prediction: history.predict(s.id),
  });
});

// ---- 用量统计（分模型 / 分时间）------------------------------------------------
// 各站点用量接口逐个查开销不小，按范围缓存 60 秒
const usageCache = new Map();
app.get("/api/usage", async (req, res) => {
  const range = ["today", "24h", "7d", "30d"].includes(req.query.range) ? req.query.range : "today";
  // 用浏览器时区分桶：sub2api 站点面板也是按浏览器时区统计的，
  // 这样「今天」的口径和用户在站点上看到的完全一致
  let tz = String(req.query.tz || "");
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = ""; }
  if (!tz) tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const cacheKey = `${range}|${tz}`;
  const hit = usageCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60000) return res.json(hit.payload);

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
  res.json(payload);
});

// ---- 「我的站点」下游分析（分时段 / 分模型 / 分用户 + 消费预测）------------------
const ownCache = new Map();
app.get("/api/own/analytics", async (req, res) => {
  const own = store.list().find((s) => s.isOwn && s.type === "newapi");
  if (!own) {
    return res.status(400).json({
      error: "还没有标记「我的中转站」：添加/编辑你的 New API 站点，勾选「这是我自己的中转站」（需管理员令牌）",
    });
  }
  const range = ["today", "7d", "30d"].includes(req.query.range) ? req.query.range : "7d";
  let tz = String(req.query.tz || "");
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = ""; }
  if (!tz) tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const cacheKey = `${range}|${tz}`;
  const hit = ownCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 120000) return res.json(hit.payload);

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
      ownUsers = await getOwnUsers(own);
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
      profit: await computeProfit(own, incomeUsd, adminUsageUsd, { startMs, now, tz, range, resold }),
      generatedAt: new Date().toISOString(),
    };
    ownCache.set(cacheKey, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: err?.message || String(err) });
  }
});

// 用户列表拉取开销不小，缓存 10 分钟
let ownUsersCache = { at: 0, stationId: null, list: null };
async function getOwnUsers(own) {
  if (!ownUsersCache.list || ownUsersCache.stationId !== own.id || Date.now() - ownUsersCache.at > 600000) {
    ownUsersCache = { at: Date.now(), stationId: own.id, list: await queryOwnUsers(own) };
  }
  return ownUsersCache.list;
}

// ---- 管理员/root API Key 转售标记 ---------------------------------------------
// 列出所有管理员/root 账号（role>=10）名下的 API Key，标注哪些已被标记为转售。
app.get("/api/own/admin-keys", async (req, res) => {
  const own = store.list().find((s) => s.isOwn && s.type === "newapi");
  if (!own) return res.status(400).json({ error: "还没有标记「我的中转站」（需 New API 管理员令牌）" });
  try {
    const users = await getOwnUsers(own);
    const admins = (users || []).filter((u) => u.role >= 10);
    const resold = own.resoldAdminKeys || [];
    const flagged = new Set(resold.map((k) => `${k.username} ${k.tokenName}`));
    const accounts = [];
    for (const u of admins) {
      // new-api 的 /api/token/ 只能列「当前登录账号」名下的 Key，无法用 New-Api-User
      // 越权枚举其它账号（如 root）；此时 enumerable=false，前端退回手动填 Key 名。
      try {
        const tokens = (await queryAdminTokens(own, u.id)).map((t) => ({
          name: t.name,
          status: t.status,
          usedUsd: Math.round(t.usedUsd * 100) / 100,
          flagged: flagged.has(`${u.username} ${t.name}`),
        }));
        accounts.push({ username: u.username, role: u.role, enumerable: true, tokens: tokens.sort((a, b) => b.usedUsd - a.usedUsd) });
      } catch (err) {
        // 无法枚举：仍回显该账号已标记的 Key，让用户能看到/取消
        const names = resold.filter((k) => k.username === u.username).map((k) => k.tokenName);
        accounts.push({
          username: u.username, role: u.role, enumerable: false,
          error: err?.message || String(err),
          tokens: names.map((name) => ({ name, flagged: true, usedUsd: null })),
        });
      }
    }
    res.json({ accounts });
  } catch (err) {
    res.status(502).json({ error: err?.message || String(err) });
  }
});

// 保存转售 Key 标记：body { keys: [{username, tokenName}] }
app.put("/api/own/admin-keys", async (req, res) => {
  const own = store.list().find((s) => s.isOwn && s.type === "newapi");
  if (!own) return res.status(400).json({ error: "还没有标记「我的中转站」" });
  const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
  await store.update(own.id, { resoldAdminKeys: keys });
  ownCache.clear(); // 影响利润口径，清缓存让下次分析重算
  res.json({ resoldAdminKeys: own.resoldAdminKeys });
});

// 渠道列表拉取开销不小，缓存 10 分钟
let ownChannelsCache = { at: 0, stationId: null, list: null };

/**
 * 转售的管理员/root Key 消费重归：从「管理员消耗（成本）」移入「下游收入」。
 * 对每个 (username, tokenName) 用日志统计接口取窗内消费额度（美元）后汇总。
 * 单个 Key 查询失败记为 0 并附带错误，不影响其余；返回调整后的两个口径 + 明细。
 */
async function computeResold(own, incomeUsd, adminUsageUsd, startMs, endMs) {
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
async function computeProfit(own, incomeUsd, adminUsageUsd, { startMs, now, tz, range, resold }) {
  const r2 = (v) => Math.round(v * 100) / 100;
  try {
    if (!ownChannelsCache.list || ownChannelsCache.stationId !== own.id || Date.now() - ownChannelsCache.at > 600000) {
      ownChannelsCache = { at: Date.now(), stationId: own.id, list: await queryOwnChannels(own) };
    }
    const channels = ownChannelsCache.list;
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

// ---- 每日日报 ------------------------------------------------------------------
const rptCny = (v) => "¥" + Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rptTok = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return +(n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return +(n / 1e3).toFixed(1) + "K";
  return String(n);
};
const pctDelta = (cur, base) => {
  if (!(base > 0)) return "";
  const d = ((cur - base) / base) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
};

// 汇总昨日（服务器时区自然日）经营情况，返回 {title, text}
async function buildDailyReport() {
  const own = store.list().find((s) => s.isOwn && s.type === "newapi");
  if (!own) throw new Error("还没有标记「我的中转站」，无法生成日报");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const dayEnd = midnight.getTime();
  const dayStart = dayEnd - 86400000;
  const wideStart = dayEnd - 34 * 86400000;
  const ownRate = own.cnyPerUsd != null && own.cnyPerUsd > 0 ? own.cnyPerUsd : 1;

  const [modelRows, userRows] = await Promise.all([
    queryOwnData(own, wideStart, Date.now(), "model"),
    queryOwnData(own, dayStart, dayEnd, "user"),
  ]);
  let ownUsers = null;
  try { ownUsers = await getOwnUsers(own); } catch { /* 降级：不区分管理员 */ }
  const adminSet = new Set((ownUsers || []).filter((u) => u.role >= 10).map((u) => u.username));

  // 昨日聚合
  const agg = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const a = m.get(r.key) || { key: r.key, tokens: 0, cost: 0, requests: 0 };
      a.tokens += r.tokens; a.cost += r.cost; a.requests += r.requests;
      m.set(r.key, a);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  };
  const yRows = modelRows.filter((r) => r.t >= dayStart && r.t < dayEnd);
  const byModel = agg(yRows);
  const byUser = agg(userRows).map((u) => ({ ...u, isAdmin: adminSet.has(u.key) }));
  const totalCost = byModel.reduce((a, m) => a + m.cost, 0);
  const totalTokens = byModel.reduce((a, m) => a + m.tokens, 0);
  const totalReqs = byModel.reduce((a, m) => a + m.requests, 0);
  const rawIncomeUsd = byUser.filter((u) => !u.isAdmin).reduce((a, u) => a + u.cost, 0);
  const rawAdminUsd = byUser.filter((u) => u.isAdmin).reduce((a, u) => a + u.cost, 0);
  // 转售的管理员 Key 消费改计入收入（与「我的站点」页口径一致）
  const resold = await computeResold(own, rawIncomeUsd, rawAdminUsd, dayStart, dayEnd);
  const incomeUsd = resold.incomeUsd;
  const adminUsd = resold.adminUsageUsd;

  // 昨日利润（成本窗口 = 昨日自然日）
  const profit = await computeProfit(own, incomeUsd, adminUsd, { startMs: dayStart, now: dayEnd, tz, range: "7d", resold });

  // 日序列（近 34 天，不含今天）→ 环比与预测
  const dmap = new Map();
  for (const r of modelRows) {
    if (r.t >= dayEnd) continue;
    const dt = parseDateLabel(dateStrInTz(r.t, tz), tz);
    dmap.set(dt, (dmap.get(dt) || 0) + r.cost);
  }
  const daily = [];
  if (dmap.size) {
    const firstDay = Math.min(...dmap.keys());
    for (let t = firstDay; t < dayEnd; t += 86400000) daily.push({ t, cost: dmap.get(t) || 0 });
  }
  const prev = daily.length >= 2 ? daily[daily.length - 2].cost : null;
  const avg7 = daily.slice(-7).reduce((a, x) => a + x.cost, 0) / Math.min(7, daily.length || 1);
  const fc = forecastDaily(daily, 7);

  // 上游余额状态（排除自有站与固定成本渠道）
  const upstreams = store.list().filter((s) => !s.isOwn && s.type !== "fixed");
  const upLines = upstreams.map((s) => {
    const rate = s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1;
    const b = s.balance;
    if (!b) return `- ${s.name}：尚未查询`;
    if (!b.ok) return `- ${s.name}：⚠ 查询失败（${b.error || "未知错误"}）`;
    const p = history.predict(s.id);
    let tail = "近期无消耗";
    if (p && p.etaDays != null) tail = `≈${rptCny(p.burnPerDay * rate)}/天 · 预计 ${fmtEta(p.etaDays)}后耗尽${p.etaDays <= 3 ? " ⚠" : ""}`;
    return `- ${s.name}：${rptCny(b.remaining * rate)}（${tail}）`;
  });

  const balanceTotal = (ownUsers || [])
    .filter((u) => u.role < 10)
    .reduce((a, u) => a + u.quotaUsd, 0) * ownRate;

  const dateLabel = dateStrInTz(dayStart, tz);
  const dow = "日一二三四五六"[new Date(dayStart).getDay()];
  const L = [];
  L.push(`【${own.name} 日报】${dateLabel}（周${dow}）`);
  L.push("");
  L.push("■ 经营概览");
  L.push(`昨日消费：${rptCny(totalCost * ownRate)}${prev != null ? `（环比 ${pctDelta(totalCost, prev)}，近7天日均 ${rptCny(avg7 * ownRate)} ${pctDelta(totalCost, avg7)}）` : ""}`);
  L.push(`收入(不含管理员)：${rptCny(incomeUsd * ownRate)} ｜ 管理员消耗：${rptCny(adminUsd * ownRate)}`);
  if (profit && !profit.error) {
    L.push(`成本：${rptCny(profit.totalCostCny)} ｜ 利润：${rptCny(profit.profitCny)}${profit.marginPct != null ? `（利润率 ${profit.marginPct}%）` : ""}`);
  }
  L.push("");
  L.push("■ 用量");
  L.push(`请求 ${totalReqs.toLocaleString("en-US")} 次 ｜ Tokens ${rptTok(totalTokens)} ｜ 活跃用户 ${byUser.length} 个`);
  L.push("");
  L.push("■ Top 模型（按消费）");
  byModel.slice(0, 5).forEach((m, i) => L.push(`${i + 1}. ${m.key}  ${rptCny(m.cost * ownRate)}（${rptTok(m.tokens)} tokens · ${m.requests.toLocaleString("en-US")} 次）`));
  if (!byModel.length) L.push("（昨日无消费）");
  L.push("");
  L.push("■ Top 用户（按消费）");
  byUser.slice(0, 5).forEach((u, i) => L.push(`${i + 1}. ${u.key}${u.isAdmin ? "（管理员）" : ""}  ${rptCny(u.cost * ownRate)}（${rptTok(u.tokens)} tokens）`));
  if (!byUser.length) L.push("（昨日无消费）");
  if (profit && !profit.error && profit.costs.length) {
    L.push("");
    L.push("■ 成本明细（昨日）");
    const MODE = { usage: "按用量", fixed: "固定摊销", history: "余额推算≈" };
    profit.costs.forEach((c) => L.push(`- ${c.name}  ${rptCny(c.cny)}（${MODE[c.mode] || c.mode}${c.note ? " · " + c.note : ""}）`));
    if (profit.unmatched.length) L.push(`（另有 ${profit.unmatched.length} 组渠道未纳入成本计算）`);
  }
  L.push("");
  L.push("■ 上游余额");
  L.push(...(upLines.length ? upLines : ["（暂无上游站点）"]));
  if (ownUsers) {
    L.push("");
    L.push(`■ 用户余额合计：${rptCny(balanceTotal)}（预收，${ownUsers.filter((u) => u.role < 10).length} 个用户）`);
  }
  if (fc) {
    L.push("");
    L.push("■ 展望");
    L.push(`今天预计：≈${rptCny(fc.points[0].cost * ownRate)}（区间 ${rptCny(fc.points[0].lo * ownRate)} ~ ${rptCny(fc.points[0].hi * ownRate)}）`);
    L.push(`未来 7 天预计：≈${rptCny(fc.nextTotal * ownRate)}（区间 ${rptCny((fc.nextLo ?? 0) * ownRate)} ~ ${rptCny((fc.nextHi ?? 0) * ownRate)}）`);
    L.push(`（${fc.method} · 基于 ${fc.sampleDays} 天 · 回测日均偏差 ±${fc.backtestWapePct ?? "?"}%）`);
  }
  const html = buildReportHtml({
    own, dateLabel, dow, ownRate,
    totalCost, prev, avg7, incomeUsd, adminUsd, profit,
    totalReqs, totalTokens, activeUsers: byUser.length,
    byModel, byUser, daily, fc, upstreams, balanceTotal,
    userCount: (ownUsers || []).filter((u) => u.role < 10).length, hasUsers: !!ownUsers,
  });
  return { title: `【日报】${own.name} ${dateLabel}`, text: L.join("\n"), html };
}

// 邮件安全的 HTML 日报：全内联样式 + 表格排版，图表用色块/条形实现
//（Gmail 会剥离 SVG、屏蔽 data:URI 图片，这是全客户端可靠的做法）
function buildReportHtml(d) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const C = { ink: "#1c1c1e", sub: "#6e6e73", line: "#e5e5ea", blue: "#0a84ff", blueSoft: "#b9d6f8", green: "#1f9d4d", red: "#d03b3b", track: "#eef1f5", bg: "#f5f6f8" };
  const font = "font-family:-apple-system,'PingFang SC','Segoe UI',sans-serif;";
  const money = (v) => rptCny(v);

  const kpi = (label, value, sub, color) => `
    <td width="25%" style="padding:6px"><div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:12px 14px">
      <div style="${font}font-size:11px;color:${C.sub}">${esc(label)}</div>
      <div style="${font}font-size:20px;font-weight:700;color:${color || C.ink};margin-top:2px">${esc(value)}</div>
      ${sub ? `<div style="${font}font-size:11px;color:${C.sub};margin-top:2px">${esc(sub)}</div>` : ""}
    </div></td>`;

  const section = (title, inner) => `
    <tr><td style="padding:18px 12px 6px;${font}font-size:14px;font-weight:700;color:${C.ink}">${esc(title)}</td></tr>
    <tr><td style="padding:0 12px">${inner}</td></tr>`;

  // 14 天消费柱状图（表格 + 色块；昨日高亮）
  const days = d.daily.slice(-14);
  const maxDay = Math.max(...days.map((x) => x.cost), 0.01);
  const trendCols = days.map((x, i) => {
    const h = Math.max(3, Math.round((x.cost / maxDay) * 72));
    const last = i === days.length - 1;
    return `<td align="center" valign="bottom" style="padding:0 2px">
      <div title="${esc(money(x.cost * d.ownRate))}" style="height:${h}px;background:${last ? C.blue : C.blueSoft};border-radius:3px 3px 0 0"></div>
    </td>`;
  }).join("");
  const fmtMD = (t) => { const dd = new Date(t); return `${dd.getMonth() + 1}/${dd.getDate()}`; };
  const trend = days.length ? `
    <div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:14px">
      <table width="100%" cellpadding="0" cellspacing="0" style="height:76px"><tr>${trendCols}</tr></table>
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="${font}font-size:10px;color:${C.sub}">${fmtMD(days[0].t)}</td>
        <td align="right" style="${font}font-size:10px;color:${C.sub}">昨日 ${fmtMD(days[days.length - 1].t)} · ${esc(money(days[days.length - 1].cost * d.ownRate))}</td>
      </tr></table>
    </div>` : "";

  // 条形榜单（名称 + 比例条 + 数值）
  const barList = (rows, nameOf, valOf, valText) => {
    const max = Math.max(...rows.map(valOf), 1e-9);
    return `<div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:6px 14px">
      ${rows.map((r) => `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0"><tr>
        <td width="34%" style="${font}font-size:12px;color:${C.ink};white-space:nowrap;overflow:hidden">${nameOf(r)}</td>
        <td style="padding:0 10px"><div style="background:${C.track};border-radius:4px"><div style="width:${Math.max(2, Math.round(valOf(r) / max * 100))}%;height:8px;background:${C.blue};border-radius:4px"></div></div></td>
        <td width="20%" align="right" style="${font}font-size:12px;color:${C.ink};font-weight:600;white-space:nowrap">${valText(r)}</td>
      </tr></table>`).join("")}
    </div>`;
  };

  const modelBars = d.byModel.length
    ? barList(d.byModel.slice(0, 5), (m) => esc(m.key), (m) => m.cost, (m) => esc(money(m.cost * d.ownRate)))
    : `<div style="${font}font-size:12px;color:${C.sub}">昨日无消费</div>`;
  const userBars = d.byUser.length
    ? barList(d.byUser.slice(0, 5),
        (u) => `${esc(u.key)}${u.isAdmin ? ` <span style="color:${C.red};font-size:10px">管理员</span>` : ""}`,
        (u) => u.cost, (u) => esc(money(u.cost * d.ownRate)))
    : `<div style="${font}font-size:12px;color:${C.sub}">昨日无消费</div>`;

  const MODE = { usage: "按用量", fixed: "固定摊销", history: "余额推算≈" };
  const costRows = (d.profit && !d.profit.error && d.profit.costs.length)
    ? `<div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:6px 14px">
      ${d.profit.costs.map((c) => `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:7px 0"><tr>
          <td style="${font}font-size:12px;color:${C.ink}">${esc(c.name)} <span style="color:${C.sub};font-size:11px">${esc(MODE[c.mode] || c.mode)}${c.note ? " · " + esc(c.note) : ""}</span></td>
          <td align="right" style="${font}font-size:12px;font-weight:600;color:${C.ink}">${esc(money(c.cny))}</td>
        </tr></table>`).join("")}
      ${d.profit.unmatched.length ? `<div style="${font}font-size:11px;color:${C.sub};margin:6px 0">另有 ${d.profit.unmatched.length} 组渠道未纳入成本计算</div>` : ""}
    </div>` : "";

  const upRows = `<div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:6px 14px">
    ${d.upstreams.map((s) => {
      const rate = s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1;
      const b = s.balance;
      let status = "尚未查询", warn = false;
      if (b && !b.ok) { status = `查询失败（${b.error || "未知"}）`; warn = true; }
      else if (b) {
        const p = history.predict(s.id);
        status = p && p.etaDays != null ? `≈${money(p.burnPerDay * rate)}/天 · 预计 ${fmtEta(p.etaDays)}后耗尽` : "近期无消耗";
        warn = !!(p && p.etaDays != null && p.etaDays <= 3);
      }
      return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:7px 0"><tr>
        <td style="${font}font-size:12px;color:${C.ink}">${esc(s.name)} <span style="color:${warn ? C.red : C.sub};font-size:11px">${warn ? "⚠ " : ""}${esc(status)}</span></td>
        <td align="right" style="${font}font-size:12px;font-weight:600;color:${C.ink}">${b && b.ok ? esc(money(b.remaining * rate)) : "—"}</td>
      </tr></table>`;
    }).join("") || `<div style="${font}font-size:12px;color:${C.sub}">暂无上游站点</div>`}
  </div>`;

  const outlook = d.fc ? `
    <div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:12px 14px;${font}font-size:12px;color:${C.ink};line-height:1.9">
      今天预计 <b>≈${esc(money(d.fc.points[0].cost * d.ownRate))}</b>（区间 ${esc(money(d.fc.points[0].lo * d.ownRate))} ~ ${esc(money(d.fc.points[0].hi * d.ownRate))}）<br>
      未来 7 天预计 <b>≈${esc(money(d.fc.nextTotal * d.ownRate))}</b>（区间 ${esc(money((d.fc.nextLo ?? 0) * d.ownRate))} ~ ${esc(money((d.fc.nextHi ?? 0) * d.ownRate))}）<br>
      <span style="color:${C.sub};font-size:11px">${esc(d.fc.method)} · 基于 ${d.fc.sampleDays} 天 · 回测日均偏差 ±${d.fc.backtestWapePct ?? "?"}%</span>
    </div>` : "";

  const profitOk = d.profit && !d.profit.error;
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${C.bg}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:18px 0"><tr><td align="center">
  <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
    <tr><td style="padding:6px 12px 2px;${font}font-size:18px;font-weight:700;color:${C.ink}">${esc(d.own.name)} 日报</td></tr>
    <tr><td style="padding:0 12px 8px;${font}font-size:12px;color:${C.sub}">${esc(d.dateLabel)}（周${esc(d.dow)}）· 由 relay-monitor 生成</td></tr>
    <tr><td><table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${kpi("昨日消费", money(d.totalCost * d.ownRate), d.prev != null ? `环比 ${pctDelta(d.totalCost, d.prev)} · 7日均 ${pctDelta(d.totalCost, d.avg7)}` : "", null)}
      ${kpi("收入（不含管理员）", money(d.incomeUsd * d.ownRate), d.adminUsd > 0 ? `管理员另耗 ${money(d.adminUsd * d.ownRate)}` : "", null)}
      ${kpi("成本", profitOk ? money(d.profit.totalCostCny) : "—", "", null)}
      ${kpi("利润", profitOk ? money(d.profit.profitCny) : "—", profitOk && d.profit.marginPct != null ? `利润率 ${d.profit.marginPct}%` : "", profitOk && d.profit.profitCny >= 0 ? C.green : C.red)}
    </tr></table></td></tr>
    ${section("近 14 天消费趋势", trend)}
    ${section(`用量：请求 ${d.totalReqs.toLocaleString("en-US")} 次 · Tokens ${rptTok(d.totalTokens)} · 活跃用户 ${d.activeUsers} 个`, "")}
    ${section("Top 模型（按消费）", modelBars)}
    ${section("Top 用户（按消费）", userBars)}
    ${costRows ? section("成本明细（昨日）", costRows) : ""}
    ${section("上游余额", upRows)}
    ${d.hasUsers ? section(`用户余额合计：${money(d.balanceTotal)}（预收 · ${d.userCount} 个用户）`, "") : ""}
    ${outlook ? section("展望", outlook) : ""}
    <tr><td style="padding:16px 12px;${font}font-size:11px;color:${C.sub}">relay-monitor 每日日报 · 数据截至发送时刻</td></tr>
  </table></td></tr></table></body></html>`;
}

function reportChannels() {
  const cfg = store.settings.dailyReport || {};
  const ids = Array.isArray(cfg.channelIds) ? cfg.channelIds : [];
  return store.channels.filter((c) => c.enabled !== false && (!ids.length || ids.includes(c.id)));
}

app.post("/api/report/preview", async (req, res) => {
  try {
    res.json(await buildDailyReport());
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

app.post("/api/report/send", async (req, res) => {
  try {
    const { title, text, html } = await buildDailyReport();
    const results = await broadcast(reportChannels(), title, text, { event: "daily-report", html });
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

// 调度：每 30 秒检查（HH:MM 命中且当天未发送）
setInterval(async () => {
  const cfg = store.settings.dailyReport;
  if (!cfg?.enabled || !cfg.time) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const today = new Intl.DateTimeFormat("en-CA").format(now);
  if (hhmm !== cfg.time || cfg.lastSent === today) return;
  cfg.lastSent = today; // 先占位，避免同一分钟重复发送
  await store.save();
  try {
    const { title, text, html } = await buildDailyReport();
    await broadcast(reportChannels(), title, text, { event: "daily-report", html });
    console.log(`日报已发送（${today} ${cfg.time}）`);
  } catch (err) {
    console.error("日报发送失败:", err?.message);
  }
}, 30000);

// ---- 通知渠道 ----------------------------------------------------------------
app.get("/api/notifications", (req, res) => {
  res.json({ channels: store.channels, rules: store.rules, channelTypes: CHANNEL_TYPES });
});

app.post("/api/notifications/channels", async (req, res) => {
  const b = req.body || {};
  if (!CHANNEL_TYPES.some((t) => t.value === b.type))
    return res.status(400).json({ error: "无效的渠道类型" });
  const ch = await store.addChannel(b);
  res.json({ channel: ch });
});

app.put("/api/notifications/channels/:id", async (req, res) => {
  const ch = await store.updateChannel(req.params.id, req.body || {});
  if (!ch) return res.status(404).json({ error: "未找到该渠道" });
  res.json({ channel: ch });
});

app.delete("/api/notifications/channels/:id", async (req, res) => {
  res.json({ ok: await store.removeChannel(req.params.id) });
});

app.post("/api/notifications/test", async (req, res) => {
  const b = req.body || {};
  let channel = null;
  if (b.channelId) channel = store.channels.find((c) => c.id === b.channelId);
  else if (b.type) channel = { type: b.type, config: b.config || {} };
  if (!channel) return res.status(400).json({ error: "未找到渠道" });
  const r = await sendToChannel(
    channel,
    "【测试通知】中转站余额监控",
    `这是一条测试消息，来自 relay-monitor。\n渠道：${channel.name || channel.type}\n时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    { event: "test" }
  );
  res.json(r);
});

app.put("/api/notifications/rules", async (req, res) => {
  res.json({ rules: await store.updateRules(req.body || {}) });
});

app.put("/api/settings", async (req, res) => {
  const patch = {};
  if (req.body?.refreshIntervalSec != null)
    patch.refreshIntervalSec = Math.max(10, Number(req.body.refreshIntervalSec) || 60);
  if (req.body?.lowBalanceUsd != null)
    patch.lowBalanceUsd = Math.max(0, Number(req.body.lowBalanceUsd) || 0);
  if (req.body?.dailyReport && typeof req.body.dailyReport === "object")
    patch.dailyReport = req.body.dailyReport; // store 内部做字段校验合并
  const settings = await store.updateSettings(patch);
  restartPolling();
  // 立即刷新一轮：重置定时器后第一次触发要等满整个周期，不主动刷会显得设置没生效
  refreshAll().catch(() => {});
  res.json({ settings });
});

// 隐藏敏感凭证，仅返回是否已配置
function redact(s) {
  const { accessToken, apiKey, password, s2Tokens, ...rest } = s;
  // 今日消耗：sub2api 直接用站点仪表盘接口的值；拿不到就按余额历史推算（前端标 ≈）
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const fromSite = s.balance?.todayUsed;
  return {
    ...rest,
    hasAccessToken: !!accessToken,
    hasApiKey: !!apiKey,
    hasPassword: !!password,
    tokenInfo: s2Tokens
      ? { expiresAt: s2Tokens.expiresAt || null, lastLoginAt: s2Tokens.lastLoginAt || null }
      : null,
    prediction: history.predict(s.id),
    spark: history.sparkline(s.id, 48),
    todayUsed: fromSite ?? history.usedSince(s.id, midnight.getTime()),
    todayIsEstimate: fromSite == null,
    todayTokens: s.balance?.todayTokens ?? null,
    todayRequests: s.balance?.todayRequests ?? null,
  };
}

app.use(express.static(join(__dirname, "public")));

// ---------------------------------------------------------------------------
// 后台定时刷新
// ---------------------------------------------------------------------------
let pollTimer = null;
let pollRunning = false;
let pollSec = 0;
function restartPolling() {
  const sec = store.settings.refreshIntervalSec || 60;
  if (pollTimer && sec === pollSec) return; // 间隔没变（比如只改了阈值）就不重置节拍
  pollSec = sec;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (pollRunning) return; // 上一轮还没结束（慢站点超时可达几十秒）就跳过本轮
    pollRunning = true;
    refreshAll().catch(() => {}).finally(() => { pollRunning = false; });
  }, sec * 1000);
}

await seedDemo();
app.listen(PORT, HOST, async () => {
  console.log(`\n  中转站余额监控面板  →  http://${HOST}:${PORT}\n`);
  await refreshAll().catch(() => {});
  restartPolling();
});
