// GET /mock/newapi/:acc/api/user/ —— 演示 new-api 用户列表（平移自 v1 server.js）
import { json } from "../../../../../../lib/api.js";
import { mockNewApiUserList } from "../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiUserList(request);
  return json(r.body, r.status);
}
