// POST /api/notifications/channels —— 新增通知渠道
import { withAuth, json } from "../../../../lib/api.js";
import { CHANNEL_TYPES } from "../../../../lib/notify.js";

export const POST = withAuth(async (request, rt) => {
  const b = (await request.json().catch(() => null)) || {};
  if (!CHANNEL_TYPES.some((t) => t.value === b.type))
    return json({ error: "无效的渠道类型" }, 400);
  const ch = await rt.store.addChannel(b);
  return json({ channel: ch });
});
