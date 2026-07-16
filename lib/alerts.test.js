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
