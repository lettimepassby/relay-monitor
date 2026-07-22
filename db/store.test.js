import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.js";

function fakePool(stations = []) {
  const conn = {
    beginTransaction: async () => {},
    query: async () => [[]],
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
  return {
    query: async (sql) => {
      if (sql.startsWith("SELECT id, doc FROM stations")) {
        return [stations.map((doc) => ({ id: doc.id, doc }))];
      }
      if (sql.startsWith("SELECT k, v FROM meta")) {
        return [[
          { k: "settings", v: {} },
          { k: "auth", v: { username: "admin", salt: "test", hash: "test" } },
          { k: "notifications", v: { channels: [], rules: {} } },
        ]];
      }
      return [[]];
    },
    getConnection: async () => conn,
  };
}

test("旧站点数据升级时默认保持续费", async () => {
  const store = await new Store(fakePool([{ id: "old", name: "旧站点", fixedPurchases: [] }])).load();
  assert.equal(store.get("old").noRenewal, false);
});

test("重新标记不再续费会重置单次提醒资格", async () => {
  const store = new Store(fakePool());
  store.data.stations = [{
    id: "station-1",
    noRenewal: true,
    alertState: { state: "warn", notifiedAt: 10, noRenewalLowNotifiedAt: 20 },
  }];

  await store.update("station-1", { noRenewal: false });
  assert.equal(store.get("station-1").alertState.noRenewalLowNotifiedAt, undefined);
  await store.update("station-1", { noRenewal: true });
  assert.equal(store.get("station-1").noRenewal, true);

  await store.update("station-1", { type: "fixed", noRenewal: true });
  assert.equal(store.get("station-1").noRenewal, false);
});

test("成本渠道匹配别名会清理空值并去重", async () => {
  const store = new Store(fakePool());
  const added = await store.add({
    name: "上游",
    type: "newapi",
    baseUrl: "https://public.example.com",
    costAliases: [" internal-host ", "", "internal-host", "10.0.0.8:8080"],
  });
  assert.deepEqual(added.costAliases, ["internal-host", "10.0.0.8:8080"]);

  await store.update(added.id, { costAliases: "alias-a, alias-b\nalias-a" });
  assert.deepEqual(store.get(added.id).costAliases, ["alias-a", "alias-b"]);
});

test("监控上游默认计入利润成本并可显式排除", async () => {
  const store = new Store(fakePool());
  const included = await store.add({ name: "负载均衡后的上游", type: "newapi", baseUrl: "https://a.example.com" });
  const excluded = await store.add({
    name: "重复汇总节点", type: "sub2api-password", baseUrl: "https://b.example.com", includeInProfit: false,
  });
  assert.equal(store.get(included.id).includeInProfit, true);
  assert.equal(store.get(excluded.id).includeInProfit, false);

  await store.update(excluded.id, { includeInProfit: true });
  assert.equal(store.get(excluded.id).includeInProfit, true);
});

test("渠道绑定：只接受存在的渠道 id，字段级合并", async () => {
  const store = new Store(fakePool());
  store.data.notifications.channels = [
    { id: "ch-1", name: "A", type: "webhook", enabled: true },
    { id: "ch-2", name: "B", type: "webhook", enabled: true },
  ];
  const r1 = await store.updateRules({ channelsFor: { low: ["ch-1", "bogus"], eta: ["ch-2"] } });
  assert.deepEqual(r1.channelsFor.low, ["ch-1"]);
  assert.deepEqual(r1.channelsFor.eta, ["ch-2"]);
  assert.deepEqual(r1.channelsFor.exhaust, []);
  // 只更新载荷里出现的键，其余绑定保持
  const r2 = await store.updateRules({ channelsFor: { exhaust: ["ch-2"] } });
  assert.deepEqual(r2.channelsFor.low, ["ch-1"]);
  assert.deepEqual(r2.channelsFor.exhaust, ["ch-2"]);
});

test("删除渠道时清理告警绑定与日报渠道里的死 id", async () => {
  const store = new Store(fakePool());
  store.data.notifications.channels = [
    { id: "ch-1", name: "A", type: "webhook", enabled: true },
    { id: "ch-2", name: "B", type: "webhook", enabled: true },
  ];
  await store.updateRules({ channelsFor: { low: ["ch-1", "ch-2"], error: ["ch-1"] } });
  store.data.settings.dailyReport = { enabled: true, time: "09:00", channelIds: ["ch-1", "ch-2"], lastSent: null };

  await store.removeChannel("ch-1");
  assert.deepEqual(store.rules.channelsFor.low, ["ch-2"]);
  assert.deepEqual(store.rules.channelsFor.error, []);
  assert.deepEqual(store.settings.dailyReport.channelIds, ["ch-2"]);
});

test("加载旧规则时补齐渠道绑定字段且不共享默认对象", async () => {
  const a = await new Store(fakePool()).load();
  const b = await new Store(fakePool()).load();
  assert.deepEqual(a.rules.channelsFor, { low: [], exhaust: [], error: [], recover: [], eta: [] });
  a.rules.channelsFor.low.push("x");
  assert.deepEqual(b.rules.channelsFor.low, []);
});
