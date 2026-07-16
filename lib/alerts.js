// 告警引擎：按状态迁移触发通知，带冷却去重
import { broadcast } from "./notify.js";

export const DEFAULT_RULES = {
  onLow: true, // 余额低于阈值
  onExhaust: true, // 余额耗尽
  onError: true, // 查询失败
  onRecover: true, // 恢复正常
  onEta: true, // 预计耗尽天数过近
  etaDays: 3, // 预计 N 天内耗尽则告警（内部统一按天存储，支持小数）
  etaUnit: "days", // 界面展示单位：days | hours
  renotifyHours: 24, // 同一异常状态的重复提醒间隔
  errorThreshold: 1, // 查询连续失败达到该次数才通知（1 = 首次失败即通知）
  errorRetrySec: 30, // 查询失败后隔 N 秒立即重试一次（0 = 关闭快速重试，等下次轮询）
};

// 不足一天用小时表述，避免出现「预计 0.3 天内耗尽」
export function fmtEta(days) {
  return days >= 1 ? `${days} 天` : `${Math.max(1, Math.round(days * 24))} 小时`;
}

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
    lines.push(`日均消耗：${fmtUsd(prediction.burnPerDay)}/天，预计 ${fmtEta(prediction.etaDays)}后耗尽`);
  }
  if (station.noRenewal) {
    lines.push("续费计划：不再续费（余额提醒仅此一次）");
  }
  lines.push(`时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  return lines.join("\n");
}

/**
 * 评估一个中转站的告警。
 * alertState 由调用方持久化在 station 记录上：
 * { state, notifiedAt, etaNotifiedAt, noRenewalLowNotifiedAt }
 * 返回需要更新的 alertState，若无需通知返回 null 表示状态未变。
 */
export async function evaluateStation(station, prediction, rules, channels, globalLowUsd) {
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  const now = Date.now();
  const prev = station.alertState || { state: "unknown", notifiedAt: 0, etaNotifiedAt: 0, errorCount: 0 };
  const rawState = stateOf(station, globalLowUsd);
  if (rawState === "unknown") return null;

  const next = { ...prev };
  // 连续查询失败计数：仅 error 累加，其余状态清零
  next.errorCount = rawState === "error" ? (prev.errorCount || 0) + 1 : 0;

  // 失败次数未达阈值前不视为「查询失败」异常——沿用旧状态，
  // 这样既不会误报，也不会在恢复时误发「恢复通知」
  const threshold = Math.max(1, Math.floor(Number(r.errorThreshold) || 1));
  const state = (rawState === "error" && next.errorCount < threshold) ? prev.state : rawState;
  next.state = state;
  let notify = null; // {title}

  const isBad = ["warn", "danger", "error"].includes(state);
  const wasBad = ["warn", "danger", "error"].includes(prev.state);
  const ruleFor = { warn: r.onLow, danger: r.onExhaust, error: r.onError };

  if (station.noRenewal) {
    // 不再续费的站点只发一次余额提醒：直接从正常跳到耗尽也按低余额提醒处理。
    // 查询失败仍按常规策略通知，避免凭证失效或站点离线被静默。
    const isLowBalance = rawState === "warn" || rawState === "danger";
    if (isLowBalance && r.onLow && !prev.noRenewalLowNotifiedAt) {
      notify = { title: `【低余额提醒】${station.name} 已进入不再续费阶段`, isNoRenewalLow: true };
    } else if (state === "error" && state !== prev.state && r.onError) {
      notify = { title: `【中转站告警】${station.name} ${STATE_LABEL.error}` };
    } else if (state === "error" && state === prev.state && r.onError && r.renotifyHours > 0 &&
               now - (prev.notifiedAt || 0) > r.renotifyHours * 3600000) {
      notify = { title: `【持续告警】${station.name} 仍处于「${STATE_LABEL.error}」` };
    } else if (state === "ok" && prev.state === "error" && r.onRecover) {
      notify = { title: `【恢复通知】${station.name} 已恢复正常` };
    }
  } else {
    if (isBad && state !== prev.state && ruleFor[state]) {
      notify = { title: `【中转站告警】${station.name} ${STATE_LABEL[state]}` };
    } else if (isBad && state === prev.state && ruleFor[state] && r.renotifyHours > 0 &&
               now - (prev.notifiedAt || 0) > r.renotifyHours * 3600000) {
      notify = { title: `【持续告警】${station.name} 仍处于「${STATE_LABEL[state]}」` };
    } else if (state === "ok" && wasBad && r.onRecover) {
      notify = { title: `【恢复通知】${station.name} 已恢复正常` };
    }
  }

  // 预计耗尽告警（独立去重；状态正常但烧钱太快也要提醒）
  // renotifyHours = 0 表示只提醒一次，与上面持续告警的语义一致
  if (!station.noRenewal && !notify && r.onEta && rawState !== "error" && prediction?.etaDays != null &&
      prediction.etaDays <= r.etaDays &&
      (!prev.etaNotifiedAt ||
        (r.renotifyHours > 0 && now - prev.etaNotifiedAt > r.renotifyHours * 3600000))) {
    notify = { title: `【耗尽预警】${station.name} 预计 ${fmtEta(prediction.etaDays)}内耗尽`, isEta: true };
  }

  if (notify) {
    const body = buildMessage(station, state, prediction);
    const results = await broadcast(channels, notify.title, body, {
      event: notify.isNoRenewalLow ? "warn" : notify.isEta ? "eta" : state,
      station: { id: station.id, name: station.name, type: station.type },
      remaining: station.balance?.remaining ?? null,
    });
    if (notify.isNoRenewalLow) next.noRenewalLowNotifiedAt = now;
    else if (notify.isEta) next.etaNotifiedAt = now;
    else next.notifiedAt = now;
    next.lastResults = results.map((x) => ({ name: x.name, ok: x.ok, error: x.error || null }));
  }

  // 状态、通知时间或失败计数有变化才需要持久化
  if (next.state !== prev.state || next.notifiedAt !== prev.notifiedAt ||
      next.etaNotifiedAt !== prev.etaNotifiedAt ||
      next.noRenewalLowNotifiedAt !== prev.noRenewalLowNotifiedAt ||
      next.errorCount !== (prev.errorCount || 0)) {
    return next;
  }
  return null;
}
