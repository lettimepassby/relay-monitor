// GET /mock/newapi/:acc/dashboard/billing/subscription —— 演示订阅额度（平移自 v1 server.js）
import { json } from "../../../../../../../lib/api.js";
import { mockNewApiSubscription } from "../../../../../../../server/demo.js";

export async function GET(request, ctx) {
  const { acc } = await ctx.params;
  const r = mockNewApiSubscription(request, acc);
  return json(r.body, r.status);
}
