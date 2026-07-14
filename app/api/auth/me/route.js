// GET /api/auth/me —— 当前会话信息（v1 中 req.session.u 即会话载荷里的用户名）
import { withAuth, json } from "../../../../lib/api.js";

export const GET = withAuth(async (request, rt, params, session) => {
  return json({ username: session.u, isDefaultPassword: !!rt.store.auth.isDefault });
});
