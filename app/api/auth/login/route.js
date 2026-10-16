// POST /api/auth/login —— 登录（无需会话），行为与 v1 完全一致：
// 按 IP 限流，验证用户名+密码，成功后签发会话 Cookie。
// 配置了 Turnstile 时先校验人机令牌：没有有效令牌的请求进不到 scrypt，
// 爆破既猜不了密码，也无法再用同步哈希把事件循环占满。
import { withRuntime, json, clientIp } from "../../../../lib/api.js";
import { verifyPassword } from "../../../../lib/auth.js";
import { turnstileConfig, verifyTurnstile } from "../../../../lib/turnstile.js";

export const POST = withRuntime(async (request, rt) => {
  const ip = clientIp(request);
  if (rt.sessions.isLocked(ip)) {
    return json({ error: "尝试次数过多，请 5 分钟后再试" }, 429);
  }
  const { username, password, turnstileToken } = await request.json().catch(() => ({}));
  const turnstile = turnstileConfig();
  if (turnstile) {
    const check = await verifyTurnstile(turnstile.secret, turnstileToken);
    if (!check.ok) return json({ error: check.error }, check.status);
  }
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
