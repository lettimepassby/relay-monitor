// POST /api/auth/password —— 修改用户名/密码：先校验原密码，新密码至少 6 位
import { withAuth, json } from "../../../../lib/api.js";
import { verifyPassword } from "../../../../lib/auth.js";

export const POST = withAuth(async (request, rt) => {
  const { oldPassword, newPassword, username } = await request.json().catch(() => ({}));
  if (!verifyPassword(oldPassword || "", rt.store.auth.salt, rt.store.auth.hash)) {
    return json({ error: "原密码错误" }, 400);
  }
  if (!newPassword || String(newPassword).length < 6) {
    return json({ error: "新密码至少 6 位" }, 400);
  }
  await rt.store.setPassword(username ? String(username).trim() : undefined, String(newPassword));
  // 旧会话继续有效（同一秘钥签名）；仅更新凭证
  return json({ ok: true });
});
