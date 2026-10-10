import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { queryStation, queryStationUsage } from "./providers.js";

function seededHex(seed, length) {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24);
  }
  state >>>= 0;
  let out = "";
  while (out.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out += (state >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

test("Sub2API password login solves a Cap challenge and sends turnstile_token", async (t) => {
  const challengeToken = "local-challenge";
  const challengeSpec = { c: 2, s: 8, d: 1 };
  let origin;
  let loginBody;

  const server = createServer(async (request, response) => {
    if (request.url === "/api/v1/settings/public") {
      return sendJson(response, {
        code: 0,
        data: {
          turnstile_enabled: true,
          captcha_provider: "cap",
          cap_api_endpoint: `${origin}/cap`,
          cap_site_key: "local-site",
        },
      });
    }
    if (request.url === "/cap/local-site/challenge" && request.method === "POST") {
      return sendJson(response, { challenge: challengeSpec, token: challengeToken });
    }
    if (request.url === "/cap/local-site/redeem" && request.method === "POST") {
      const body = await readJson(request);
      assert.equal(body.token, challengeToken);
      assert.equal(body.solutions.length, challengeSpec.c);
      for (let i = 0; i < body.solutions.length; i++) {
        const n = i + 1;
        const salt = seededHex(`${challengeToken}${n}`, challengeSpec.s);
        const target = seededHex(`${challengeToken}${n}d`, challengeSpec.d);
        const hash = createHash("sha256").update(`${salt}${body.solutions[i]}`).digest("hex");
        assert.ok(hash.startsWith(target));
      }
      return sendJson(response, { success: true, token: "local-cap-token", expires: Date.now() + 60000 });
    }
    if (request.url === "/api/v1/auth/login" && request.method === "POST") {
      loginBody = await readJson(request);
      return sendJson(response, {
        code: 0,
        data: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          user: { email: "user@example.com" },
        },
      });
    }
    if (request.url === "/api/v1/auth/me") {
      assert.equal(request.headers.authorization, "Bearer access-token");
      return sendJson(response, {
        code: 0,
        data: { email: "user@example.com", balance: 12.5, total_recharged: 20 },
      });
    }
    if (request.url === "/api/v1/usage/dashboard/stats") {
      return sendJson(response, {
        code: 0,
        data: { today_actual_cost: 1.25, today_requests: 3, today_tokens: 4000 },
      });
    }
    sendJson(response, { error: "not found" }, 404);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;

  const station = {
    type: "sub2api-password",
    baseUrl: origin,
    email: "user@example.com",
    password: "secret123",
  };
  const { result, tokensChanged } = await queryStation(station);

  assert.equal(result.ok, true);
  assert.equal(result.remaining, 12.5);
  assert.equal(result.used, 7.5);
  assert.equal(result.todayUsed, 1.25);
  assert.equal(tokensChanged, true);
  assert.deepEqual(loginBody, {
    email: "user@example.com",
    password: "secret123",
    turnstile_token: "local-cap-token",
  });
  assert.equal(station.s2Tokens.refreshToken, "refresh-token");
});

test("流向数据把用户/分组/模型/渠道口径归一化", async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    assert.equal(url.pathname, "/api/data/flow");
    assert.equal(request.headers.authorization, "adm");
    assert.equal(request.headers["new-api-user"], "6");
    assert.equal(url.searchParams.get("start_timestamp"), "1000");
    assert.equal(url.searchParams.get("end_timestamp"), "1059"); // 结束值包含式，减到窗内最后一秒
    sendJson(response, {
      success: true,
      data: [
        { username: "a", use_group: "grok", model_name: "grok-4.6", channel_id: 7, channel_name: "sol", token_used: 400, count: 596, quota: 76000000 },
        { username: "b", use_group: "", model_name: "gpt-4o", channel_id: 1, token_used: 100, count: 3, quota: 500000 },
      ],
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryOwnFlow } = await import("./providers.js");

  const rows = await queryOwnFlow({ baseUrl: origin, accessToken: "adm", userId: "6" }, 1000000, 1060000);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    user: "a", group: "grok", model: "grok-4.6", channelId: 7, channelName: "sol",
    tokenName: "", tokens: 400, cost: 152, requests: 596,
  });
  assert.equal(rows[1].channelName, ""); // 没有 channel_name 时留空，由调用方兜底
});

test("日志精算把缓存读写算进真实 token，并按语义避免重复计数", async (t) => {
  // Claude 语义：prompt_tokens 只是未命中缓存的输入，缓存读写额外计费（看板漏计的就是这块）
  const claudeRow = (i) => ({
    id: i, created_at: 1700000000 + i, model_name: "claude-sonnet-4-5", username: "u1",
    prompt_tokens: 1000, completion_tokens: 2000, quota: 500000, channel: 3, channel_name: "Claude-Max", group: "claude",
    other: JSON.stringify({
      usage_semantic: "anthropic", claude: true, cache_tokens: 300000, cache_write_tokens: 20000,
      model_ratio: 5, group_ratio: 1, completion_ratio: 5,
    }),
  });
  // OpenAI 语义：缓存 token 本就含在 prompt_tokens 里，真实 token 不能再加一遍
  const gptRow = {
    id: 99, created_at: 1700000500, model_name: "gpt-4o", username: "u2",
    prompt_tokens: 250000, completion_tokens: 1000, quota: 1000000, channel: 1, channel_name: "luna", group: "default",
    other: JSON.stringify({ cache_tokens: 100000, model_ratio: 2.5, group_ratio: 1, completion_ratio: 4, matched_tier: ">200k" }),
  };
  const pages = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    assert.equal(url.pathname, "/api/log/");
    assert.equal(url.searchParams.get("type"), "2");
    assert.equal(url.searchParams.get("page_size"), "100");
    const p = Number(url.searchParams.get("p"));
    pages.push(p);
    const items = p === 1 ? Array.from({ length: 100 }, (_, i) => claudeRow(i + 1)) : p === 2 ? [gptRow] : [];
    sendJson(response, { success: true, data: { page: p, page_size: 100, total: 101, items } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryOwnLogAudit } = await import("./providers.js");

  const r = await queryOwnLogAudit({ baseUrl: origin, accessToken: "adm" }, {
    startMs: 1700000000000, endMs: 1700001000000, maxRows: 4000,
  });
  assert.equal(r.scanned, 101);
  assert.equal(r.total, 101);
  assert.equal(r.truncated, false);
  assert.deepEqual(pages.slice(0, 2), [1, 2]);

  const claude = r.byModel.find((m) => m.model === "claude-sonnet-4-5");
  assert.equal(claude.billedTokens, 100 * 3000); // 看板口径
  assert.equal(claude.cacheReadTokens, 100 * 300000);
  assert.equal(claude.cacheWriteTokens, 100 * 20000);
  assert.equal(claude.trueTokens, 100 * (3000 + 300000 + 20000)); // 真实口径
  assert.equal(claude.anthropicPct, 100);
  assert.equal(claude.longRequests, 100); // 输入 321000 ≥ 20 万，属长上下文
  assert.deepEqual(claude.avgModelRatio, 5);

  const gpt = r.byModel.find((m) => m.model === "gpt-4o");
  assert.equal(gpt.billedTokens, 251000);
  assert.equal(gpt.trueTokens, 251000); // 缓存 token 已在 prompt 内，不再叠加
  assert.equal(gpt.cacheReadTokens, 100000);
  assert.equal(gpt.longRequests, 1);
  assert.deepEqual(gpt.tiers, [{ name: ">200k", requests: 1 }]);

  assert.equal(r.totals.requests, 101);
  assert.equal(r.byChannel.map((c) => c.channel).sort().join(","), "Claude-Max,luna");
  assert.equal(r.byGroup.length, 2);
});

test("日志精算按条数上限截断并如实报告覆盖范围", async (t) => {
  const server = createServer((request, response) => {
    const p = Number(new URL(request.url, "http://x").searchParams.get("p"));
    sendJson(response, {
      success: true,
      data: {
        total: 5000,
        items: Array.from({ length: 100 }, (_, i) => ({
          id: p * 1000 + i, created_at: 1700000000 - (p - 1) * 100 - i,
          model_name: "m", username: "u", prompt_tokens: 1, completion_tokens: 1, quota: 500, other: "",
        })),
      },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { queryOwnLogAudit } = await import("./providers.js");

  const r = await queryOwnLogAudit(
    { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "adm" },
    { startMs: 1600000000000, endMs: 1700001000000, maxRows: 300 }
  );
  assert.equal(r.scanned, 300);
  assert.equal(r.truncated, true);
  assert.equal(r.toMs, 1700000000000);
  assert.equal(r.fromMs, (1700000000 - 2 * 100 - 99) * 1000); // 只覆盖最近 3 页
});

test("JuCode access token reads balance, lifetime spend, today usage and per-model stats", async (t) => {
  const token = "jcp-local-test";
  const seen = [];
  const bucket = (time, cost, extra = {}) => ({
    time, requests: 2, errors: 0, cost_final_sum: cost,
    tokens_in: 100, tokens_out: 50, cached_tokens_in: 30, cache_creation_tokens_in: 20, ...extra,
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    seen.push(url);
    if (request.headers.authorization !== `Bearer ${token}`) {
      return sendJson(response, { error: "invalid access token" }, 401);
    }
    if (url.pathname === "/v1/me") return sendJson(response, { balance: "88.50", nickname: "tester" });
    if (url.pathname === "/v1/me/stats/lifetime") return sendJson(response, { total_cost: "11.5" });
    if (url.pathname === "/v1/me/stats/usage") {
      return sendJson(response, {
        start: url.searchParams.get("start"),
        buckets: [bucket("2026-10-04T01:00:00Z", "1.25"), bucket("2026-10-04T00:00:00Z", "0.75")],
      });
    }
    if (url.pathname === "/v1/me/stats/usage-by-model") {
      return sendJson(response, {
        rows: [
          { ...bucket("2026-10-04T00:00:00Z", "0.5"), model: "gpt-5" },
          { ...bucket("2026-10-04T01:00:00Z", "1.5"), model: "gpt-5" },
          { ...bucket("2026-10-04T01:00:00Z", "0.1", { tokens_in: 1, tokens_out: 1, cached_tokens_in: 0, cache_creation_tokens_in: 0 }), model: "claude" },
        ],
      });
    }
    sendJson(response, { error: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;

  const { result } = await queryStation({ type: "jucode", baseUrl, accessToken: token });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.remaining, 88.5);
  assert.equal(result.used, 11.5);
  assert.equal(result.total, 100);
  assert.equal(result.account, "tester");
  assert.equal(result.todayUsed, 2);
  assert.equal(result.todayRequests, 4);
  assert.equal(result.todayTokens, 400);

  const startMs = Date.parse("2026-10-04T00:00:00Z");
  const usage = await queryStationUsage(
    { type: "jucode", baseUrl, accessToken: token },
    { startMs, endMs: startMs + 7200000, granularity: "hour", tz: "UTC", wantToday: true },
  );
  const usageReq = seen.find((u) => u.pathname === "/v1/me/stats/usage-by-model");
  assert.equal(usageReq.searchParams.get("start"), "2026-10-04T00:00:00.000Z");
  assert.equal(usageReq.searchParams.get("bucket"), "hour");
  assert.deepEqual(usage.models.map((m) => [m.model, m.tokens, m.requests]), [["gpt-5", 400, 4], ["claude", 2, 2]]);
  assert.equal(usage.models[0].cost, 2);
  assert.equal(usage.models[0].inputTokens, 300);
  assert.deepEqual(usage.trend.map((p) => p.t), [startMs, startMs + 3600000]);
  assert.equal(usage.summary.cost, 2);

  const bad = await queryStation({ type: "jucode", baseUrl, accessToken: "jcp-wrong" });
  assert.equal(bad.result.ok, false);
  assert.match(bad.result.error, /invalid access token/);
});

test("Monoize password login solves built-in Cap, re-logs on 401 and reads balance, spend and analytics", async (t) => {
  const challengeToken = "mz-challenge";
  const challengeSpec = { c: 2, s: 8, d: 1 };
  const logins = [];
  const logQueries = [];
  let session = "";
  let issued = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/dashboard/settings/public") {
      return sendJson(response, { captcha_enabled: true, cap_api_endpoint: "/api/dashboard/captcha/" });
    }
    if (url.pathname === "/api/dashboard/captcha/challenge" && request.method === "POST") {
      return sendJson(response, { challenge: challengeSpec, token: challengeToken, expires: Date.now() + 60000 });
    }
    if (url.pathname === "/api/dashboard/captcha/redeem" && request.method === "POST") {
      const body = await readJson(request);
      assert.equal(body.solutions.length, challengeSpec.c);
      return sendJson(response, { success: true, token: "mz-cap-token", expires: Date.now() + 60000 });
    }
    if (url.pathname === "/api/dashboard/auth/login" && request.method === "POST") {
      const body = await readJson(request);
      logins.push(body);
      if (body.password !== "secret123") {
        return sendJson(response, { error: { message: "invalid username or password", code: "invalid_credentials" } }, 401);
      }
      session = `sess-${++issued}`;
      return sendJson(response, { token: session, user: { username: body.username, balance_usd: "40" } });
    }
    if (request.headers.authorization !== `Bearer ${session}`) {
      return sendJson(response, { error: { message: "missing dashboard session", code: "unauthorized" } }, 401);
    }
    if (url.pathname === "/api/dashboard/auth/me") {
      return sendJson(response, { username: "alice", balance_usd: "42.5", balance_unlimited: false });
    }
    if (url.pathname === "/api/dashboard/request-logs") {
      logQueries.push(url.searchParams);
      const today = url.searchParams.has("time_from");
      return sendJson(response, {
        data: [], total: today ? 7 : 120, total_charge_nano_usd: today ? "1250000000" : "57500000000",
        limit: 1, offset: 0,
      });
    }
    if (url.pathname === "/api/dashboard/analytics") {
      const hours = Number(url.searchParams.get("range_hours"));
      const n = Number(url.searchParams.get("buckets"));
      const from = Date.now() - hours * 3600000;
      const buckets = Array.from({ length: n }, () => ({ label: "", cost_by_model: {}, calls_by_model: {}, tokens_by_model: {} }));
      buckets[0] = { label: "x", cost_by_model: { "gpt-5": "500000000" }, calls_by_model: { "gpt-5": 2 }, tokens_by_model: { "gpt-5": 300 } };
      buckets[n - 1] = {
        label: "y",
        cost_by_model: { "gpt-5": "250000000", claude: "1000000000" },
        calls_by_model: { "gpt-5": 1, claude: 4 },
        tokens_by_model: { "gpt-5": 100, claude: 900 },
      };
      return sendJson(response, { buckets, time_from: new Date(from).toISOString() });
    }
    sendJson(response, { error: { message: "not found" } }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`; // 误填 API 根也能用

  const station = { type: "monoize", baseUrl, email: "alice", password: "secret123" };
  const first = await queryStation(station);
  assert.equal(first.result.ok, true, first.result.error);
  assert.equal(first.tokensChanged, true);
  assert.deepEqual(logins[0], { username: "alice", password: "secret123", captcha_token: "mz-cap-token" });
  assert.equal(first.result.remaining, 42.5);
  assert.equal(first.result.used, 57.5);
  assert.equal(first.result.total, 100);
  assert.equal(first.result.account, "alice");
  assert.equal(first.result.todayUsed, 1.25);
  assert.equal(first.result.todayRequests, 7);
  assert.ok(logQueries.every((q) => q.get("scope") === "self"));

  // 缓存的会话继续用，不再登录
  await queryStation(station);
  assert.equal(logins.length, 1);

  // 服务端会话失效 → 自动重登一次
  session = "rotated-elsewhere";
  const third = await queryStation(station);
  assert.equal(third.result.ok, true, third.result.error);
  assert.equal(third.tokensChanged, true);
  assert.equal(logins.length, 2);
  assert.equal(station.s2Tokens.accessToken, "sess-2");

  const now = Date.now();
  const usage = await queryStationUsage(station, {
    startMs: now - 5.5 * 3600000, endMs: now, granularity: "hour", tz: "UTC", wantToday: true,
  });
  assert.equal(usage.trend.length, 6);
  assert.deepEqual(usage.models.map((m) => [m.model, m.tokens, m.requests]), [["claude", 900, 4], ["gpt-5", 400, 3]]);
  assert.equal(usage.models[1].cost, 0.75);
  assert.equal(usage.trend[0].cost, 0.5);
  assert.equal(usage.trend[5].tokens, 1000);
  assert.ok(usage.trend[1].t - usage.trend[0].t === 3600000);
  assert.deepEqual(usage.summary, { cost: 1.25, requests: 7, tokens: 1300 });

  const daily = await queryStationUsage(station, {
    startMs: now - 30 * 86400000, endMs: now, granularity: "day", tz: "UTC", wantToday: false,
  });
  assert.equal(daily.trend.length, 48);

  const bad = await queryStation({ type: "monoize", baseUrl, email: "alice", password: "wrong" });
  assert.equal(bad.result.ok, false);
  assert.match(bad.result.error, /用户名或密码错误/);
});

test("Monoize API key reads the DeepSeek-compatible balance endpoint", async (t) => {
  const server = createServer((request, response) => {
    if (request.url !== "/user/balance") return sendJson(response, { error: { message: "not found" } }, 404);
    if (request.headers.authorization !== "Bearer sk-mz") {
      return sendJson(response, { error: { message: "invalid api key", code: "unauthorized" } }, 401);
    }
    sendJson(response, {
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "3.141592653", granted_balance: "0", topped_up_balance: "3.141592653" }],
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { result } = await queryStation({ type: "monoize-key", baseUrl, apiKey: "sk-mz" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.remaining, 3.14);
  assert.equal(result.currency, "USD");

  const bad = await queryStation({ type: "monoize-key", baseUrl, apiKey: "sk-wrong" });
  assert.equal(bad.result.ok, false);
  assert.match(bad.result.error, /invalid api key/);
});
