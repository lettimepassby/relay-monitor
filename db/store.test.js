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
