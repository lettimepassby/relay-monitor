// POST /api/report/send —— 立即发送日报到日报渠道（settings.dailyReport.channelIds，
// 为空表示全部启用渠道；筛选逻辑在 server/report.js 内），返回 { ok: true, results }
import { withAuth, json } from "../../../../lib/api.js";
import { sendReport } from "../../../../server/report.js";

export const POST = withAuth(async (request, rt) => {
  try {
    const results = await sendReport(rt);
    return json({ ok: true, results });
  } catch (err) {
    return json({ error: err?.message || String(err) }, 400);
  }
});
