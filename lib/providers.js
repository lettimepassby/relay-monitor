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
//   POST /api/v1/auth/login    body {email, password}   → {code:0, data:{access_token, refresh_token, expires_in, user}}
//   POST /api/v1/auth/refresh  body {refresh_token}     → {code:0, data:{access_token, refresh_token, expires_in}}
//   GET  /api/v1/auth/me       Bearer JWT               → {code:0, data:{username, email, balance, total_recharged, ...}}
//   过期：HTTP 401，body {code:"TOKEN_EXPIRED"}；开启 2FA 的账号 login 返回 data.requires_2fa

// new-api / one-api 的额度单位换算：默认 500000 额度 = 1 美元
const QUOTA_PER_UNIT = 500000;
// 主动刷新缓冲：令牌剩余寿命低于该值就先刷新（与官方客户端一致）
const TOKEN_REFRESH_BUFFER_MS = 120 * 1000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

function trimBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
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

  const r = await request(`${base}/api/v1/auth/login`, {
    method: "POST",
    json: { email, password },
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
  return { ...parseSub2ApiMe(data), tokensChanged };
}

const HANDLERS = {
  newapi: queryNewApi,
  "newapi-key": queryNewApiKey,
  sub2api: querySub2Api,
  "sub2api-password": querySub2Api,
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
];
