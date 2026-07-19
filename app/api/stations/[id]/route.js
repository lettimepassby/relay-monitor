// PUT /api/stations/:id（编辑）+ DELETE /api/stations/:id（删除）——对应 v1 server.js 同名路由
import { withAuth, json } from "../../../../lib/api.js";
import { STATION_TYPES } from "../../../../lib/providers.js";
import { redact } from "../../../../server/stations.js";
import { refreshStation } from "../../../../server/refresh.js";

export const PUT = withAuth(async (request, rt, params) => {
  const b = (await request.json().catch(() => null)) || {};
  if ("type" in b && !STATION_TYPES.some((t) => t.value === b.type))
    return json({ error: "无效的中转站类型" }, 400);
  const s = await rt.store.update(params.id, b);
  if (!s) return json({ error: "未找到该中转站" }, 404);
  rt._ownCache?.clear();
  delete rt._ownChannelsCache;
  delete rt._ownUsersCache;
  refreshStation(rt, s).catch(() => {});
  return json({ station: redact(rt, s) });
});

export const DELETE = withAuth(async (request, rt, params) => {
  const ok = await rt.store.remove(params.id);
  rt._ownCache?.clear();
  delete rt._ownChannelsCache;
  delete rt._ownUsersCache;
  rt.history.remove(params.id);
  return json({ ok });
});
