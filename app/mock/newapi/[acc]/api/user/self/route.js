// GET /mock/newapi/:acc/api/user/self —— 演示 new-api 用户信息（平移自 v1 server.js）
import { json } from "../../../../../../../lib/api.js";
import { mockNewApiUserSelf } from "../../../../../../../server/demo.js";

export async function GET(request, ctx) {
  const { acc } = await ctx.params;
  const r = mockNewApiUserSelf(request, acc);
  return json(r.body, r.status);
}
