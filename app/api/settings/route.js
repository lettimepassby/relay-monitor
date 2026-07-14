// PUT /api/settings —— 更新全局设置；刷新间隔可能变化，随后重启轮询定时器
import { withAuth, json } from "../../../lib/api.js";
import { restartPolling, refreshAll } from "../../../server/refresh.js";

export const PUT = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  const patch = {};
  if (body?.refreshIntervalSec != null)
    patch.refreshIntervalSec = Math.max(10, Number(body.refreshIntervalSec) || 60);
  if (body?.lowBalanceUsd != null)
    patch.lowBalanceUsd = Math.max(0, Number(body.lowBalanceUsd) || 0);
  if (body?.dailyReport && typeof body.dailyReport === "object")
    patch.dailyReport = body.dailyReport; // store 内部做字段校验合并
  const settings = await rt.store.updateSettings(patch);
  restartPolling(rt);
  // 立即刷新一轮：重置定时器后第一次触发要等满整个周期，不主动刷会显得设置没生效
  refreshAll(rt).catch(() => {});
  return json({ settings });
});
