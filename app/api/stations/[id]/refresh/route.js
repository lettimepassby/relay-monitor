// POST /api/stations/:id/refresh（单站手动刷新）——对应 v1 server.js 同名路由
import { withAuth, json } from "../../../../../lib/api.js";
import { redact } from "../../../../../server/stations.js";
import { refreshStation } from "../../../../../server/refresh.js";

export const POST = withAuth(async (request, rt, params) => {
  const s = rt.store.get(params.id);
  if (!s) return json({ error: "未找到该中转站" }, 404);
  const balance = await refreshStation(rt, s);
  return json({ balance, station: redact(rt, s) });
});
