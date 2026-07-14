// GET /mock/sub2api/:acc/api/v1/usage/dashboard/stats —— 演示用户仪表盘统计（平移自 v1 server.js）
import { json } from "../../../../../../../../../lib/api.js";
import { mockSub2ApiDashboardStats } from "../../../../../../../../../server/demo.js";

export async function GET(request, ctx) {
  const { acc } = await ctx.params;
  const r = mockSub2ApiDashboardStats(request, acc);
  return json(r.body, r.status);
}
