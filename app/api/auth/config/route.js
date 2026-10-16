// GET /api/auth/config —— 登录页需要的公开配置（无需会话）：是否启用 Turnstile 人机验证。
// 只下发 site key（本就会出现在前端），secret 永不出服务端。
import { json } from "../../../../lib/api.js";
import { turnstileConfig } from "../../../../lib/turnstile.js";

export const dynamic = "force-dynamic"; // 运行时读环境变量，禁止构建期预渲染成静态结果

export function GET() {
  return json({ turnstileSiteKey: turnstileConfig()?.siteKey || null });
}
