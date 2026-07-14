// GET /api/stations（列表）+ POST /api/stations（新增）——对应 v1 server.js 同名路由
import { withAuth, json } from "../../../lib/api.js";
import { STATION_TYPES } from "../../../lib/providers.js";
import { redact } from "../../../server/stations.js";
import { refreshStation } from "../../../server/refresh.js";

export const GET = withAuth(async (request, rt) => {
  return json({ stations: rt.store.list().map((s) => redact(rt, s)), settings: rt.store.settings });
});

export const POST = withAuth(async (request, rt) => {
  const b = (await request.json().catch(() => null)) || {};
  if (!b.type || !STATION_TYPES.some((t) => t.value === b.type))
    return json({ error: "无效的中转站类型" }, 400);
  if (!b.baseUrl && b.type !== "fixed") return json({ error: "请填写站点地址" }, 400);
  const s = await rt.store.add(b);
  refreshStation(rt, s).catch(() => {});
  return json({ station: redact(rt, s) });
});
