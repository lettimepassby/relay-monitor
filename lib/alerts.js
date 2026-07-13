// 告警引擎：按状态迁移触发通知，带冷却去重
import { broadcast } from "./notify.js";

export const DEFAULT_RULES = {
  onLow: true, // 余额低于阈值
  onExhaust: true, // 余额耗尽
  onError: true, // 查询失败
  onRecover: true, // 恢复正常
  onEta: true, // 预计耗尽天数过近
  etaDays: 3, // 预计 N 天内耗尽则告警
  renotifyHours: 24, // 同一异常状态的重复提醒间隔
};

const STATE_LABEL = {
  ok: "正常",
  warn: "余额偏低",
  danger: "余额耗尽",
  error: "查询失败",
};

function fmtUsd(n) {
  return "$" + Number(n ?? 0).toFixed(2);
}

// 服务器端状态判定（与前端 statusOf 一致）
export function stateOf(station, globalLowUsd) {
  const b = station.balance;
  if (!b) return "unknown";
  if (!b.ok) return "error";
  const th = station.lowBalanceUsd != null ? Number(station.lowBalanceUsd) : Number(globalLowUsd);
  if (b.remaining <= 0) return "danger";
  if (b.remaining < th) return "warn";
  return "ok";
}

function buildMessage(station, state, prediction) {
  const b = station.balance || {};
  const lines = [];
  lines.push(`站点：${station.name}`);
  lines.push(`状态：${STATE_LABEL[state] || state}`);
  if (b.ok) {
    lines.push(`剩余余额：${fmtUsd(b.remaining)}（已用 ${fmtUsd(b.used)} / 共 ${fmtUsd(b.total)}）`);
  } else if (b.error) {
    lines.push(`错误：${b.error}`);
  }
  if (prediction?.etaDays != null) {
    lines.push(`日均消耗：${fmtUsd(prediction.burnPerDay)}/天，预计 ${prediction.etaDays} 天后耗尽`);
  }
  lines.push(`时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  return lines.join("\n");
}

/**
 * 评估一个中转站的告警。
 * alertState 由调用方持久化在 station 记录上：{ state, notifiedAt, etaNotifiedAt }
 * 返回需要更新的 alertState，若无需通知返回 null 表示状态未变。
 */
export async function evaluateStation(station, prediction, rules, channels, globalLowUsd) {
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  const now = Date.now();
  const prev = station.alertState || { state: "unknown", notifiedAt: 0, etaNotifiedAt: 0 };
  const state = stateOf(station, globalLowUsd);
  if (state === "unknown") return null;

  const next = { ...prev, state };
  let notify = null; // {title}

  const isBad = ["warn", "danger", "error"].includes(state);
  const wasBad = ["warn", "danger", "error"].includes(prev.state);
  const ruleFor = { warn: r.onLow, danger: r.onExhaust, error: r.onError };

  if (isBad && state !== prev.state && ruleFor[state]) {
    notify = { title: `【中转站告警】${station.name} ${STATE_LABEL[state]}` };
  } else if (isBad && state === prev.state && ruleFor[state] && r.renotifyHours > 0 &&
             now - (prev.notifiedAt || 0) > r.renotifyHours * 3600000) {
    notify = { title: `【持续告警】${station.name} 仍处于「${STATE_LABEL[state]}」` };
  } else if (state === "ok" && wasBad && r.onRecover) {
    notify = { title: `【恢复通知】${station.name} 已恢复正常` };
  }

  // 预计耗尽告警（独立去重；状态正常但烧钱太快也要提醒）
  // renotifyHours = 0 表示只提醒一次，与上面持续告警的语义一致
  if (!notify && r.onEta && state !== "error" && prediction?.etaDays != null &&
      prediction.etaDays <= r.etaDays &&
      (!prev.etaNotifiedAt ||
        (r.renotifyHours > 0 && now - prev.etaNotifiedAt > r.renotifyHours * 3600000))) {
    notify = { title: `【耗尽预警】${station.name} 预计 ${prediction.etaDays} 天内耗尽`, isEta: true };
  }

  if (notify) {
    const body = buildMessage(station, state, prediction);
    const results = await broadcast(channels, notify.title, body, {
      event: notify.isEta ? "eta" : state,
      station: { id: station.id, name: station.name, type: station.type },
      remaining: station.balance?.remaining ?? null,
    });
    if (notify.isEta) next.etaNotifiedAt = now;
    else next.notifiedAt = now;
    next.lastResults = results.map((x) => ({ name: x.name, ok: x.ok, error: x.error || null }));
  }

  // 状态或通知时间有变化才需要持久化
  if (next.state !== prev.state || next.notifiedAt !== prev.notifiedAt || next.etaNotifiedAt !== prev.etaNotifiedAt) {
    return next;
  }
  return null;
}
