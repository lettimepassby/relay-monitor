import test from "node:test";
import assert from "node:assert/strict";
import { mapCostChannels, matchCostStation, normalizeCostUrl, reconcileUsageCost } from "./own-helpers.js";

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

test("成本汇总站承接全部渠道且不再匹配后层上游", () => {
  const gateway = { id: "gateway", name: "自建 Sub2API", type: "sub2api-password", costGateway: true };
  const downstream = { id: "upstream", name: "真实上游", type: "newapi", baseUrl: "https://upstream.example.com" };
  const channels = [
    { name: "统一入口", baseUrl: "http://sub2api-internal", status: 1, type: 1 },
    { name: "另一个模型组", baseUrl: "http://sub2api-internal", status: 1, type: 1 },
  ];

  const result = mapCostChannels([gateway, downstream], channels);
  assert.equal(result.gateway, gateway);
  assert.deepEqual([...result.matched.keys()], [gateway.id]);
  assert.deepEqual(result.matched.get(gateway.id).channels, ["统一入口", "另一个模型组"]);
  assert.equal(result.unmatched.size, 0);
});

test("用量接口有有效成本时保持接口口径", () => {
  assert.deepEqual(reconcileUsageCost(4.1675, 4.16), {
    usd: 4.1675,
    mode: "usage",
    note: null,
  });
});
