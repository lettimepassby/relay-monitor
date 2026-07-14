// PUT /api/notifications/rules —— 更新通知规则（字段校验在 store.updateRules 内部）
import { withAuth, json } from "../../../../lib/api.js";

export const PUT = withAuth(async (request, rt) => {
  const body = (await request.json().catch(() => null)) || {};
  return json({ rules: await rt.store.updateRules(body) });
});
