import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStation } from "./alerts.js";

const rules = {
  onLow: true,
  onExhaust: true,
  onError: true,
  onRecover: true,
  onEta: true,
  etaDays: 3,
  renotifyHours: 1,
};

function station(overrides = {}) {
  return {
    id: "station-1",
    name: "测试站点",
    type: "newapi",
    noRenewal: true,
    balance: { ok: true, remaining: 4, used: 6, total: 10 },
    ...overrides,
  };
}

test("不再续费站点只发送一次低余额提醒", async () => {
  const s = station();
  const first = await evaluateStation(s, null, rules, [], 5);
  assert.equal(first.state, "warn");
  assert.ok(first.noRenewalLowNotifiedAt > 0);

  s.alertState = first;
  assert.equal(await evaluateStation(s, null, rules, [], 5), null);

  s.balance.remaining = 0;
  const exhausted = await evaluateStation(s, null, rules, [], 5);
  assert.equal(exhausted.state, "danger");
  assert.equal(exhausted.noRenewalLowNotifiedAt, first.noRenewalLowNotifiedAt);
  assert.equal(exhausted.notifiedAt, first.notifiedAt);
});

test("不再续费站点不发送预计耗尽提醒", async () => {
  const s = station({
    balance: { ok: true, remaining: 10, used: 0, total: 10 },
    alertState: { state: "ok", notifiedAt: 0, etaNotifiedAt: 0, errorCount: 0 },
  });
  const prediction = { burnPerDay: 5, etaDays: 2 };
  assert.equal(await evaluateStation(s, prediction, rules, [], 5), null);
});

test("不再续费站点仍发送查询失败告警", async () => {
  const s = station({
    balance: { ok: false, error: "连接超时" },
    alertState: {
      state: "warn",
      notifiedAt: 0,
      etaNotifiedAt: 0,
      noRenewalLowNotifiedAt: 1,
      errorCount: 0,
    },
  });
  const next = await evaluateStation(s, null, rules, [], 5);
  assert.equal(next.state, "error");
  assert.ok(next.notifiedAt > 0);
});

test("普通站点仍按全局间隔重复提醒", async () => {
  const s = station({
    noRenewal: false,
    alertState: { state: "warn", notifiedAt: 1, etaNotifiedAt: 0, errorCount: 0 },
  });
  const next = await evaluateStation(s, null, rules, [], 5);
  assert.ok(next.notifiedAt > 1);
});

// 渠道用未知 type：sendToChannel 直接返回失败、不发网络请求，
// 通过 lastResults 里的渠道名断言实际的推送目标
const chA = { id: "ch-a", name: "A", type: "__test__", enabled: true };
const chB = { id: "ch-b", name: "B", type: "__test__", enabled: true };

test("按告警类型绑定渠道：低余额只发到绑定的渠道", async () => {
  const s = station({ noRenewal: false });
  const bound = { ...rules, channelsFor: { low: ["ch-b"], exhaust: [], error: [], recover: [], eta: [] } };
  const next = await evaluateStation(s, null, bound, [chA, chB], 5);
  assert.equal(next.state, "warn");
  assert.deepEqual(next.lastResults.map((x) => x.name), ["B"]);
});

test("未绑定渠道时发送到所有启用渠道", async () => {
  const s = station({ noRenewal: false });
  const next = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.deepEqual(next.lastResults.map((x) => x.name).sort(), ["A", "B"]);
});

test("耗尽预警走 eta 绑定，且忽略停用渠道", async () => {
  const s = station({
    noRenewal: false,
    balance: { ok: true, remaining: 10, used: 0, total: 10 },
    alertState: { state: "ok", notifiedAt: 0, etaNotifiedAt: 0, errorCount: 0 },
  });
  const bound = { ...rules, channelsFor: { low: [], exhaust: [], error: [], recover: [], eta: ["ch-a", "ch-b"] } };
  const disabledB = { ...chB, enabled: false };
  const next = await evaluateStation(s, { burnPerDay: 5, etaDays: 2 }, bound, [chA, disabledB], 5);
  assert.ok(next.etaNotifiedAt > 0);
  assert.deepEqual(next.lastResults.map((x) => x.name), ["A"]);
});
