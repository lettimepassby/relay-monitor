// 后台余额刷新循环：查询→写余额→记历史→告警评估→失败快速重试 + 定时轮询节拍。
// 平移自 v1 server.js（refreshOne/doRefreshOne/scheduleErrorRetry/refreshAll/restartPolling），
// 全局 store/history → rt.store/rt.history，模块级状态改挂 rt 字段（多实例/HMR 安全）。
import { queryStation } from "../lib/providers.js";
import { evaluateStation } from "../lib/alerts.js";

// ---------------------------------------------------------------------------
// 余额刷新 + 历史 + 告警
// ---------------------------------------------------------------------------
// 同一站点同时只允许一个刷新在途：定时器、手动刷新、保存后刷新可能重叠，
// 并发会重复发告警、并让 Sub2API 轮换的 refresh_token 相互作废
export function refreshStation(rt, station) {
  if (station.type === "fixed") return Promise.resolve(null); // 固定成本渠道不访问任何接口
  const inflight = rt._inflightRefresh || (rt._inflightRefresh = new Map());
  const running = inflight.get(station.id);
  if (running) return running;
  const p = doRefreshOne(rt, station).finally(() => inflight.delete(station.id));
  inflight.set(station.id, p);
  return p;
}

// 查询失败后的快速重试：不等下一次轮询（可能是几分钟），隔 errorRetrySec 秒再探一次，
// 好尽快累积「连续失败」次数、达到通知阈值。只在仍失败且未达阈值时续排，天然自限。
function scheduleErrorRetry(rt, station) {
  const timers = rt._errorRetryTimers || (rt._errorRetryTimers = new Map());
  const old = timers.get(station.id);
  if (old) { clearTimeout(old); timers.delete(station.id); }

  const r = rt.store.rules || {};
  const delaySec = Number(r.errorRetrySec);
  if (!Number.isFinite(delaySec) || delaySec <= 0) return; // 0/未配置 = 关闭快速重试

  const failing = station.balance && !station.balance.ok;
  const threshold = Math.max(1, Math.floor(Number(r.errorThreshold) || 1));
  const count = station.alertState?.errorCount || 0;
  if (!failing || count >= threshold) return; // 已恢复或已达阈值（已通知）就交回常规轮询

  const t = setTimeout(() => {
    timers.delete(station.id);
    const cur = rt.store.get(station.id); // 期间可能已被删除
    if (cur) refreshStation(rt, cur).catch(() => {});
  }, delaySec * 1000);
  if (t.unref) t.unref();
  timers.set(station.id, t);
}

async function doRefreshOne(rt, station) {
  const { result } = await queryStation(station);
  // 查询在途期间站点可能已被删除：丢弃结果，避免复活历史记录或发幽灵告警
  if (!rt.store.get(station.id)) return result;
  station.balance = result;
  if (result.ok) rt.history.append(station.id, result.remaining, result.used);

  // 告警评估（异步失败不影响主流程）
  try {
    const prediction = rt.history.predict(station.id);
    const next = await evaluateStation(
      station, prediction, rt.store.rules, rt.store.channels, rt.store.settings.lowBalanceUsd
    );
    if (next) station.alertState = next;
  } catch (err) {
    console.error("告警评估失败:", err?.message);
  }

  await rt.store.save(); // balance / s2Tokens / alertState 一并落盘
  scheduleErrorRetry(rt, station); // 失败未达阈值则安排一次快速重试
  return result;
}

export async function refreshAll(rt) {
  return Promise.all(rt.store.list().map((s) => refreshStation(rt, s)));
}

// ---------------------------------------------------------------------------
// 后台定时刷新
// ---------------------------------------------------------------------------
export function restartPolling(rt) {
  const sec = rt.store.settings.refreshIntervalSec || 60;
  if (rt._pollTimer && sec === rt._pollSec) return; // 间隔没变（比如只改了阈值）就不重置节拍
  rt._pollSec = sec;
  if (rt._pollTimer) clearInterval(rt._pollTimer);
  rt._pollTimer = setInterval(() => {
    if (rt._pollRunning) return; // 上一轮还没结束（慢站点超时可达几十秒）就跳过本轮
    rt._pollRunning = true;
    refreshAll(rt).catch(() => {}).finally(() => { rt._pollRunning = false; });
  }, sec * 1000);
}
