// ---------------------------------------------------------------------------
// 内置演示中转站（mock relay）
// 让面板在没有真实凭证时也能展示真实的查询链路与数据。
// Sub2API 部分完整模拟：登录（邮箱+密码）→ 短时令牌（5 分钟）→ 过期 401
// TOKEN_EXPIRED → 刷新/重登录，用于演示「账号密码自动续期」。
// 状态与业务逻辑集中在本模块；app/mock/** 下的路由文件只做参数解包与响应包装，
// 各 mock* 处理函数统一返回 { status, body }（与 v1 server.js 的响应逐字段一致）。
// ---------------------------------------------------------------------------
const QUOTA_PER_UNIT = 500000;
const BOOT = Date.now();
const MOCK_TOKEN_TTL_SEC = 300;
const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 3000;
// 演示站自指的本机地址（余额轮询会真实地 HTTP 请求这些 mock 路由）
const MOCK_BASE = `http://${HOST}:${PORT}/mock`;
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

// 与 v1 的 needAuth 等价：无 Authorization 头 → 401 { message: "未授权" }
function unauthorized() {
  return { status: 401, body: { message: "未授权" } };
}
function hasAuth(request) {
  return Boolean(request.headers.get("authorization"));
}

// ---- new-api mock -----------------------------------------------------------
export function mockNewApiUserSelf(request, acc) {
  if (!hasAuth(request)) return unauthorized();
  const s = mockState(acc);
  return {
    status: 200,
    body: {
      success: true,
      data: {
        username: s.name,
        quota: Math.round((s.grantUsd - s.usedUsd) * QUOTA_PER_UNIT),
        used_quota: Math.round(s.usedUsd * QUOTA_PER_UNIT),
        request_count: 1200 + Math.round(s.usedUsd * 20),
      },
    },
  };
}

export function mockNewApiSubscription(request, acc) {
  if (!hasAuth(request)) return unauthorized();
  const s = mockState(acc);
  return {
    status: 200,
    body: { object: "billing_subscription", hard_limit_usd: s.grantUsd, access_until: 0 },
  };
}

export function mockNewApiUsage(acc) {
  const s = mockState(acc);
  return { status: 200, body: { object: "list", total_usage: Math.round(s.usedUsd * 100) } };
}

// ---- Sub2API mock：登录 / 刷新 / me（契约与 Wei-Shaw/sub2api 一致） ----------
export function mockSub2ApiLogin(acc, body) {
  const { email, password } = body || {};
  if (email !== "demo@example.com" || password !== "demo123") {
    return {
      status: 401,
      body: { code: 401, message: "invalid email or password", reason: "INVALID_CREDENTIALS" },
    };
  }
  return {
    status: 200,
    body: {
      code: 0,
      message: "success",
      data: {
        access_token: `mt.${acc}.${Date.now() + MOCK_TOKEN_TTL_SEC * 1000}`,
        refresh_token: `mr.${acc}`,
        expires_in: MOCK_TOKEN_TTL_SEC,
        token_type: "Bearer",
      },
    },
  };
}

export function mockSub2ApiRefresh(acc, body) {
  const rt = body?.refresh_token || "";
  if (!rt.startsWith("mr.")) {
    return { status: 401, body: { code: 401, message: "invalid refresh token" } };
  }
  return {
    status: 200,
    body: {
      code: 0,
      message: "success",
      data: {
        access_token: `mt.${acc}.${Date.now() + MOCK_TOKEN_TTL_SEC * 1000}`,
        refresh_token: `mr.${acc}`,
        expires_in: MOCK_TOKEN_TTL_SEC,
        token_type: "Bearer",
      },
    },
  };
}

export function mockSub2ApiMe(request, acc) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return { status: 401, body: { code: "UNAUTHORIZED", message: "missing token" } };
  if (token.startsWith("mt.")) {
    const exp = Number(token.split(".")[2] || 0);
    if (!exp || exp < Date.now()) {
      return { status: 401, body: { code: "TOKEN_EXPIRED", message: "Token has expired" } };
    }
  } else if (token !== "demo-jwt") {
    return { status: 401, body: { code: "INVALID_TOKEN", message: "invalid token" } };
  }
  const s = mockState(acc);
  const balance = Number((s.grantUsd - s.usedUsd).toFixed(2));
  if (acc === "s2-pw") {
    // 余额制账号：balance + total_recharged（对应真实 Sub2API 的响应形态）
    return {
      status: 200,
      body: {
        code: 0, message: "success",
        data: { username: s.name, email: "demo@example.com", balance, total_recharged: s.grantUsd, frozen_balance: 0 },
      },
    };
  }
  // 配额制账号
  return {
    status: 200,
    body: {
      code: 0, message: "success",
      data: { username: s.name, balance, quota: s.grantUsd, quota_used: Number(s.usedUsd.toFixed(2)) },
    },
  };
}

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

function mockOwnData(request, kind) {
  if (!hasAuth(request)) return unauthorized();
  const q = new URL(request.url).searchParams;
  return {
    status: 200,
    body: {
      success: true, message: "",
      data: mockOwnRows(Number(q.get("start_timestamp")) || 0, Number(q.get("end_timestamp")) || 0, kind),
    },
  };
}

export function mockNewApiData(request) {
  return mockOwnData(request, "model");
}

export function mockNewApiDataUsers(request) {
  return mockOwnData(request, "user");
}

export function mockNewApiUserList(request) {
  if (!hasAuth(request)) return unauthorized();
  return {
    status: 200,
    body: {
      success: true, message: "",
      data: { items: [
        { id: 1, username: "root", display_name: "Root", role: 100, status: 1, quota: 99500000, used_quota: 4200000 },
        { id: 2, username: "alice", display_name: "", role: 1, status: 1, quota: 5250000, used_quota: 61500000 },
        { id: 3, username: "bob", display_name: "", role: 1, status: 1, quota: 1200000, used_quota: 38200000 },
        { id: 4, username: "carol", display_name: "", role: 1, status: 1, quota: 0, used_quota: 17800000 },
        { id: 5, username: "dave", display_name: "", role: 10, status: 1, quota: 800000, used_quota: 9200000 },
      ], total: 5 },
    },
  };
}

export function mockNewApiChannelList(request) {
  if (!hasAuth(request)) return unauthorized();
  const local = MOCK_BASE;
  return {
    status: 200,
    body: {
      success: true, message: "",
      data: { items: [
        { id: 1, name: "上游A-高速", type: 1, status: 1, base_url: `${local}/newapi/np-pro` },
        { id: 2, name: "上游A-备用", type: 1, status: 2, base_url: `${local}/newapi/np-pro` },
        { id: 3, name: "拼车团队", type: 14, status: 1, base_url: `${local}/sub2api/s2-team` },
        { id: 4, name: "官方直连-DeepSeek", type: 43, status: 1, base_url: "" },
        { id: 5, name: "包月自建", type: 14, status: 1, base_url: "http://10.0.0.8:13800" },
      ], total: 5 },
    },
  };
}

// 用户仪表盘统计（与真实 Sub2API 的 /usage/dashboard/stats 契约一致）
export function mockSub2ApiDashboardStats(request, acc) {
  if (!hasAuth(request)) return unauthorized();
  const s = mockState(acc);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const minToday = (Date.now() - midnight.getTime()) / 60000;
  const todayCost = Math.min(minToday * s.drain, s.usedUsd);
  return {
    status: 200,
    body: {
      code: 0, message: "success",
      data: {
        today_actual_cost: Number(todayCost.toFixed(4)),
        today_cost: Number((todayCost * 1.15).toFixed(4)),
        today_requests: Math.round(todayCost * 40),
        today_tokens: Math.round(todayCost * 250000),
        total_actual_cost: Number(s.usedUsd.toFixed(4)),
      },
    },
  };
}

// ---- 演示站播种 --------------------------------------------------------------
export async function seedDemo(rt) {
  const local = MOCK_BASE;
  if (rt.store.list().length === 0) {
    const demos = [
      { name: "Pro 中转站（演示）", type: "newapi", baseUrl: `${local}/newapi/np-pro`, accessToken: "demo-token", userId: "1" },
      { name: "Key 计费站（演示）", type: "newapi-key", baseUrl: `${local}/newapi/np-key`, apiKey: "sk-demo-key" },
      { name: "拼车团队（演示）", type: "sub2api", baseUrl: `${local}/sub2api/s2-team`, accessToken: "demo-jwt" },
      { name: "低余额告警（演示）", type: "sub2api", baseUrl: `${local}/sub2api/s2-low`, accessToken: "demo-jwt", lowBalanceUsd: 5 },
    ];
    for (const d of demos) await rt.store.add({ ...d, demo: true });
  }
  // 追加「账密自动续期」演示站（仅当全部是演示站且还没有该类型时）
  const list = rt.store.list();
  if (list.every((s) => s.demo) && !list.some((s) => s.type === "sub2api-password")) {
    await rt.store.add({
      name: "账密自动续期（演示）",
      type: "sub2api-password",
      baseUrl: `${local}/sub2api/s2-pw`,
      email: "demo@example.com",
      password: "demo123",
      demo: true,
    });
  }
}
