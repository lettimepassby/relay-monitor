// GET /mock/newapi/:acc/dashboard/billing/usage —— 演示累计用量（平移自 v1 server.js，无需鉴权）
import { json } from "../../../../../../../lib/api.js";
import { mockNewApiUsage } from "../../../../../../../server/demo.js";

export async function GET(request, ctx) {
  const { acc } = await ctx.params;
  const r = mockNewApiUsage(acc);
  return json(r.body, r.status);
}
