// GET /mock/sub2api/:acc/api/v1/auth/me —— 演示 Sub2API 用户信息（含令牌过期链路，平移自 v1 server.js）
import { json } from "../../../../../../../../lib/api.js";
import { mockSub2ApiMe } from "../../../../../../../../server/demo.js";

export async function GET(request, ctx) {
  const { acc } = await ctx.params;
  const r = mockSub2ApiMe(request, acc);
  return json(r.body, r.status);
}
