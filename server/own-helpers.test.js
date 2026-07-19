import test from "node:test";
import assert from "node:assert/strict";
import {
  mapCostChannels, matchCostStation, normalizeCostUrl, reconcileUsageCost, selectCostUpstreams,
} from "./own-helpers.js";

test("成本渠道支持主地址、api 后缀和显式别名匹配", () => {
  const publicStation = { id: "public", baseUrl: "https://relay.example.com/" };
  const internalStation = {
    id: "internal",
    baseUrl: "https://public.example.com",
    costAliases: ["sub2api-internal", "http://10.0.0.8:8080/api/"],
  };

  assert.equal(normalizeCostUrl(" HTTPS://Relay.Example.com/ "), "relay.example.com");
  assert.equal(matchCostStation([publicStation], "https://relay.example.com/api"), publicStation);
  assert.equal(matchCostStation([internalStation], "http://sub2api-internal/v1"), internalStation);
  assert.equal(matchCostStation([internalStation], "http://10.0.0.8:8080"), internalStation);
  assert.equal(matchCostStation([publicStation], "https://other.example.com"), null);
});

test("用量接口返回零但余额下降时改用历史成本", () => {
  assert.deepEqual(reconcileUsageCost(0, 34.24), {
    usd: 34.24,
    mode: "history",
    note: "用量接口返回 0，已按余额历史推算",
  });
});

test("未出现在 New API 渠道中的监控上游仍计入成本", () => {
  const own = { id: "own", isOwn: true };
  const visible = { id: "visible", baseUrl: "https://visible.example.com" };
  const behindSub2Api = { id: "hidden", baseUrl: "https://hidden.example.com" };
  const excluded = { id: "observe", baseUrl: "https://observe.example.com", includeInProfit: false };
  const channels = [{ name: "Sub2API 统一入口", baseUrl: "http://sub2api-internal", status: 1, type: 1 }];

  const selected = selectCostUpstreams([own, visible, behindSub2Api, excluded], own.id);
  assert.deepEqual(selected.included.map((s) => s.id), [visible.id, behindSub2Api.id]);
  assert.deepEqual(selected.excluded.map((s) => s.id), [excluded.id]);

  const attribution = mapCostChannels(selected.included, channels);
  assert.equal(attribution.matched.size, 0);
  assert.equal(attribution.unmatched.size, 1);
});

test("用量接口有有效成本时保持接口口径", () => {
  assert.deepEqual(reconcileUsageCost(4.1675, 4.16), {
    usd: 4.1675,
    mode: "usage",
    note: null,
  });
});
