import test from "node:test";
import assert from "node:assert/strict";
import { tickDailyReport, REPORT_RETRY_MS, REPORT_MAX_ATTEMPTS } from "./report.js";

// 2026-10-16 09:00:05（Asia/Shanghai，日报默认时区）
const AT_0900 = Date.parse("2026-10-16T01:00:05Z");
const MIN = 60_000;
const REPORT = { title: "日报", text: "正文", html: "<p></p>" };

function makeRt(cfg = {}) {
  const rt = {
    saves: 0,
    store: {
      settings: { dailyReport: { enabled: true, time: "09:00", channelIds: [], lastSent: null, ...cfg } },
      channels: [{ id: "c1", name: "TG", enabled: true }],
      save: async () => { rt.saves++; },
    },
  };
  return rt;
}

function makeDeps({ buildFails = 0, sendOk = true } = {}) {
  const calls = { build: 0, sends: [] };
  return {
    calls,
    build: async () => {
      calls.build++;
      if (calls.build <= buildFails) throw new Error("fetch failed (ETIMEDOUT)");
      return REPORT;
    },
    send: async (channels, title, body) => {
      calls.sends.push({ title, body });
      return channels.map((c) => ({ id: c.id, name: c.name, ok: sendOk, ...(sendOk ? {} : { error: "fetch failed (EAI_AGAIN)" }) }));
    },
  };
}

function quiet(t) {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
}

test("未到点或未启用时不发送", async (t) => {
  quiet(t);
  const rt = makeRt();
  const deps = makeDeps();
  await tickDailyReport(rt, AT_0900 - MIN, deps);
  rt.store.settings.dailyReport.enabled = false;
  await tickDailyReport(rt, AT_0900, deps);
  assert.equal(deps.calls.build, 0);
});

test("到点发送成功后写入 lastSent，同一天不再发送", async (t) => {
  quiet(t);
  const rt = makeRt();
  const deps = makeDeps();
  await tickDailyReport(rt, AT_0900, deps);
  assert.equal(rt.store.settings.dailyReport.lastSent, "2026-10-16");
  assert.equal(rt.saves, 1);
  assert.deepEqual(deps.calls.sends.map((s) => s.title), ["日报"]);
  await tickDailyReport(rt, AT_0900 + 30_000, deps);
  assert.equal(deps.calls.build, 1);
});

test("构建失败不占用当天，5 分钟后重试成功", async (t) => {
  quiet(t);
  const rt = makeRt();
  const deps = makeDeps({ buildFails: 1 });
  await tickDailyReport(rt, AT_0900, deps);
  assert.equal(rt.store.settings.dailyReport.lastSent, null);
  await tickDailyReport(rt, AT_0900 + 30_000, deps); // 同一分钟的下一拍：未到重试时间
  await tickDailyReport(rt, AT_0900 + MIN, deps);
  assert.equal(deps.calls.build, 1);
  await tickDailyReport(rt, AT_0900 + REPORT_RETRY_MS, deps);
  assert.equal(deps.calls.build, 2);
  assert.equal(rt.store.settings.dailyReport.lastSent, "2026-10-16");
  assert.deepEqual(deps.calls.sends.map((s) => s.title), ["日报"]);
});

test("所有渠道都发送失败时按失败处理并重试", async (t) => {
  quiet(t);
  const rt = makeRt();
  const deps = makeDeps({ sendOk: false });
  await tickDailyReport(rt, AT_0900, deps);
  assert.equal(rt.store.settings.dailyReport.lastSent, null);
  assert.equal(rt._reportRetry.attempts, 1);
  assert.equal(rt._reportRetry.nextAt, AT_0900 + REPORT_RETRY_MS);
});

test("连续失败到上限后放弃当天并推送失败通知，次日照常发送", async (t) => {
  quiet(t);
  const rt = makeRt();
  const deps = makeDeps({ buildFails: Infinity });
  for (let i = 0; i < REPORT_MAX_ATTEMPTS + 2; i++) await tickDailyReport(rt, AT_0900 + i * REPORT_RETRY_MS, deps);
  assert.equal(deps.calls.build, REPORT_MAX_ATTEMPTS);
  assert.equal(rt.store.settings.dailyReport.lastSent, "2026-10-16");
  assert.equal(deps.calls.sends.length, 1);
  assert.equal(deps.calls.sends[0].title, "日报生成失败");
  assert.match(deps.calls.sends[0].body, /fetch failed \(ETIMEDOUT\)/);

  await tickDailyReport(rt, AT_0900 + 24 * 60 * MIN, deps);
  assert.equal(deps.calls.build, REPORT_MAX_ATTEMPTS + 1);
});

test("上一次发送还在进行时，下一拍不会重入", async (t) => {
  quiet(t);
  const rt = makeRt();
  let release;
  let builds = 0;
  const deps = {
    build: () => { builds++; return new Promise((r) => { release = () => r(REPORT); }); },
    send: async (channels) => channels.map((c) => ({ id: c.id, ok: true })),
  };
  const first = tickDailyReport(rt, AT_0900, deps);
  await tickDailyReport(rt, AT_0900 + 30_000, deps);
  assert.equal(builds, 1);
  release();
  await first;
  assert.equal(rt.store.settings.dailyReport.lastSent, "2026-10-16");
});
