// 每日日报：昨日「我的站点」经营汇总（v1 server.js 日报段的平移）。
// buildReport/sendReport 供 /api/report/preview、/api/report/send 端点调用；
// startReportScheduler 由 lib/runtime.js 在初始化时启动，定时器挂在 rt 字段上。
import { queryOwnData, dateStrInTz, parseDateLabel } from "../lib/providers.js";
import { forecastDaily } from "../lib/forecast.js";
import { broadcast } from "../lib/notify.js";
import { fmtEta } from "../lib/alerts.js";
import { getOwnUsers, computeResold, computeProfit } from "./own-helpers.js";

const DEFAULT_REPORT_TIME_ZONE = "Asia/Shanghai";
const configuredReportTimeZone = process.env.REPORT_TIME_ZONE || DEFAULT_REPORT_TIME_ZONE;
export const REPORT_TIME_ZONE = (() => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: configuredReportTimeZone });
    return configuredReportTimeZone;
  } catch {
    return DEFAULT_REPORT_TIME_ZONE;
  }
})();

function shiftDateLabel(label, days) {
  const [year, month, day] = label.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// 日报日界线必须与进程/容器时区无关，否则 UTC 部署会在北京时间 08:00 才切换“昨天”。
export function reportDayWindow(nowMs = Date.now(), tz = REPORT_TIME_ZONE) {
  const todayLabel = dateStrInTz(nowMs, tz);
  const dayEnd = parseDateLabel(todayLabel, tz);
  const dayStart = parseDateLabel(shiftDateLabel(todayLabel, -1), tz);
  const wideStart = parseDateLabel(shiftDateLabel(todayLabel, -34), tz);
  return { tz, todayLabel, dayStart, dayEnd, wideStart };
}

export function reportClock(nowMs = Date.now(), tz = REPORT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(nowMs));
  const value = (type) => parts.find((p) => p.type === type)?.value || "00";
  return { today: dateStrInTz(nowMs, tz), hhmm: `${value("hour")}:${value("minute")}` };
}

const rptCny = (v) => "¥" + Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rptTok = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return +(n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return +(n / 1e3).toFixed(1) + "K";
  return String(n);
};
const pctDelta = (cur, base) => {
  if (!(base > 0)) return "";
  const d = ((cur - base) / base) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
};

// 汇总昨日（日报时区自然日）经营情况，返回 {title, text, html}
export async function buildReport(rt) {
  const { store, history } = rt;
  const own = store.list().find((s) => s.isOwn && s.type === "newapi");
  if (!own) throw new Error("还没有标记「我的中转站」，无法生成日报");
  const { tz, dayStart, dayEnd, wideStart } = reportDayWindow();
  const ownRate = own.cnyPerUsd != null && own.cnyPerUsd > 0 ? own.cnyPerUsd : 1;

  const [modelRows, userRows] = await Promise.all([
    queryOwnData(own, wideStart, dayEnd, "model"),
    queryOwnData(own, dayStart, dayEnd, "user"),
  ]);
  let ownUsers = null;
  try { ownUsers = await getOwnUsers(rt, own); } catch { /* 降级：不区分管理员 */ }
  const adminSet = new Set((ownUsers || []).filter((u) => u.role >= 10).map((u) => u.username));

  // 昨日聚合
  const agg = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const a = m.get(r.key) || { key: r.key, tokens: 0, cost: 0, requests: 0 };
      a.tokens += r.tokens; a.cost += r.cost; a.requests += r.requests;
      m.set(r.key, a);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  };
  const yRows = modelRows.filter((r) => r.t >= dayStart && r.t < dayEnd);
  const yUserRows = userRows.filter((r) => r.t >= dayStart && r.t < dayEnd);
  const byModel = agg(yRows);
  const byUser = agg(yUserRows).map((u) => ({ ...u, isAdmin: adminSet.has(u.key) }));
  const totalCost = byModel.reduce((a, m) => a + m.cost, 0);
  const totalTokens = byModel.reduce((a, m) => a + m.tokens, 0);
  const totalReqs = byModel.reduce((a, m) => a + m.requests, 0);
  const rawIncomeUsd = byUser.filter((u) => !u.isAdmin).reduce((a, u) => a + u.cost, 0);
  const rawAdminUsd = byUser.filter((u) => u.isAdmin).reduce((a, u) => a + u.cost, 0);
  // 转售的管理员 Key 消费改计入收入（与「我的站点」页口径一致）
  const resold = await computeResold(own, rawIncomeUsd, rawAdminUsd, dayStart, dayEnd);
  const incomeUsd = resold.incomeUsd;
  const adminUsd = resold.adminUsageUsd;

  // 昨日利润（成本窗口 = 昨日自然日）
  const profit = await computeProfit(rt, own, incomeUsd, adminUsd, { startMs: dayStart, now: dayEnd, tz, range: "7d", resold });

  // 日序列（近 34 天，不含今天）→ 环比与预测
  const dmap = new Map();
  for (const r of modelRows) {
    if (r.t >= dayEnd) continue;
    const dt = parseDateLabel(dateStrInTz(r.t, tz), tz);
    dmap.set(dt, (dmap.get(dt) || 0) + r.cost);
  }
  const daily = [];
  if (dmap.size) {
    const firstDay = Math.min(...dmap.keys());
    for (let t = firstDay; t < dayEnd; t += 86400000) daily.push({ t, cost: dmap.get(t) || 0 });
  }
  const prev = daily.length >= 2 ? daily[daily.length - 2].cost : null;
  const avg7 = daily.slice(-7).reduce((a, x) => a + x.cost, 0) / Math.min(7, daily.length || 1);
  const fc = forecastDaily(daily, 7);

  // 上游余额状态（排除自有站与固定成本渠道）
  const upstreams = store.list().filter((s) => !s.isOwn && s.type !== "fixed");
  const upLines = upstreams.map((s) => {
    const rate = s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1;
    const b = s.balance;
    if (!b) return `- ${s.name}：尚未查询`;
    if (!b.ok) return `- ${s.name}：⚠ 查询失败（${b.error || "未知错误"}）`;
    const p = history.predict(s.id);
    let tail = "近期无消耗";
    if (p && p.etaDays != null) tail = `≈${rptCny(p.burnPerDay * rate)}/天 · 预计 ${fmtEta(p.etaDays)}后耗尽${p.etaDays <= 3 ? " ⚠" : ""}`;
    return `- ${s.name}：${rptCny(b.remaining * rate)}（${tail}）`;
  });

  const balanceTotal = (ownUsers || [])
    .filter((u) => u.role < 10)
    .reduce((a, u) => a + u.quotaUsd, 0) * ownRate;

  const dateLabel = dateStrInTz(dayStart, tz);
  const dow = "日一二三四五六"[new Date(`${dateLabel}T00:00:00Z`).getUTCDay()];
  const L = [];
  L.push(`【${own.name} 日报】${dateLabel}（周${dow}）`);
  L.push("");
  L.push("■ 经营概览");
  L.push(`昨日消费：${rptCny(totalCost * ownRate)}${prev != null ? `（环比 ${pctDelta(totalCost, prev)}，近7天日均 ${rptCny(avg7 * ownRate)} ${pctDelta(totalCost, avg7)}）` : ""}`);
  L.push(`收入(不含管理员)：${rptCny(incomeUsd * ownRate)} ｜ 管理员消耗：${rptCny(adminUsd * ownRate)}`);
  if (profit && !profit.error) {
    L.push(`成本：${rptCny(profit.totalCostCny)} ｜ 利润：${rptCny(profit.profitCny)}${profit.marginPct != null ? `（利润率 ${profit.marginPct}%）` : ""}`);
    if (profit.warnings?.length) L.push(`口径提示：${profit.warnings.join("；")}`);
  }
  L.push("");
  L.push("■ 用量");
  L.push(`请求 ${totalReqs.toLocaleString("en-US")} 次 ｜ Tokens ${rptTok(totalTokens)} ｜ 活跃用户 ${byUser.length} 个`);
  L.push("");
  L.push("■ Top 模型（按消费）");
  byModel.slice(0, 5).forEach((m, i) => L.push(`${i + 1}. ${m.key}  ${rptCny(m.cost * ownRate)}（${rptTok(m.tokens)} tokens · ${m.requests.toLocaleString("en-US")} 次）`));
  if (!byModel.length) L.push("（昨日无消费）");
  L.push("");
  L.push("■ Top 用户（按消费）");
  byUser.slice(0, 5).forEach((u, i) => L.push(`${i + 1}. ${u.key}${u.isAdmin ? "（管理员）" : ""}  ${rptCny(u.cost * ownRate)}（${rptTok(u.tokens)} tokens）`));
  if (!byUser.length) L.push("（昨日无消费）");
  if (profit && !profit.error && profit.costs.length) {
    L.push("");
    L.push("■ 成本明细（昨日）");
    const MODE = { usage: "按用量", fixed: "固定摊销", history: "余额推算≈" };
    profit.costs.forEach((c) => L.push(`- ${c.name}  ${rptCny(c.cny)}（${MODE[c.mode] || c.mode}${c.note ? " · " + c.note : ""}）`));
    if (profit.unmatched.length) L.push(`（另有 ${profit.unmatched.length} 组渠道未纳入成本计算）`);
  }
  L.push("");
  L.push("■ 上游余额");
  L.push(...(upLines.length ? upLines : ["（暂无上游站点）"]));
  if (ownUsers) {
    L.push("");
    L.push(`■ 用户余额合计：${rptCny(balanceTotal)}（预收，${ownUsers.filter((u) => u.role < 10).length} 个用户）`);
  }
  if (fc) {
    L.push("");
    L.push("■ 展望");
    L.push(`今天预计：≈${rptCny(fc.points[0].cost * ownRate)}（区间 ${rptCny(fc.points[0].lo * ownRate)} ~ ${rptCny(fc.points[0].hi * ownRate)}）`);
    L.push(`未来 7 天预计：≈${rptCny(fc.nextTotal * ownRate)}（区间 ${rptCny((fc.nextLo ?? 0) * ownRate)} ~ ${rptCny((fc.nextHi ?? 0) * ownRate)}）`);
    L.push(`（${fc.method} · 基于 ${fc.sampleDays} 天 · 回测日均偏差 ±${fc.backtestWapePct ?? "?"}%）`);
  }
  const html = buildReportHtml(rt, {
    own, dateLabel, dow, ownRate,
    totalCost, prev, avg7, incomeUsd, adminUsd, profit,
    totalReqs, totalTokens, activeUsers: byUser.length,
    byModel, byUser, daily, fc, upstreams, balanceTotal,
    userCount: (ownUsers || []).filter((u) => u.role < 10).length, hasUsers: !!ownUsers,
  });
  return { title: `【日报】${own.name} ${dateLabel}`, text: L.join("\n"), html };
}

// 邮件安全的 HTML 日报：全内联样式 + 表格排版，图表用色块/条形实现
//（Gmail 会剥离 SVG、屏蔽 data:URI 图片，这是全客户端可靠的做法）
function buildReportHtml(rt, d) {
  const { history } = rt;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const C = { ink: "#1c1c1e", sub: "#6e6e73", line: "#e5e5ea", blue: "#0a84ff", blueSoft: "#b9d6f8", green: "#1f9d4d", red: "#d03b3b", track: "#eef1f5", bg: "#f5f6f8" };
  const font = "font-family:-apple-system,'PingFang SC','Segoe UI',sans-serif;";
  const money = (v) => rptCny(v);

  const kpi = (label, value, sub, color) => `
    <td width="25%" style="padding:6px"><div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:12px 14px">
      <div style="${font}font-size:11px;color:${C.sub}">${esc(label)}</div>
      <div style="${font}font-size:20px;font-weight:700;color:${color || C.ink};margin-top:2px">${esc(value)}</div>
      ${sub ? `<div style="${font}font-size:11px;color:${C.sub};margin-top:2px">${esc(sub)}</div>` : ""}
    </div></td>`;

  const section = (title, inner) => `
    <tr><td style="padding:18px 12px 6px;${font}font-size:14px;font-weight:700;color:${C.ink}">${esc(title)}</td></tr>
    <tr><td style="padding:0 12px">${inner}</td></tr>`;

  // 14 天消费柱状图（表格 + 色块；昨日高亮）
  const days = d.daily.slice(-14);
  const maxDay = Math.max(...days.map((x) => x.cost), 0.01);
  const trendCols = days.map((x, i) => {
    const h = Math.max(3, Math.round((x.cost / maxDay) * 72));
    const last = i === days.length - 1;
    return `<td align="center" valign="bottom" style="padding:0 2px">
      <div title="${esc(money(x.cost * d.ownRate))}" style="height:${h}px;background:${last ? C.blue : C.blueSoft};border-radius:3px 3px 0 0"></div>
    </td>`;
  }).join("");
  const fmtMD = (t) => { const dd = new Date(t); return `${dd.getMonth() + 1}/${dd.getDate()}`; };
  const trend = days.length ? `
    <div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:14px">
      <table width="100%" cellpadding="0" cellspacing="0" style="height:76px"><tr>${trendCols}</tr></table>
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="${font}font-size:10px;color:${C.sub}">${fmtMD(days[0].t)}</td>
        <td align="right" style="${font}font-size:10px;color:${C.sub}">昨日 ${fmtMD(days[days.length - 1].t)} · ${esc(money(days[days.length - 1].cost * d.ownRate))}</td>
      </tr></table>
    </div>` : "";

  // 条形榜单（名称 + 比例条 + 数值）
  const barList = (rows, nameOf, valOf, valText) => {
    const max = Math.max(...rows.map(valOf), 1e-9);
    return `<div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:6px 14px">
      ${rows.map((r) => `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0"><tr>
        <td width="34%" style="${font}font-size:12px;color:${C.ink};white-space:nowrap;overflow:hidden">${nameOf(r)}</td>
        <td style="padding:0 10px"><div style="background:${C.track};border-radius:4px"><div style="width:${Math.max(2, Math.round(valOf(r) / max * 100))}%;height:8px;background:${C.blue};border-radius:4px"></div></div></td>
        <td width="20%" align="right" style="${font}font-size:12px;color:${C.ink};font-weight:600;white-space:nowrap">${valText(r)}</td>
      </tr></table>`).join("")}
    </div>`;
  };

  const modelBars = d.byModel.length
    ? barList(d.byModel.slice(0, 5), (m) => esc(m.key), (m) => m.cost, (m) => esc(money(m.cost * d.ownRate)))
    : `<div style="${font}font-size:12px;color:${C.sub}">昨日无消费</div>`;
  const userBars = d.byUser.length
    ? barList(d.byUser.slice(0, 5),
        (u) => `${esc(u.key)}${u.isAdmin ? ` <span style="color:${C.red};font-size:10px">管理员</span>` : ""}`,
        (u) => u.cost, (u) => esc(money(u.cost * d.ownRate)))
    : `<div style="${font}font-size:12px;color:${C.sub}">昨日无消费</div>`;

  const MODE = { usage: "按用量", fixed: "固定摊销", history: "余额推算≈" };
  const costRows = (d.profit && !d.profit.error && d.profit.costs.length)
    ? `<div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:6px 14px">
      ${d.profit.costs.map((c) => `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:7px 0"><tr>
          <td style="${font}font-size:12px;color:${C.ink}">${esc(c.name)} <span style="color:${C.sub};font-size:11px">${esc(MODE[c.mode] || c.mode)}${c.note ? " · " + esc(c.note) : ""}</span></td>
          <td align="right" style="${font}font-size:12px;font-weight:600;color:${C.ink}">${esc(money(c.cny))}</td>
        </tr></table>`).join("")}
      ${d.profit.unmatched.length ? `<div style="${font}font-size:11px;color:${C.sub};margin:6px 0">另有 ${d.profit.unmatched.length} 组渠道未纳入成本计算</div>` : ""}
    </div>` : "";
  const profitWarnings = d.profit?.warnings?.length
    ? `<div style="${font}font-size:11px;color:${C.red};line-height:1.8">口径提示：${esc(d.profit.warnings.join("；"))}</div>`
    : "";

  const upRows = `<div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:6px 14px">
    ${d.upstreams.map((s) => {
      const rate = s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1;
      const b = s.balance;
      let status = "尚未查询", warn = false;
      if (b && !b.ok) { status = `查询失败（${b.error || "未知"}）`; warn = true; }
      else if (b) {
        const p = history.predict(s.id);
        status = p && p.etaDays != null ? `≈${money(p.burnPerDay * rate)}/天 · 预计 ${fmtEta(p.etaDays)}后耗尽` : "近期无消耗";
        warn = !!(p && p.etaDays != null && p.etaDays <= 3);
      }
      return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:7px 0"><tr>
        <td style="${font}font-size:12px;color:${C.ink}">${esc(s.name)} <span style="color:${warn ? C.red : C.sub};font-size:11px">${warn ? "⚠ " : ""}${esc(status)}</span></td>
        <td align="right" style="${font}font-size:12px;font-weight:600;color:${C.ink}">${b && b.ok ? esc(money(b.remaining * rate)) : "—"}</td>
      </tr></table>`;
    }).join("") || `<div style="${font}font-size:12px;color:${C.sub}">暂无上游站点</div>`}
  </div>`;

  const outlook = d.fc ? `
    <div style="background:#fff;border:1px solid ${C.line};border-radius:10px;padding:12px 14px;${font}font-size:12px;color:${C.ink};line-height:1.9">
      今天预计 <b>≈${esc(money(d.fc.points[0].cost * d.ownRate))}</b>（区间 ${esc(money(d.fc.points[0].lo * d.ownRate))} ~ ${esc(money(d.fc.points[0].hi * d.ownRate))}）<br>
      未来 7 天预计 <b>≈${esc(money(d.fc.nextTotal * d.ownRate))}</b>（区间 ${esc(money((d.fc.nextLo ?? 0) * d.ownRate))} ~ ${esc(money((d.fc.nextHi ?? 0) * d.ownRate))}）<br>
      <span style="color:${C.sub};font-size:11px">${esc(d.fc.method)} · 基于 ${d.fc.sampleDays} 天 · 回测日均偏差 ±${d.fc.backtestWapePct ?? "?"}%</span>
    </div>` : "";

  const profitOk = d.profit && !d.profit.error;
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${C.bg}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:18px 0"><tr><td align="center">
  <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
    <tr><td style="padding:6px 12px 2px;${font}font-size:18px;font-weight:700;color:${C.ink}">${esc(d.own.name)} 日报</td></tr>
    <tr><td style="padding:0 12px 8px;${font}font-size:12px;color:${C.sub}">${esc(d.dateLabel)}（周${esc(d.dow)}）· 由 relay-monitor 生成</td></tr>
    <tr><td><table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${kpi("昨日消费", money(d.totalCost * d.ownRate), d.prev != null ? `环比 ${pctDelta(d.totalCost, d.prev)} · 7日均 ${pctDelta(d.totalCost, d.avg7)}` : "", null)}
      ${kpi("收入（不含管理员）", money(d.incomeUsd * d.ownRate), d.adminUsd > 0 ? `管理员另耗 ${money(d.adminUsd * d.ownRate)}` : "", null)}
      ${kpi("成本", profitOk ? money(d.profit.totalCostCny) : "—", "", null)}
      ${kpi("利润", profitOk ? money(d.profit.profitCny) : "—", profitOk && d.profit.marginPct != null ? `利润率 ${d.profit.marginPct}%` : "", profitOk && d.profit.profitCny >= 0 ? C.green : C.red)}
    </tr></table></td></tr>
    ${section("近 14 天消费趋势", trend)}
    ${section(`用量：请求 ${d.totalReqs.toLocaleString("en-US")} 次 · Tokens ${rptTok(d.totalTokens)} · 活跃用户 ${d.activeUsers} 个`, "")}
    ${section("Top 模型（按消费）", modelBars)}
    ${section("Top 用户（按消费）", userBars)}
    ${profitWarnings ? section("利润口径", profitWarnings) : ""}
    ${costRows ? section("成本明细（昨日）", costRows) : ""}
    ${section("上游余额", upRows)}
    ${d.hasUsers ? section(`用户余额合计：${money(d.balanceTotal)}（预收 · ${d.userCount} 个用户）`, "") : ""}
    ${outlook ? section("展望", outlook) : ""}
    <tr><td style="padding:16px 12px;${font}font-size:11px;color:${C.sub}">relay-monitor 每日日报 · 统计区间为 ${esc(d.dateLabel)} 00:00–24:00</td></tr>
  </table></td></tr></table></body></html>`;
}

// 日报的目标渠道：settings.dailyReport.channelIds 为空数组时发给所有启用渠道。
// channelIds 参数可覆盖设置（v1 的 send 端点不读请求体，调用方不传即与 v1 一致）。
function reportChannels(rt, channelIds) {
  const cfg = rt.store.settings.dailyReport || {};
  const ids = Array.isArray(channelIds) ? channelIds : Array.isArray(cfg.channelIds) ? cfg.channelIds : [];
  return rt.store.channels.filter((c) => c.enabled !== false && (!ids.length || ids.includes(c.id)));
}

// 立即发送日报（/api/report/send 的主体）。与 v1 一致：手动发送不占用 lastSent，
// 不影响当天的定时发送。构建失败会抛错，由调用方决定响应状态码。
export async function sendReport(rt, channelIds) {
  const { title, text, html } = await buildReport(rt);
  const results = await broadcast(reportChannels(rt, channelIds), title, text, { event: "daily-report", html });
  return { ok: true, results };
}

// 调度：每 30 秒按日报时区检查（HH:MM 命中且当天未发送）
export function startReportScheduler(rt) {
  if (rt._reportTimer) clearInterval(rt._reportTimer); // HMR/重复初始化时防止双定时器
  rt._reportTimer = setInterval(async () => {
    const cfg = rt.store.settings.dailyReport;
    if (!cfg?.enabled || !cfg.time) return;
    const { hhmm, today } = reportClock();
    if (hhmm !== cfg.time || cfg.lastSent === today) return;
    cfg.lastSent = today; // 先占位，避免同一分钟重复发送
    await rt.store.save();
    try {
      const { title, text, html } = await buildReport(rt);
      await broadcast(reportChannels(rt), title, text, { event: "daily-report", html });
      console.log(`日报已发送（${today} ${cfg.time}）`);
    } catch (err) {
      console.error("日报发送失败:", err?.message);
    }
  }, 30000);
}
