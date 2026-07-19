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

test("全局只保留一个 Sub2API 成本汇总站", async () => {
  const store = new Store(fakePool());
  const first = await store.add({ name: "网关 A", type: "sub2api", baseUrl: "https://a.example.com", costGateway: true });
  const second = await store.add({ name: "网关 B", type: "sub2api-password", baseUrl: "https://b.example.com", costGateway: true });
  assert.equal(store.get(first.id).costGateway, false);
  assert.equal(store.get(second.id).costGateway, true);

  await store.update(first.id, { costGateway: true });
  assert.equal(store.get(first.id).costGateway, true);
  assert.equal(store.get(second.id).costGateway, false);
});
