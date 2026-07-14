// POST /api/auth/logout —— 退出登录：清除会话 Cookie（v1 中该接口位于登录中间件之后，需已登录）
import { withAuth, json } from "../../../../lib/api.js";

export const POST = withAuth(async (request, rt) => {
  const res = json({ ok: true });
  res.headers.set("Set-Cookie", rt.sessions.clearCookieHeader());
  return res;
});
