// 中转站余额查询适配器
// 支持三类中转站架构：
//   - newapi     : new-api / one-api 家族，使用「系统访问令牌 + 用户 ID」查询 /api/user/self
//   - newapi-key : new-api / one-api 家族，使用 OpenAI 兼容计费接口 + sk 密钥
//   - sub2api    : Sub2API，支持两种凭证模式：
//       · token    — 直接给登录 JWT，过期即失效
//       · password — 给邮箱 + 密码，自动登录换取令牌；过期时先用 refresh_token
//                    刷新（POST /api/v1/auth/refresh，令牌会轮换），刷新失败则
//                    用密码重新登录（POST /api/v1/auth/login），全自动恢复。
//
// Sub2API 接口契约（源自 Wei-Shaw/sub2api 后端源码）：
//   POST /api/v1/auth/login    body {email, password, turnstile_token?} → {code:0, data:{access_token, refresh_token, expires_in, user}}
//   POST /api/v1/auth/refresh  body {refresh_token}     → {code:0, data:{access_token, refresh_token, expires_in}}
//   GET  /api/v1/auth/me       Bearer JWT               → {code:0, data:{username, email, balance, total_recharged, ...}}
//   过期：HTTP 401，body {code:"TOKEN_EXPIRED"}；开启 2FA 的账号 login 返回 data.requires_2fa
//
//   - jucode     : JuCode 自研网关，使用「个人访问令牌 jcp-…」（控制台 → 访问令牌）
//
// JuCode 接口契约（源自站点前端 bundle）：
//   GET /v1/me                    Bearer jcp-… → {balance:"12.34", email, nickname, ...}（积分，1 积分 = 1 元）
//   GET /v1/me/stats/usage        ?start&end(ISO)&bucket=hour|day → {start, buckets:[{time, requests, errors,
//                                 cost_final_sum:"0.12", tokens_in, tokens_out, cached_tokens_in, cache_creation_tokens_in}]}
//   GET /v1/me/stats/usage-by-model  同参数 → {start, rows:[{time, model, requests, cost_final_sum, tokens_*}]}
//   GET /v1/me/stats/lifetime     → {total_cost}
//   失败：HTTP 401 {error:"invalid access token"}

import { capTokenForLogin } from "./cap.js";

// new-api / one-api 的额度单位换算：默认 500000 额度 = 1 美元
const QUOTA_PER_UNIT = 500000;
// 主动刷新缓冲：令牌剩余寿命低于该值就先刷新（与官方客户端一致）
const TOKEN_REFRESH_BUFFER_MS = 120 * 1000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

function trimBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

// 本项目的时间窗统一使用 [startMs, endMs)；new-api 的秒级参数结束值是包含式，
// 因此必须减到窗口内最后一秒，避免把“今天 00:00”计入昨日汇总。
function unixSecondWindow(startMs, endMs) {
  const start = Math.floor(startMs / 1000);
  const end = Math.max(start, Math.ceil(endMs / 1000) - 1);
  return { start, end };
}

// 发起请求：网络错误/超时抛异常；HTTP 状态由调用方判断
async function request(url, { method = "GET", headers = {}, json = null, timeoutMs = 9000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(json != null ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: json != null ? JSON.stringify(json) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { __raw: text }; }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function httpErrorMessage(r) {
  const b = r.body || {};
  const msg = b.message || b.error?.message || b.error || b.msg || `HTTP ${r.status}`;
  return String(msg).slice(0, 200);
}

// ---- new-api / one-api：访问令牌模式 ---------------------------------------
async function queryNewApi(station) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  const userId = String(station.userId || "").trim();
  if (!base) throw new Error("缺少站点地址");
  if (!token) throw new Error("缺少访问令牌 (系统访问令牌)");

  const headers = { Authorization: token };
  if (userId) headers["New-Api-User"] = userId;

  const r = await request(`${base}/api/user/self`, { headers });
  if (r.status >= 300) throw new Error(httpErrorMessage(r));
  // one-api / new-api 对无效令牌返回 HTTP 200 + {success:false}，不能当作 $0 余额
  if (r.body?.success === false) throw new Error(httpErrorMessage(r));
  const data = r.body?.data ?? r.body ?? {};
  if (data.quota == null || !Number.isFinite(Number(data.quota))) {
    throw new Error("响应中没有额度数据（quota），请检查站点地址与令牌");
  }
  const remainUnits = num(data.quota);
  const usedUnits = num(data.used_quota);

  return {
    remaining: round2(remainUnits / QUOTA_PER_UNIT),
    used: round2(usedUnits / QUOTA_PER_UNIT),
    total: round2((remainUnits + usedUnits) / QUOTA_PER_UNIT),
    currency: "USD",
    account: data.username || data.display_name || null,
    raw: { quota: remainUnits, used_quota: usedUnits, requests: num(data.request_count) },
  };
}

// ---- new-api / one-api：OpenAI 兼容计费接口 + sk 密钥 ----------------------
async function queryNewApiKey(station) {
  const base = trimBase(station.baseUrl);
  const key = String(station.apiKey || "").trim();
  if (!base) throw new Error("缺少站点地址");
  if (!key) throw new Error("缺少 API 密钥 (sk-...)");

  const headers = { Authorization: `Bearer ${key}` };
  const sub = await request(`${base}/dashboard/billing/subscription`, { headers });
  if (sub.status >= 300) throw new Error(httpErrorMessage(sub));
  // 非 JSON 200（登录页/反代错误页）或异常响应不能当作 $0 额度
  if (sub.body?.hard_limit_usd == null || !Number.isFinite(Number(sub.body.hard_limit_usd))) {
    throw new Error("响应中没有额度数据（hard_limit_usd），请检查站点地址与密钥");
  }
  const total = num(sub.body.hard_limit_usd);

  let used = 0;
  try {
    const usage = await request(`${base}/dashboard/billing/usage`, { headers });
    if (usage.status < 300) used = num(usage.body.total_usage) / 100; // total_usage 单位为美分
  } catch {
    used = 0; // 部分站点未开放 usage 接口
  }

  return {
    remaining: round2(Math.max(total - used, 0)),
    used: round2(used),
    total: round2(total),
    currency: "USD",
    account: null,
    raw: { hard_limit_usd: total, access_until: sub.body.access_until ?? null },
  };
}

// ---- Sub2API ----------------------------------------------------------------

// 解析 Sub2API 响应包裹 {code, message, data}；code 非 0 视为业务错误
function unwrapEnvelope(r, what) {
  const b = r.body || {};
  if (typeof b.code === "number" && b.code !== 0) {
    throw new Error(`${what}失败：${b.message || "code " + b.code}`);
  }
  return b.data ?? b;
}

async function sub2apiLogin(base, station, tokens) {
  const email = String(station.email || "").trim();
  const password = String(station.password || "");
  if (!email || !password) throw new Error("缺少邮箱或密码");

  const captchaToken = await capTokenForLogin(base, request);
  const r = await request(`${base}/api/v1/auth/login`, {
    method: "POST",
    json: {
      email,
      password,
      ...(captchaToken ? { turnstile_token: captchaToken } : {}),
    },
  });
  if (r.status === 401) throw new Error("登录失败：邮箱或密码错误");
  if (r.status === 429) throw new Error("登录失败：请求过于频繁（站点限流），稍后自动重试");
  if (r.status >= 300) throw new Error(`登录失败：${httpErrorMessage(r)}`);
  const data = unwrapEnvelope(r, "登录");

  if (data?.requires_2fa) {
    throw new Error("该账号开启了两步验证(2FA)，无法自动登录，请改用「登录令牌」模式");
  }
  if (!data?.access_token) throw new Error("登录响应缺少 access_token");

  tokens.accessToken = data.access_token;
  tokens.refreshToken = data.refresh_token || "";
  tokens.expiresAt = data.expires_in > 0 ? Date.now() + data.expires_in * 1000 : Date.now() + 23 * 3600 * 1000;
  tokens.lastLoginAt = new Date().toISOString();
  return true;
}

// 用 refresh_token 换新令牌；注意令牌会轮换（旧 refresh_token 立即失效）
async function sub2apiRefresh(base, tokens) {
  if (!tokens.refreshToken) return false;
  try {
    const headers = tokens.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {};
    const r = await request(`${base}/api/v1/auth/refresh`, {
      method: "POST",
      headers,
      json: { refresh_token: tokens.refreshToken },
    });
    if (r.status >= 300) return false;
    const b = r.body || {};
    if (typeof b.code === "number" && b.code !== 0) return false;
    const data = b.data ?? b;
    if (!data?.access_token || !data?.refresh_token || !(data.expires_in > 0)) return false;
    tokens.accessToken = data.access_token;
    tokens.refreshToken = data.refresh_token;
    tokens.expiresAt = Date.now() + data.expires_in * 1000;
    return true;
  } catch {
    return false;
  }
}

function parseSub2ApiMe(data) {
  const balance = num(data.balance);
  const totalRecharged = num(data.total_recharged);
  const quotaTotal = num(data.quota);
  const quotaUsed = num(data.quota_used ?? data.used_quota);

  let remaining, used, total;
  if (quotaTotal > 0) {
    // 配额制：quota / quota_used
    total = quotaTotal;
    used = quotaUsed;
    remaining = Math.max(quotaTotal - quotaUsed, 0);
  } else if (totalRecharged > 0) {
    // 余额制：balance + 历史累充
    remaining = balance;
    total = totalRecharged;
    used = Math.max(totalRecharged - balance, 0);
  } else {
    remaining = balance;
    used = quotaUsed;
    total = balance + quotaUsed;
  }

  return {
    remaining: round2(remaining),
    used: round2(used),
    total: round2(total),
    currency: "USD",
    account: data.username || data.email || data.name || null,
    raw: { balance, total_recharged: totalRecharged, quota: quotaTotal, quota_used: quotaUsed },
  };
}

async function querySub2Api(station) {
  const base = trimBase(station.baseUrl);
  if (!base) throw new Error("缺少站点地址");

  const passwordMode = station.type === "sub2api-password" || station.authMode === "password";
  // 密码模式：令牌缓存在 station.s2Tokens（由 server 持久化）
  const tokens = passwordMode ? (station.s2Tokens ||= {}) : null;
  let tokensChanged = false;

  const ensureToken = async () => {
    if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) return;
    if (await sub2apiRefresh(base, tokens)) { tokensChanged = true; return; }
    await sub2apiLogin(base, station, tokens);
    tokensChanged = true;
  };

  const bearerOf = () =>
    passwordMode ? tokens.accessToken : String(station.accessToken || station.apiKey || "").trim();

  if (passwordMode) {
    await ensureToken();
  } else if (!bearerOf()) {
    throw new Error("缺少登录令牌 (Sub2API JWT)");
  }

  const fetchMe = () =>
    request(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${bearerOf()}` } });

  let r = await fetchMe();

  // 401（TOKEN_EXPIRED / 令牌被吊销等）→ 密码模式自动恢复：先刷新，再重登录，重试一次
  if (r.status === 401 && passwordMode) {
    tokens.accessToken = "";
    if (!(await sub2apiRefresh(base, tokens))) {
      await sub2apiLogin(base, station, tokens);
    }
    tokensChanged = true;
    r = await fetchMe();
  }
  if (r.status === 401) {
    throw new Error(passwordMode ? "登录后仍被拒绝（401），请检查账号状态" : "令牌无效或已过期，请更新令牌或改用账号密码模式");
  }
  if (r.status >= 300) throw new Error(httpErrorMessage(r));

  const data = unwrapEnvelope(r, "查询");

  // 今日消耗：读取站点用户仪表盘同款接口（today_actual_cost = 今日实际扣费），
  // 与站点页面显示完全一致；老版本没有该接口时静默降级为历史推算
  let todayUsed = null, todayRequests = null, todayTokens = null;
  try {
    const st = await request(`${base}/api/v1/usage/dashboard/stats`, {
      headers: { Authorization: `Bearer ${bearerOf()}` },
    });
    if (st.status < 300 && st.body?.code === 0 && st.body.data) {
      const d = st.body.data;
      if (Number.isFinite(Number(d.today_actual_cost))) {
        todayUsed = round2(Number(d.today_actual_cost));
        todayRequests = Number.isFinite(Number(d.today_requests)) ? Number(d.today_requests) : null;
        todayTokens = Number.isFinite(Number(d.today_tokens)) ? Number(d.today_tokens) : null;
      }
    }
  } catch { /* 不影响余额查询 */ }

  return { ...parseSub2ApiMe(data), todayUsed, todayRequests, todayTokens, tokensChanged };
}

// ---- JuCode -----------------------------------------------------------------

async function jucodeGet(station, path, params) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base) throw new Error("缺少站点地址");
  if (!token) throw new Error("缺少个人访问令牌 (jcp-...)");
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const r = await request(`${base}${path}${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401) throw new Error(`访问令牌无效或已过期（${httpErrorMessage(r)}）`);
  if (r.status >= 300) throw new Error(httpErrorMessage(r));
  if (r.body?.__raw != null) throw new Error("响应不是 JSON，请检查站点地址");
  return r.body;
}

// 输入 token 不含缓存命中/写入（站点自己的 Token 构成卡片也是三者相加）
const jucodeTokens = (b) =>
  num(b.tokens_in) + num(b.tokens_out) + num(b.cached_tokens_in) + num(b.cache_creation_tokens_in) +
  num(b.audio_tokens_in) + num(b.audio_tokens_out);

async function queryJuCode(station) {
  const me = await jucodeGet(station, "/v1/me");
  if (me.balance == null || !Number.isFinite(Number(me.balance))) {
    throw new Error("响应中没有余额数据（balance），请检查站点地址与令牌");
  }
  const balance = num(me.balance);

  // 累计消费 + 今日消耗都是附加信息，失败不影响余额
  let used = 0, todayUsed = null, todayRequests = null, todayTokens = null;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const [life, today] = await Promise.allSettled([
    jucodeGet(station, "/v1/me/stats/lifetime"),
    jucodeGet(station, "/v1/me/stats/usage", {
      start: midnight.toISOString(), end: new Date().toISOString(), bucket: "hour",
    }),
  ]);
  if (life.status === "fulfilled") used = num(life.value?.total_cost);
  if (today.status === "fulfilled" && Array.isArray(today.value?.buckets)) {
    const bs = today.value.buckets;
    todayUsed = round2(bs.reduce((a, b) => a + num(b.cost_final_sum), 0));
    todayRequests = bs.reduce((a, b) => a + num(b.requests), 0);
    todayTokens = bs.reduce((a, b) => a + jucodeTokens(b), 0);
  }

  return {
    remaining: round2(balance),
    used: round2(used),
    total: round2(balance + used),
    currency: "CNY",
    account: me.nickname || me.email || me.username || null,
    raw: { balance, total_cost: used },
    todayUsed, todayRequests, todayTokens,
  };
}

async function jucodeUsage(station, { startMs, endMs, granularity, wantToday }) {
  const params = {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    bucket: granularity === "hour" ? "hour" : "day",
  };
  const [stats, byModel] = await Promise.all([
    jucodeGet(station, "/v1/me/stats/usage", params),
    jucodeGet(station, "/v1/me/stats/usage-by-model", params),
  ]);
  const models = new Map();
  for (const row of byModel?.rows || []) {
    const name = row.model || "unknown";
    const m = models.get(name) || { model: name, tokens: 0, cost: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
    m.tokens += jucodeTokens(row);
    m.cost += num(row.cost_final_sum);
    m.requests += num(row.requests);
    m.inputTokens += num(row.tokens_in) + num(row.cached_tokens_in) + num(row.cache_creation_tokens_in);
    m.outputTokens += num(row.tokens_out);
    models.set(name, m);
  }
  const trend = (stats?.buckets || []).map((b) => {
    const t = Date.parse(b.time);
    return {
      t: Number.isNaN(t) ? null : t,
      label: String(b.time ?? ""),
      tokens: jucodeTokens(b),
      cost: num(b.cost_final_sum),
      requests: num(b.requests),
    };
  }).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const out = {
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    trend,
    modelsWindow: "exact", // 接口按 start/end 精确时间过滤
  };
  if (wantToday) {
    out.summary = {
      cost: trend.reduce((a, p) => a + p.cost, 0),
      tokens: trend.reduce((a, p) => a + p.tokens, 0),
      requests: trend.reduce((a, p) => a + p.requests, 0),
    };
  }
  return out;
}

// ---- 用量明细（分模型 / 分时间）--------------------------------------------

// 指定时区下某时刻的 YYYY-MM-DD（en-CA 的日期格式正好是这个）
export function dateStrInTz(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));
}

// 某时刻 tz 相对 UTC 的偏移毫秒（东八区为 +8h）
function tzOffsetMs(tz, at) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (k) => Number(p.find((x) => x.type === k).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

// 把「2026-07-13 05:00」这类无时区标签按指定时区解析成时间戳；失败返回 null
export function parseDateLabel(s, tz) {
  if (!s) return null;
  const utc = Date.parse(String(s).replace(" ", "T") + (String(s).length <= 10 ? "T00:00:00Z" : "Z"));
  if (Number.isNaN(utc)) return null;
  return utc - tzOffsetMs(tz, utc);
}

// 小时级趋势的时区推断：站点返回的小时标签不带时区，且不同部署对 timezone
// 参数的处理不一致。把「最后一个小时桶 = 当前小时」作为锚点反推偏移，
// 得到真实时间戳（偏移取整到 15 分钟，容忍半点时区）。
function inferHourlyTimes(trend) {
  let lastNaive = null;
  for (let i = trend.length - 1; i >= 0; i--) {
    if (trend[i]._naiveUtc != null) { lastNaive = trend[i]._naiveUtc; break; }
  }
  if (lastNaive == null) return trend.map(({ _naiveUtc, ...p }) => ({ ...p, t: null }));
  const nowHour = Math.floor(Date.now() / 3600000) * 3600000;
  const offset = Math.round((lastNaive - nowHour) / 900000) * 900000;
  return trend.map(({ _naiveUtc, ...p }) => ({ ...p, t: _naiveUtc != null ? _naiveUtc - offset : null }));
}

// 取可用的 Sub2API bearer；密码模式沿用 s2Tokens 缓存并自动登录/刷新
async function sub2apiBearer(station, base, force = false) {
  const passwordMode = station.type === "sub2api-password" || station.authMode === "password";
  if (!passwordMode) {
    const t = String(station.accessToken || station.apiKey || "").trim();
    if (!t) throw new Error("缺少登录令牌 (Sub2API JWT)");
    return t;
  }
  const tokens = (station.s2Tokens ||= {});
  if (!force && tokens.accessToken && tokens.expiresAt &&
      tokens.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return tokens.accessToken;
  }
  if (force) tokens.accessToken = "";
  if (!(await sub2apiRefresh(base, tokens))) await sub2apiLogin(base, station, tokens);
  return tokens.accessToken;
}

function normSub2Models(models) {
  return (models || []).map((m) => ({
    model: m.model || "unknown",
    tokens: num(m.total_tokens),
    cost: num(m.actual_cost ?? m.cost),
    requests: num(m.requests),
    inputTokens: num(m.input_tokens),
    outputTokens: num(m.output_tokens),
  })).sort((a, b) => b.tokens - a.tokens);
}

function normSub2Trend(trend, tz, granularity) {
  const rows = (trend || []).map((p) => ({
    t: granularity === "hour" ? null : parseDateLabel(p.date, tz),
    _naiveUtc: granularity === "hour"
      ? (Number.isNaN(Date.parse(String(p.date ?? "").replace(" ", "T") + "Z")) ? null : Date.parse(String(p.date).replace(" ", "T") + "Z"))
      : null,
    label: String(p.date ?? ""),
    tokens: num(p.total_tokens),
    cost: num(p.actual_cost ?? p.cost),
    requests: num(p.requests),
  }));
  return granularity === "hour" ? inferHourlyTimes(rows) : rows.map(({ _naiveUtc, ...p }) => p);
}

async function sub2apiUsage(station, { startMs, endMs, granularity, tz, exactWindow, wantToday }) {
  const base = trimBase(station.baseUrl);
  if (!base) throw new Error("缺少站点地址");
  const lastMs = Math.max(startMs, endMs - 1);
  const params = {
    start_date: dateStrInTz(startMs, tz),
    end_date: dateStrInTz(lastMs, tz),
    granularity,
    timezone: tz,
  };
  // Sub2API 的用量接口只支持自然日参数：滚动窗口（近 24 小时）时查两天、
  // 小时趋势截取到窗口内；模型明细无法按小时截取，标记后由前端注明口径
  const finish = async (models, trend) => {
    const out = {
      models,
      trend: exactWindow ? trend.filter((p) => p.t == null || p.t >= startMs - 3600000) : trend,
      modelsWindow: exactWindow ? "date" : "exact",
    };
    // 「今天」的合计直接取站点仪表盘同款数字（today_actual_cost 等），
    // 各部署对 timezone 参数处理不一，这是唯一和站点页面显示逐字一致的口径
    if (wantToday) {
      try {
        const st = await get("/api/v1/usage/dashboard/stats", {});
        if (st.status < 300 && st.body?.code === 0 && st.body.data) {
          const d = st.body.data;
          out.summary = {
            cost: num(d.today_actual_cost),
            tokens: num(d.today_tokens),
            requests: num(d.today_requests),
          };
        }
      } catch { /* 拿不到就用 models 求和兜底 */ }
    }
    return out;
  };
  const get = async (path, extra) => {
    let bearer = await sub2apiBearer(station, base);
    let r = await request(`${base}${path}?${new URLSearchParams({ ...params, ...extra })}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (r.status === 401 && station.type === "sub2api-password") {
      bearer = await sub2apiBearer(station, base, true);
      r = await request(`${base}${path}?${new URLSearchParams({ ...params, ...extra })}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
    }
    return r;
  };

  // 首选 snapshot-v2 一次拿全；老版本站点回退到 trend + models 两个接口
  const snap = await get("/api/v1/usage/dashboard/snapshot-v2", {
    include_trend: "true", include_model_stats: "true",
  });
  if (snap.status < 300 && snap.body?.code === 0 && snap.body.data) {
    const d = snap.body.data;
    return finish(normSub2Models(d.models), normSub2Trend(d.trend, tz, granularity));
  }
  const [tr, mo] = await Promise.all([
    get("/api/v1/usage/dashboard/trend"),
    get("/api/v1/usage/dashboard/models"),
  ]);
  if (tr.status >= 300 && mo.status >= 300) throw new Error(httpErrorMessage(tr));
  return finish(
    mo.status < 300 && mo.body?.code === 0 ? normSub2Models(mo.body.data?.models) : [],
    tr.status < 300 && tr.body?.code === 0 ? normSub2Trend(tr.body.data?.trend, tz, granularity) : []
  );
}

async function newApiUsage(station, { startMs, endMs }) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw new Error("缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const window = unixSecondWindow(startMs, endMs);
  const qs = `start_timestamp=${window.start}&end_timestamp=${window.end}`;
  const r = await request(`${base}/api/data/self?${qs}`, { headers });
  if (r.status >= 300) throw new Error(httpErrorMessage(r));
  if (r.body?.success === false) throw new Error(r.body?.message || "站点未开启数据看板");
  const rows = Array.isArray(r.body?.data) ? r.body.data : null;
  if (!rows) throw new Error("站点未开启数据看板（DataExportEnabled）");

  const models = new Map(), trend = new Map();
  for (const row of rows) {
    const tokens = num(row.token_used);
    const cost = num(row.quota) / QUOTA_PER_UNIT;
    const reqs = num(row.count);
    const name = row.model_name || "unknown";
    const m = models.get(name) || { model: name, tokens: 0, cost: 0, requests: 0, inputTokens: null, outputTokens: null };
    m.tokens += tokens; m.cost += cost; m.requests += reqs;
    models.set(name, m);
    const t = num(row.created_at) * 1000;
    const tr = trend.get(t) || { t, label: "", tokens: 0, cost: 0, requests: 0 };
    tr.tokens += tokens; tr.cost += cost; tr.requests += reqs;
    trend.set(t, tr);
  }
  const modelList = [...models.values()].sort((a, b) => b.tokens - a.tokens);
  return {
    models: modelList,
    trend: [...trend.values()].sort((a, b) => a.t - b.t),
    modelsWindow: "exact", // data/self 按精确时间戳过滤，模型明细与窗口完全一致
    summary: {
      cost: modelList.reduce((a, m) => a + m.cost, 0),
      tokens: modelList.reduce((a, m) => a + m.tokens, 0),
      requests: modelList.reduce((a, m) => a + m.requests, 0),
    },
  };
}

/**
 * 「我的站点」下游数据：new-api 管理员数据看板接口。
 * kind = "model" → GET /api/data/     行按 (model_name, created_at) 聚合
 * kind = "user"  → GET /api/data/users 行按 (username, created_at) 聚合
 * 返回归一化行 [{key, t(ms), tokens, cost($), requests}]
 */
export async function queryOwnData(station, startMs, endMs, kind) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw new Error("缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const path = kind === "user" ? "/api/data/users" : "/api/data/";
  const window = unixSecondWindow(startMs, endMs);
  const qs = `start_timestamp=${window.start}&end_timestamp=${window.end}`;
  const r = await request(`${base}${path}?${qs}`, { headers, timeoutMs: 20000 });
  if (r.status >= 300) throw new Error(httpErrorMessage(r));
  if (r.body?.success === false) {
    const msg = String(r.body?.message || "");
    throw new Error(/privileg|unauthorized/i.test(msg)
      ? "该令牌没有管理员权限：请使用管理员（root）账号的系统访问令牌与用户 ID"
      : msg || "查询失败");
  }
  const rows = Array.isArray(r.body?.data) ? r.body.data : [];
  return rows.map((row) => ({
    key: (kind === "user" ? row.username : row.model_name) || "unknown",
    t: num(row.created_at) * 1000,
    tokens: num(row.token_used),
    cost: num(row.quota) / QUOTA_PER_UNIT,
    requests: num(row.count),
  }));
}

/**
 * 「我的站点」流向数据：new-api 管理员 GET /api/data/flow。
 * 窗内按 (用户, 分组, 模型, 渠道) 聚合，没有时间维度（要环比就查两个窗口）。
 * 看板的 /api/data/ 只有模型维度，看不出「哪个分组涨了」「换到了哪个上游渠道」；
 * 分组倍率与渠道单价差异是消费突变的常见原因，所以这里单独取一份流向数据。
 * ⚠ new-api 侧 SQL 带 use_group <> '' 过滤：没有分组字段的历史行不会出现，
 * 合计可能小于 /api/data/，覆盖率由调用方计算并提示。
 * 返回 [{user, group, model, channelId, channelName, tokenName, tokens, cost($), requests}]
 */
export async function queryOwnFlow(station, startMs, endMs) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw new Error("缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const window = unixSecondWindow(startMs, endMs);
  const qs = `start_timestamp=${window.start}&end_timestamp=${window.end}`;
  const r = await request(`${base}/api/data/flow?${qs}`, { headers, timeoutMs: 20000 });
  if (r.status === 404) throw new Error("该 new-api 版本没有 /api/data/flow（分组与渠道口径需要较新版本）");
  if (r.status >= 300) throw new Error(httpErrorMessage(r));
  if (r.body?.success === false) {
    const msg = String(r.body?.message || "");
    throw new Error(/privileg|unauthorized/i.test(msg)
      ? "该令牌没有管理员权限：分组/渠道口径需要管理员（root）令牌"
      : msg || "查询失败");
  }
  const rows = Array.isArray(r.body?.data) ? r.body.data : [];
  return rows.map((row) => ({
    user: String(row.username || ""),
    group: String(row.use_group || ""),
    model: String(row.model_name || "unknown"),
    channelId: num(row.channel_id),
    channelName: String(row.channel_name || ""),
    tokenName: String(row.token_name || ""),
    tokens: num(row.token_used),
    cost: num(row.quota) / QUOTA_PER_UNIT,
    requests: num(row.count),
  }));
}

// 一条消费日志的 token 口径拆解（字段口径取自 new-api service/text_quota.go）：
//   · 看板 quota_data.token_used 只写 prompt_tokens + completion_tokens
//   · Claude（usage_semantic=anthropic）语义下 prompt_tokens 是「未命中缓存的输入」，
//     缓存读 cache_tokens 与缓存写 cache_write_tokens/cache_creation_tokens 额外计费，
//     所以真实 token 要把两者加回来——这正是「token 栏几乎为空、额度栏很大」的成因
//   · OpenAI 语义下缓存 token 本就含在 prompt_tokens 里（计费时再拆出来乘系数），
//     加回去会重复计数，只做展示拆分
export function auditRowTokens(row, other) {
  const prompt = num(row.prompt_tokens);
  const completion = num(row.completion_tokens);
  const cacheRead = num(other.cache_tokens);
  const cacheWrite = num(other.cache_write_tokens ?? other.cache_creation_tokens);
  const anthropic = other.usage_semantic === "anthropic" || other.claude === true;
  const billed = prompt + completion;
  const input = anthropic
    ? prompt + cacheRead + cacheWrite
    : Math.max(prompt, num(other.input_tokens_total));
  return {
    prompt, completion, cacheRead, cacheWrite, billed, input, anthropic,
    total: anthropic ? billed + cacheRead + cacheWrite : billed,
  };
}

function auditBucket() {
  return {
    requests: 0, cost: 0,
    billedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, trueTokens: 0,
    longRequests: 0, longCost: 0,
    anthropicRequests: 0, tiers: {},
    ratioWeight: 0, modelRatioSum: 0, groupRatioSum: 0, completionRatioSum: 0,
  };
}

function auditAdd(map, key, t, other, cost, isLong) {
  if (!key) return;
  const b = map.get(key) || auditBucket();
  b.requests++;
  b.cost += cost;
  b.billedTokens += t.billed;
  b.cacheReadTokens += t.cacheRead;
  b.cacheWriteTokens += t.cacheWrite;
  b.trueTokens += t.total;
  if (t.anthropic) b.anthropicRequests++;
  if (isLong) { b.longRequests++; b.longCost += cost; }
  const tier = other.matched_tier ? String(other.matched_tier) : "";
  if (tier) b.tiers[tier] = (b.tiers[tier] || 0) + 1;
  if (num(other.model_ratio) > 0) {
    b.ratioWeight++;
    b.modelRatioSum += num(other.model_ratio);
    b.groupRatioSum += num(other.group_ratio);
    b.completionRatioSum += num(other.completion_ratio);
  }
  map.set(key, b);
}

function auditFinish(map, field) {
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return [...map.entries()]
    .map(([key, b]) => ({
      [field]: key,
      requests: b.requests,
      cost: r4(b.cost),
      billedTokens: b.billedTokens,
      cacheReadTokens: b.cacheReadTokens,
      cacheWriteTokens: b.cacheWriteTokens,
      trueTokens: b.trueTokens,
      longRequests: b.longRequests,
      longCost: r4(b.longCost),
      // 缓存额外计费的行占比：判断这一行的 token 栏能不能当真
      anthropicPct: b.requests ? Math.round((b.anthropicRequests / b.requests) * 100) : 0,
      tiers: Object.entries(b.tiers).sort((a, c) => c[1] - a[1]).map(([name, n]) => ({ name, requests: n })),
      avgModelRatio: b.ratioWeight ? Math.round((b.modelRatioSum / b.ratioWeight) * 1000) / 1000 : null,
      avgGroupRatio: b.ratioWeight ? Math.round((b.groupRatioSum / b.ratioWeight) * 1000) / 1000 : null,
      avgCompletionRatio: b.ratioWeight ? Math.round((b.completionRatioSum / b.ratioWeight) * 1000) / 1000 : null,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * 「我的站点」日志精算：翻 new-api 消费日志明细（GET /api/log/?type=2），把看板漏计的
 * 缓存读/缓存写 token 与长上下文请求算出来。看板只有 prompt+completion，
 * 于是 Claude 这类「缓存占九成」的模型会显示成 token 近零、消费很大。
 * 日志按时间倒序，maxRows 截断时覆盖的是最近的若干条，返回 from/to 说明实际覆盖窗口。
 * 返回 {scanned, total, truncated, fromMs, toMs, longContextTokens, totals, byModel/byUser/byGroup/byChannel}
 */
export async function queryOwnLogAudit(station, {
  startMs, endMs, model = "", username = "", group = "",
  maxRows = 4000, longContextTokens = 200000, concurrency = 4,
} = {}) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw new Error("缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const window = unixSecondWindow(startMs, endMs);
  const PAGE = 100; // new-api 的 page_size 上限就是 100（common/page_info.go）
  const baseQs = {
    type: "2",
    start_timestamp: String(window.start),
    end_timestamp: String(window.end),
    ...(model ? { model_name: model } : {}),
    ...(username ? { username } : {}),
    ...(group ? { group } : {}),
  };
  const fetchPage = async (p) => {
    const qs = new URLSearchParams({ ...baseQs, p: String(p), page_size: String(PAGE) });
    const r = await request(`${base}/api/log/?${qs}`, { headers, timeoutMs: 25000 });
    if (r.status >= 300) throw new Error(httpErrorMessage(r));
    if (r.body?.success === false) {
      const msg = String(r.body?.message || "");
      throw new Error(/privileg|unauthorized/i.test(msg)
        ? "该令牌没有管理员权限，无法读取消费日志" : msg || "日志查询失败");
    }
    // 新版 data.items[]，老版 data[]
    const items = Array.isArray(r.body?.data) ? r.body.data
      : Array.isArray(r.body?.data?.items) ? r.body.data.items : [];
    const total = Number(r.body?.data?.total);
    return { items, total: Number.isFinite(total) ? total : null };
  };

  const first = await fetchPage(1);
  const total = first.total;
  const wanted = Math.max(PAGE, Math.min(maxRows, total ?? maxRows));
  const lastPage = Math.ceil(wanted / PAGE);
  const rows = [...first.items];
  for (let p = 2; p <= lastPage && rows.length < wanted; p += concurrency) {
    const batch = [];
    for (let i = 0; i < concurrency && p + i <= lastPage; i++) batch.push(fetchPage(p + i));
    const done = await Promise.all(batch);
    let empty = false;
    for (const d of done) {
      if (!d.items.length) empty = true;
      rows.push(...d.items);
    }
    if (empty) break; // 日志被清理或 total 不准，提前收尾
  }

  const byModel = new Map(), byUser = new Map(), byGroup = new Map(), byChannel = new Map();
  const totalsMap = new Map();
  let fromMs = null, toMs = null;
  for (const row of rows) {
    let other = {};
    if (row.other) {
      if (typeof row.other === "object") other = row.other;
      else { try { other = JSON.parse(row.other) || {}; } catch { other = {}; } }
    }
    const t = auditRowTokens(row, other);
    const cost = num(row.quota) / QUOTA_PER_UNIT;
    const isLong = t.input >= longContextTokens;
    const at = num(row.created_at) * 1000;
    if (at > 0) {
      if (fromMs == null || at < fromMs) fromMs = at;
      if (toMs == null || at > toMs) toMs = at;
    }
    auditAdd(byModel, String(row.model_name || "unknown"), t, other, cost, isLong);
    auditAdd(byUser, String(row.username || "unknown"), t, other, cost, isLong);
    auditAdd(byGroup, String(row.group || "（无分组）"), t, other, cost, isLong);
    auditAdd(byChannel, String(row.channel_name || `渠道 ${num(row.channel)}`), t, other, cost, isLong);
    auditAdd(totalsMap, "all", t, other, cost, isLong); // 合计与分维度走同一套累加
  }

  const [summary] = auditFinish(totalsMap, "key");
  return {
    scanned: rows.length,
    total,
    // total 缺失（老版本不返回）时，扫到上限就按「可能被截断」报，宁可保守
    truncated: total != null ? rows.length < total : rows.length >= wanted,
    fromMs, toMs,
    longContextTokens,
    totals: summary || null,
    byModel: auditFinish(byModel, "model"),
    byUser: auditFinish(byUser, "user"),
    byGroup: auditFinish(byGroup, "group"),
    byChannel: auditFinish(byChannel, "channel"),
  };
}

/**
 * 「我的站点」渠道列表（new-api 管理员接口，分页拉全）。
 * 返回 [{id, name, type, status, baseUrl}]，status: 1=启用 2=手动禁用 3=自动禁用
 */
export async function queryOwnChannels(station) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw new Error("缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const out = [];
  for (let p = 1; p <= 5; p++) {
    const r = await request(`${base}/api/channel/?p=${p}&page_size=100`, { headers, timeoutMs: 15000 });
    if (r.status >= 300) throw new Error(httpErrorMessage(r));
    if (r.body?.success === false) {
      const msg = String(r.body?.message || "");
      throw new Error(/privileg|unauthorized/i.test(msg)
        ? "该令牌没有管理员权限，无法读取渠道列表" : msg || "获取渠道失败");
    }
    // 新版 data.items[]，老版 data[]
    const items = Array.isArray(r.body?.data) ? r.body.data
      : Array.isArray(r.body?.data?.items) ? r.body.data.items : [];
    for (const c of items) {
      out.push({
        id: c.id, name: String(c.name || ""), type: Number(c.type) || 0,
        status: Number(c.status) || 0, baseUrl: String(c.base_url || ""),
      });
    }
    const total = Number(r.body?.data?.total);
    if (!items.length || !Number.isFinite(total) || out.length >= total) break;
  }
  return out;
}

/**
 * 「我的站点」用户列表（new-api 管理员接口，分页拉全）。
 * 返回 [{id, username, displayName, role, status, quotaUsd, usedUsd}]
 * role: 1=普通用户 10=管理员 100=root；quota 按 500000=$1 换算
 */
export async function queryOwnUsers(station) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw new Error("缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const out = [];
  for (let p = 1; p <= 10; p++) {
    const r = await request(`${base}/api/user/?p=${p}&page_size=100`, { headers, timeoutMs: 15000 });
    if (r.status >= 300) throw new Error(httpErrorMessage(r));
    if (r.body?.success === false) throw new Error(r.body?.message || "获取用户列表失败");
    const items = Array.isArray(r.body?.data) ? r.body.data
      : Array.isArray(r.body?.data?.items) ? r.body.data.items : [];
    for (const u of items) {
      out.push({
        id: u.id,
        username: String(u.username || ""),
        displayName: String(u.display_name || ""),
        role: Number(u.role) || 1,
        status: Number(u.status) || 0,
        quotaUsd: num(u.quota) / QUOTA_PER_UNIT,
        usedUsd: num(u.used_quota) / QUOTA_PER_UNIT,
      });
    }
    const total = Number(r.body?.data?.total);
    if (!items.length || !Number.isFinite(total) || out.length >= total) break;
  }
  return out;
}

/**
 * 「我的站点」某个账号的 API Key 列表（new-api 管理员接口）。
 * new-api 的 /api/token/ 按「当前操作用户」返回其名下 Key，通过 New-Api-User 头切换目标账号。
 * 返回 [{id, name, usedUsd, remainUsd, status}]，status: 1=启用 其它=禁用/过期
 */
export async function queryAdminTokens(station, targetUserId) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw new Error("缺少站点地址或访问令牌");
  const headers = { Authorization: token, "New-Api-User": String(targetUserId) };

  const out = [];
  for (let p = 1; p <= 5; p++) {
    const r = await request(`${base}/api/token/?p=${p}&page_size=100`, { headers, timeoutMs: 15000 });
    if (r.status >= 300) throw new Error(httpErrorMessage(r));
    if (r.body?.success === false) throw new Error(r.body?.message || "获取 Key 列表失败");
    const items = Array.isArray(r.body?.data) ? r.body.data
      : Array.isArray(r.body?.data?.items) ? r.body.data.items : [];
    for (const t of items) {
      out.push({
        id: t.id,
        name: String(t.name || ""),
        status: Number(t.status) || 0,
        usedUsd: num(t.used_quota) / QUOTA_PER_UNIT,
        remainUsd: t.unlimited_quota ? null : num(t.remain_quota) / QUOTA_PER_UNIT,
      });
    }
    const total = Number(r.body?.data?.total);
    if (!items.length || !Number.isFinite(total) || out.length >= total) break;
  }
  return out;
}

/**
 * 用日志统计接口聚合某个 (用户名 + Key 名) 在时间窗内的消费额度（new-api 管理员接口）。
 * GET /api/log/stat?type=2 返回 {quota, rpm, tpm}——quota 为窗内消费额度总和。
 * ⚠ Key 名会跨用户重名，必须同时带 username 与 token_name 才能唯一定位。
 * 返回消费金额（美元）；无数据返回 0。
 */
export async function queryLogStat(station, { username, tokenName, startMs, endMs }) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw new Error("缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const window = unixSecondWindow(startMs, endMs);
  const qs = new URLSearchParams({
    type: "2",
    username: String(username || ""),
    token_name: String(tokenName || ""),
    start_timestamp: String(window.start),
    end_timestamp: String(window.end),
  });
  const r = await request(`${base}/api/log/stat?${qs}`, { headers, timeoutMs: 20000 });
  if (r.status >= 300) throw new Error(httpErrorMessage(r));
  if (r.body?.success === false) throw new Error(r.body?.message || "日志统计查询失败");
  return num(r.body?.data?.quota) / QUOTA_PER_UNIT;
}

/**
 * 查询站点的用量明细（分模型 + 分时间），返回 {models, trend}。
 * 与余额查询不同，出错直接 throw，由调用方汇总每个站点的错误。
 */
export async function queryStationUsage(station, opts) {
  switch (station.type) {
    case "newapi": return newApiUsage(station, opts);
    case "newapi-key": throw new Error("sk 密钥模式没有用量明细接口");
    case "sub2api":
    case "sub2api-password": return sub2apiUsage(station, opts);
    case "jucode": return jucodeUsage(station, opts);
    default: throw new Error(`未知的中转站类型：${station.type}`);
  }
}

const HANDLERS = {
  newapi: queryNewApi,
  "newapi-key": queryNewApiKey,
  sub2api: querySub2Api,
  "sub2api-password": querySub2Api,
  jucode: queryJuCode,
};

// 查询单个中转站，永远 resolve，出错时返回 ok:false
export async function queryStation(station) {
  const startedAt = Date.now();
  const handler = HANDLERS[station.type];
  try {
    if (!handler) throw new Error(`未知的中转站类型：${station.type}`);
    const { tokensChanged, ...balance } = await handler(station);
    return {
      result: {
        ok: true,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        ...balance,
      },
      tokensChanged: !!tokensChanged,
    };
  } catch (err) {
    return {
      result: {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        error: err?.message || String(err),
      },
      tokensChanged: false,
    };
  }
}

export const STATION_TYPES = [
  { value: "newapi", label: "New API（访问令牌）", needs: ["accessToken", "userId"] },
  { value: "newapi-key", label: "New API（sk 密钥）", needs: ["apiKey"] },
  { value: "sub2api", label: "Sub2API（登录令牌）", needs: ["accessToken"] },
  { value: "sub2api-password", label: "Sub2API（账号密码，自动续期）", needs: ["email", "password"] },
  { value: "jucode", label: "JuCode（个人访问令牌）", needs: ["accessToken"] },
  { value: "fixed", label: "固定成本（包月/包年，不访问）", needs: [] },
];

// 固定成本付费记录列表；每笔 {amount, days, startDate|null}
export function fixedPurchases(station) {
  return Array.isArray(station?.fixedPurchases) ? station.fixedPurchases : [];
}
