// POST /api/refresh —— 手动全量刷新所有站点，返回脱敏后的站点列表
import { withAuth, json } from "../../../lib/api.js";
import { refreshAll } from "../../../server/refresh.js";
import { redact } from "../../../server/stations.js";

export const POST = withAuth(async (request, rt) => {
  await refreshAll(rt);
  return json({
    stations: rt.store.list().map((s) => redact(rt, s)),
    refreshedAt: new Date().toISOString(),
  });
});
