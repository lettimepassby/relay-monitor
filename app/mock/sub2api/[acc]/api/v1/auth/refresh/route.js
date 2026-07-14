// POST /mock/sub2api/:acc/api/v1/auth/refresh —— 演示 Sub2API 令牌刷新（平移自 v1 server.js）
import { json } from "../../../../../../../../lib/api.js";
import { mockSub2ApiRefresh } from "../../../../../../../../server/demo.js";

export async function POST(request, ctx) {
  const { acc } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const r = mockSub2ApiRefresh(acc, body);
  return json(r.body, r.status);
}
