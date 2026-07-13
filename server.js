import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

import { Store } from "./lib/store.js";
import {
  queryStation, queryStationUsage, queryOwnData,
  dateStrInTz, parseDateLabel, STATION_TYPES,
} from "./lib/providers.js";
import { forecastDaily } from "./lib/forecast.js";
import { SessionManager, verifyPassword } from "./lib/auth.js";
import { History } from "./lib/history.js";
import { evaluateStation } from "./lib/alerts.js";
import { CHANNEL_TYPES, sendToChannel } from "./lib/notify.js";

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
await store.load();
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
  const running = inflightRefresh.get(station.id);
  if (running) return running;
  const p = doRefreshOne(station).finally(() => inflightRefresh.delete(station.id));
  inflightRefresh.set(station.id, p);
  return p;
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
  if (!b.baseUrl) return res.status(400).json({ error: "请填写站点地址" });
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

  const stations = await Promise.all(store.list().map(async (s) => {
    const meta = { id: s.id, name: s.name, type: s.type, cnyPerUsd: s.cnyPerUsd ?? null };
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
    const byUser = aggBy(userRows, "user");
    const payload = {
      range, tz, startMs, endMs: now,
      station: { id: own.id, name: own.name, cnyPerUsd: own.cnyPerUsd ?? null },
      byModel: aggBy(winModel, "model"),
      byUser,
      trend: [...tmap.values()].sort((a, b) => a.t - b.t),
      daily: daily.slice(-14),
      forecast: forecastDaily(daily, 7),
      generatedAt: new Date().toISOString(),
    };
    ownCache.set(cacheKey, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: err?.message || String(err) });
  }
});

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
