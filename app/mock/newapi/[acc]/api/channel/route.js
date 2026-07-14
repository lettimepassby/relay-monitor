// GET /mock/newapi/:acc/api/channel/ —— 演示渠道列表（平移自 v1 server.js）
import { json } from "../../../../../../lib/api.js";
import { mockNewApiChannelList } from "../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiChannelList(request);
  return json(r.body, r.status);
}
