// GET /api/history/overview?hours= ——对应 v1 server.js 同名路由
// 总览图表用：全部站点的余额历史（只含时间与余额，前端聚合）
import { withAuth, json } from "../../../../lib/api.js";

export const GET = withAuth(async (request, rt) => {
  const searchParams = new URL(request.url).searchParams;
  const hours = Math.min(24 * 30, Math.max(1, Number(searchParams.get("hours")) || 24));
  return json({
    hours,
    series: rt.store.list().map((s) => ({
      id: s.id,
      name: s.name,
      points: rt.history.points(s.id, hours).map((p) => [p[0], p[1]]),
    })),
  });
});
