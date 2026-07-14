// POST /mock/sub2api/:acc/api/v1/auth/login —— 演示 Sub2API 登录（平移自 v1 server.js）
import { json } from "../../../../../../../../lib/api.js";
import { mockSub2ApiLogin } from "../../../../../../../../server/demo.js";

export async function POST(request, ctx) {
  const { acc } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const r = mockSub2ApiLogin(acc, body);
  return json(r.body, r.status);
}
