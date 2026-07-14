// POST /api/notifications/test —— 发送测试通知
// 两种形态：channelId 指向已保存渠道；或 type+config 试发未保存的临时渠道
import { withAuth, json } from "../../../../lib/api.js";
import { sendToChannel } from "../../../../lib/notify.js";

export const POST = withAuth(async (request, rt) => {
  const b = (await request.json().catch(() => null)) || {};
  let channel = null;
  if (b.channelId) channel = rt.store.channels.find((c) => c.id === b.channelId);
  else if (b.type) channel = { type: b.type, config: b.config || {} };
  if (!channel) return json({ error: "未找到渠道" }, 400);
  const r = await sendToChannel(
    channel,
    "【测试通知】中转站余额监控",
    `这是一条测试消息，来自 relay-monitor。\n渠道：${channel.name || channel.type}\n时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    { event: "test" }
  );
  return json(r);
});
