// Cloudflare Turnstile 人机验证：登录前置，防密码爆破。
// 同时配置 TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY 才启用；运行时读取（镜像通用），改完重启容器生效。
// 组件的「主机名」只能是域名（不支持 IP），启用后面板须通过该域名访问。
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileConfig() {
  const siteKey = String(process.env.TURNSTILE_SITE_KEY || "").trim();
  const secret = String(process.env.TURNSTILE_SECRET_KEY || "").trim();
  return siteKey && secret ? { siteKey, secret } : null;
}

// 校验前端拿到的令牌（一次性、5 分钟有效）→ { ok: true } 或 { ok: false, status, error }
export async function verifyTurnstile(secret, token) {
  token = typeof token === "string" ? token.trim() : "";
  if (!token) return { ok: false, status: 400, error: "请先完成人机验证" };
  if (token.length > 2048) return { ok: false, status: 400, error: "人机验证令牌无效" };

  let body;
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token }),
      signal: AbortSignal.timeout(10000),
    });
    body = await res.json();
  } catch {
    // 失败即关闭：校验服务不可达时拒绝登录（紧急情况可去掉两个环境变量重启容器）
    return { ok: false, status: 503, error: "人机验证服务暂时不可用，请稍后重试" };
  }
  if (body?.success === true) return { ok: true };

  const codes = Array.isArray(body?.["error-codes"]) ? body["error-codes"] : [];
  // 密钥配错时所有人都登不进来，单独提示并记日志，方便排查
  if (codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret")) {
    console.error("Turnstile 密钥无效，请检查 TURNSTILE_SECRET_KEY:", codes.join(","));
    return { ok: false, status: 500, error: "人机验证配置错误（密钥无效），请联系管理员" };
  }
  return { ok: false, status: 403, error: "人机验证未通过，请刷新验证后重试" };
}
