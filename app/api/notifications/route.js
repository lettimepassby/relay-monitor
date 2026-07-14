// GET /api/notifications —— 渠道列表 + 规则 + 可用渠道类型
// 与 v1 一致：channels 原样返回（前端编辑表单需要回填 config，密钥的"不回显"由
// store.updateChannel 的空值保留策略保证，读取侧不做脱敏）
import { withAuth, json } from "../../../lib/api.js";
import { CHANNEL_TYPES } from "../../../lib/notify.js";

export const GET = withAuth(async (request, rt) => {
  return json({ channels: rt.store.channels, rules: rt.store.rules, channelTypes: CHANNEL_TYPES });
});
