// PUT/DELETE /api/notifications/channels/:id —— 更新 / 删除通知渠道
import { withAuth, json } from "../../../../../lib/api.js";

export const PUT = withAuth(async (request, rt, params) => {
  const body = (await request.json().catch(() => null)) || {};
  const ch = await rt.store.updateChannel(params.id, body);
  if (!ch) return json({ error: "未找到该渠道" }, 404);
  return json({ channel: ch });
});

export const DELETE = withAuth(async (request, rt, params) => {
  return json({ ok: await rt.store.removeChannel(params.id) });
});
