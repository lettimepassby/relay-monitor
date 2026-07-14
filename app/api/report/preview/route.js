// POST /api/report/preview —— 日报预览（不发送），返回 { title, text, html }
// 与 v1 一致：构建失败返回 400 { error }（如无站点数据等业务性错误）
import { withAuth, json } from "../../../../lib/api.js";
import { buildReport } from "../../../../server/report.js";

export const POST = withAuth(async (request, rt) => {
  try {
    return json(await buildReport(rt));
  } catch (err) {
    return json({ error: err?.message || String(err) }, 400);
  }
});
