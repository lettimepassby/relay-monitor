// POST /api/auth/login —— 登录（无需会话），行为与 v1 完全一致：
// 按 IP 限流，验证用户名+密码，成功后签发会话 Cookie。
import { withRuntime, json, clientIp } from "../../../../lib/api.js";
import { verifyPassword } from "../../../../lib/auth.js";

export const POST = withRuntime(async (request, rt) => {
  const ip = clientIp(request);
  if (rt.sessions.isLocked(ip)) {
    return json({ error: "尝试次数过多，请 5 分钟后再试" }, 429);
  }
  const { username, password } = await request.json().catch(() => ({}));
  const auth = rt.store.auth;
  const userOk = String(username || "") === auth.username;
  const passOk = verifyPassword(password || "", auth.salt, auth.hash);
  if (!userOk || !passOk) {
    rt.sessions.recordFailure(ip);
    return json({ error: "用户名或密码错误" }, 401);
  }
  rt.sessions.recordSuccess(ip);
  const token = rt.sessions.issue(auth.username);
  const res = json({ ok: true, username: auth.username, isDefaultPassword: !!auth.isDefault });
  res.headers.set("Set-Cookie", rt.sessions.cookieHeader(token));
  return res;
});
