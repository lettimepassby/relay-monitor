// ---- 主题 -----------------------------------------------------------------
const root = document.documentElement;
const THEME_KEY = "app-shell-theme";
const SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
function applyTheme(t) {
  root.setAttribute("data-theme", t);
  localStorage.setItem(THEME_KEY, t);
  document.getElementById("themeToggle").innerHTML = t === "dark" ? SUN : MOON;
  const sw = document.getElementById("set-theme"); // 设置页的主题开关与标题栏保持同步
  if (sw) sw.classList.toggle("on", t === "dark");
}
(function initTheme() {
  const s = localStorage.getItem(THEME_KEY);
  applyTheme(s === "light" || s === "dark" ? s : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
})();
document.getElementById("themeToggle").onclick = () =>
  applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");

// ---- 状态 -----------------------------------------------------------------
const state = {
  stations: [], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 },
  types: [], channelTypes: [], channels: [], rules: {},
  view: "dashboard", user: null, app: null,
  trendHours: 24, overview: null, // 总览趋势图的时间范围与数据缓存 {hours, series, at}
};
let autoTimer = null;

// ---- API（401 自动跳登录）---------------------------------------------------
class AuthError extends Error {}
async function call(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    method: opts.method || (opts.body ? "POST" : "GET"),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/api/auth/login")) {
    showLogin();
    throw new AuthError("未登录");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
const api = {
  meta: () => call("/api/meta"),
  list: () => call("/api/stations"),
  create: (b) => call("/api/stations", { body: b }),
  update: (id, b) => call("/api/stations/" + id, { method: "PUT", body: b }),
  remove: (id) => call("/api/stations/" + id, { method: "DELETE" }),
  refreshOne: (id) => call(`/api/stations/${id}/refresh`, { method: "POST", body: {} }),
  refreshAll: () => call("/api/refresh", { method: "POST", body: {} }),
  historyOf: (id, hours) => call(`/api/stations/${id}/history?hours=${hours}`),
  overview: (hours) => call(`/api/history/overview?hours=${hours}`),
  saveSettings: (b) => call("/api/settings", { method: "PUT", body: b }),
  notifications: () => call("/api/notifications"),
  addChannel: (b) => call("/api/notifications/channels", { body: b }),
  updateChannel: (id, b) => call("/api/notifications/channels/" + id, { method: "PUT", body: b }),
  removeChannel: (id) => call("/api/notifications/channels/" + id, { method: "DELETE" }),
  testChannel: (b) => call("/api/notifications/test", { body: b }),
  saveRules: (b) => call("/api/notifications/rules", { method: "PUT", body: b }),
  login: (b) => call("/api/auth/login", { body: b }),
  logout: () => call("/api/auth/logout", { method: "POST", body: {} }),
  changePassword: (b) => call("/api/auth/password", { body: b }),
};

// ---- 工具 -----------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (n) => "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTokens = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return +(n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return +(n / 1e3).toFixed(1) + "K";
  return String(n);
};
const typeLabel = (v) => (state.types.find((t) => t.value === v)?.label || v);

function threshold(s) {
  return s.lowBalanceUsd != null && s.lowBalanceUsd !== "" ? Number(s.lowBalanceUsd) : Number(state.settings.lowBalanceUsd);
}
function statusOf(s) {
  const b = s.balance;
  if (!b) return "pending";
  if (!b.ok) return "error";
  if (b.remaining <= 0) return "danger";
  if (b.remaining < threshold(s)) return "warn";
  return "ok";
}
function statusPill(st) {
  const map = {
    ok: ["ok", "正常"], warn: ["warn", "余额偏低"], danger: ["danger", "已耗尽"],
    error: ["danger", "查询失败"], pending: ["", "待刷新"],
  };
  const [cls, txt] = map[st] || map.pending;
  return `<span class="pill ${cls}"><span class="dot"></span>${txt}</span>`;
}
function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = "toast " + (kind === "err" ? "err" : "ok");
  el.innerHTML = `<span class="dot"></span>${esc(msg)}`;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function relTime(iso) {
  if (!iso) return "从未";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.max(0, Math.floor(d))} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  return `${Math.floor(d / 3600)} 小时前`;
}
function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtEtaText(days) {
  return days >= 1 ? `${days} 天` : `${Math.max(1, Math.round(days * 24))} 小时`;
}
function etaText(p) {
  if (!p) return null;
  if (p.burnPerDay === 0) return { text: "近期无消耗", cls: "" };
  if (p.etaDays == null) return null;
  const cls = p.etaDays <= (state.rules.etaDays ?? 3) ? "danger" : p.etaDays <= 7 ? "warn" : "";
  return { text: `≈ ${usd(p.burnPerDay)}/天 · 预计 ${fmtEtaText(p.etaDays)}后耗尽`, cls };
}

// ---- 登录 -------------------------------------------------------------------
function showLogin() {
  $("#loginScreen").hidden = false;
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#loginError");
  err.hidden = true;
  try {
    const r = await api.login({
      username: $("#login-username").value.trim(),
      password: $("#login-password").value,
    });
    state.user = r.username;
    $("#loginScreen").hidden = true;
    $("#login-password").value = "";
    if (r.isDefaultPassword) toast("当前为默认密码，建议到「设置」中修改", "err");
    await bootData();
  } catch (e2) {
    err.textContent = e2.message || "登录失败";
    err.hidden = false;
  }
});
$("#logoutBtn").onclick = async () => {
  try { await api.logout(); } catch {}
  showLogin();
};

// ---- 渲染 -----------------------------------------------------------------
const PLATE = { newapi: "NA", "newapi-key": "KEY", sub2api: "S2", "sub2api-password": "S2" };
const CH_PLATE = { telegram: "TG", dingtalk: "DT", wecom: "WC", feishu: "FS", bark: "BK", ntfy: "NF", serverchan: "SC", resend: "RS", smtp: "SM", webhook: "WH" };

function stationRow(s) {
  const st = statusOf(s);
  const b = s.balance;
  const cls = st === "danger" || st === "error" ? "danger" : st === "warn" ? "warn" : "";
  const usedPct = b && b.ok && b.total > 0 ? Math.min(100, Math.round((b.used / b.total) * 100)) : 0;
  const amount = b && b.ok ? usd(b.remaining) : "—";
  let meta;
  if (b && b.ok) {
    const bits = [esc(typeLabel(s.type))];
    if (b.account) bits.push(esc(b.account));
    if (s.type === "sub2api-password" && s.tokenInfo?.expiresAt) {
      bits.push(`令牌自动续期（有效至 ${fmtClock(s.tokenInfo.expiresAt)}）`);
    }
    bits.push(relTime(b.checkedAt));
    if (b.latencyMs != null) bits.push(b.latencyMs + "ms");
    meta = bits.join(" · ");
  } else if (b && !b.ok) {
    meta = `${esc(typeLabel(s.type))} · <span style="color:var(--text-danger)">${esc(b.error || "查询失败")}</span>`;
  } else {
    meta = `${esc(typeLabel(s.type))} · 尚未查询`;
  }
  const bar = b && b.ok
    ? `<div class="st-bar"><div class="progress"><i class="${cls}" style="width:${usedPct}%"></i></div><span class="st-usage">已用 ${usd(b.used)} / ${usd(b.total)}</span></div>`
    : "";
  const eta = etaText(s.prediction);
  const pieces = [];
  if (b && b.ok && s.todayUsed != null) {
    pieces.push(`<span>今日消耗 ${s.todayIsEstimate ? "≈" : ""}${usd(s.todayUsed)}</span>`);
    if (s.todayTokens != null) pieces.push(`<span>${fmtTokens(s.todayTokens)} tokens</span>`);
  }
  if (eta) pieces.push(`<span class="${eta.cls}">${eta.text}</span>`);
  if (pieces.length) pieces.push("<span>点击查看趋势</span>");
  const predict = pieces.length ? `<div class="st-predict">${pieces.join("<span>·</span>")}</div>` : "";
  return `
  <div class="st-row" data-id="${s.id}">
    <div class="st-plate">${PLATE[s.type] || "?"}</div>
    <div class="st-main" data-act="trend" title="查看余额趋势">
      <div class="st-name">${esc(s.name)}${s.demo ? '<span class="demo-tag">演示</span>' : ""} ${statusPill(st)}</div>
      <div class="st-meta">${meta}</div>
      ${bar}
      ${predict}
    </div>
    <div class="st-balance">
      <div class="amt ${cls}">${amount}</div>
      <div class="sub">剩余余额</div>
    </div>
    <div class="st-actions">
      <button class="icon-btn" data-act="refresh" title="刷新"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>
      <button class="icon-btn" data-act="edit" title="编辑"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
      <button class="icon-btn" data-act="delete" title="删除"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
    </div>
  </div>`;
}

const HDR_BTNS = `
  <button class="btn btn-ghost" id="hdrRefresh"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>刷新</button>
  <button class="btn btn-primary" id="hdrAdd"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>添加中转站</button>`;

function renderDashboard() {
  const list = state.stations;
  const okList = list.filter((s) => s.balance?.ok);
  const totalRemaining = okList.reduce((a, s) => a + s.balance.remaining, 0);
  const totalUsed = okList.reduce((a, s) => a + s.balance.used, 0);
  const totalBurn = list.reduce((a, s) => a + (s.prediction?.burnPerDay || 0), 0);
  const todayTotal = list.reduce((a, s) => a + (s.todayUsed || 0), 0);
  // 任一站点的今日消耗是历史推算值时，合计也只能算约数
  const todayApprox = list.some((s) => (s.todayUsed || 0) > 0 && s.todayIsEstimate);
  const lowCount = list.filter((s) => ["warn", "danger"].includes(statusOf(s))).length;
  const errCount = list.filter((s) => statusOf(s) === "error").length;

  // 今日 tokens / 请求数：只有 sub2api 站点能提供，有数据才显示
  const tokList = list.filter((s) => s.todayTokens != null);
  const reqList = list.filter((s) => s.todayRequests != null);
  const subBits = [];
  if (tokList.length) subBits.push(`${fmtTokens(tokList.reduce((a, s) => a + s.todayTokens, 0))} tokens`);
  if (reqList.length) subBits.push(`${reqList.reduce((a, s) => a + s.todayRequests, 0).toLocaleString("en-US")} 次请求`);
  const todaySub = subBits.length ? `<div class="stat-sub">${subBits.join(" · ")}</div>` : "";

  $("#headerActions").innerHTML = HDR_BTNS;
  const stats = `
  <div class="stats stats-5">
    <div class="stat-card"><div class="label">总剩余余额</div><div class="value">${usd(totalRemaining)}</div></div>
    <div class="stat-card"><div class="label">今日总消耗</div><div class="value">${todayApprox ? "≈ " : ""}${usd(todayTotal)}</div>${todaySub}</div>
    <div class="stat-card"><div class="label">日均消耗（估算）</div><div class="value">${totalBurn > 0 ? usd(totalBurn) : "—"}</div></div>
    <div class="stat-card"><div class="label">低余额 / 耗尽</div><div class="value ${lowCount ? "warn" : ""}">${lowCount}<small>个</small></div></div>
    <div class="stat-card"><div class="label">查询异常</div><div class="value ${errCount ? "danger" : ""}">${errCount}<small>个</small></div></div>
  </div>`;
  const RANGES = [[24, "24 小时"], [72, "3 天"], [168, "7 天"], [720, "30 天"]];
  const charts = list.length ? `
  <div class="charts-grid">
    <div class="panel chart-card">
      <div class="chart-card-head">
        <div><h3>总余额趋势</h3><div class="chart-sub">全部中转站剩余余额合计</div></div>
        <div class="seg" id="ovRange">${RANGES.map(([h, l]) =>
          `<button data-hours="${h}" class="${state.trendHours === h ? "active" : ""}">${l}</button>`).join("")}</div>
      </div>
      <div class="chart-wrap" id="ovChart"><div class="chart-empty">加载中…</div></div>
    </div>
    <div class="panel chart-card">
      <div class="chart-card-head">
        <div><h3>日均消耗对比</h3><div class="chart-sub">按近 48 小时消耗速度回归估算（$/天）</div></div>
      </div>
      <div class="chart-wrap" id="burnChart"></div>
    </div>
  </div>` : "";
  const body = list.length
    ? `<div class="section-head"><h2>中转站余额</h2><span class="muted">共 ${list.length} 个 · 累计已用 ${usd(totalUsed)}</span></div>
       <div class="panel">${list.map(stationRow).join("")}</div>`
    : emptyState();
  $("#content").innerHTML = stats + charts + body;
  if (list.length) {
    drawBurnBars($("#burnChart"), list);
    mountOverviewChart();
  }
}

// ---- 总览图表 ---------------------------------------------------------------
// 缓存优先绘制，后台刷新后重绘，避免每次自动刷新都闪一次“加载中”
async function mountOverviewChart() {
  const hours = state.trendHours;
  const ov = state.overview;
  const el = $("#ovChart");
  if (!el) return;
  if (ov && ov.hours === hours) drawTotalChart(el, ov);
  if (ov && ov.hours === hours && Date.now() - ov.at < 30000) return;
  try {
    const r = await api.overview(hours);
    state.overview = { hours, series: r.series, at: Date.now() };
    const el2 = $("#ovChart");
    if (el2 && state.view === "dashboard" && state.trendHours === hours) drawTotalChart(el2, state.overview);
  } catch (e) {
    if (!(e instanceof AuthError) && !state.overview) el.innerHTML = `<div class="chart-empty">${esc(e.message)}</div>`;
  }
}

// 聚合全部站点：时间并集 + 各站前向填充求和
function drawTotalChart(wrap, ov) {
  const seriesList = ov.series.filter((s) => s.points && s.points.length);
  const times = [];
  for (const s of seriesList) for (const p of s.points) times.push(p[0]);
  times.sort((a, b) => a - b);
  const uniq = [];
  for (const t of times) if (!uniq.length || t - uniq[uniq.length - 1] > 30000) uniq.push(t);
  if (uniq.length < 2) {
    wrap.innerHTML = '<div class="chart-empty">数据积累中（需要至少两次成功查询）</div>';
    return;
  }
  const idx = seriesList.map(() => -1);
  const totals = [], breakdown = [];
  for (const t of uniq) {
    let sum = 0;
    const bd = [];
    seriesList.forEach((s, i) => {
      while (idx[i] + 1 < s.points.length && s.points[idx[i] + 1][0] <= t) idx[i]++;
      if (idx[i] >= 0) {
        const v = s.points[idx[i]][1];
        sum += v;
        bd.push([s.name, v]);
      }
    });
    totals.push([t, Math.round(sum * 100) / 100]);
    breakdown.push(bd);
  }

  const W = 560, H = 210, L = 52, R = 12, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const t0 = totals[0][0], t1 = totals[totals.length - 1][0];
  const maxV = Math.max(...totals.map((p) => p[1]), 0.01);
  const step = niceStep(maxV / 3);
  const yMax = Math.max(step * Math.ceil((maxV * 1.05) / step), step);
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * iw;
  const y = (v) => T + (1 - v / yMax) * ih;

  let grid = "", labels = "";
  for (let i = 0; i * step <= yMax + 1e-9; i++) {
    const v = +(i * step).toFixed(6);
    grid += `<line class="chart-grid" x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}"/>`;
    labels += `<text class="chart-axis-label" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">$${v >= 100 ? Math.round(v).toLocaleString("en-US") : v}</text>`;
  }
  for (const f of [0, 0.5, 1]) {
    const t = t0 + (t1 - t0) * f;
    labels += `<text class="chart-axis-label" x="${x(t)}" y="${H - 8}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${fmtClock(t)}</text>`;
  }

  const linePath = totals.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const areaPath = linePath + `L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="全部中转站总余额趋势">
      ${grid}${labels}
      <path class="chart-area" d="${areaPath}"/>
      <path class="chart-line" d="${linePath}"/>
      <line class="chart-crosshair" id="ovX" y1="${T}" y2="${T + ih}" visibility="hidden"/>
      <circle class="chart-hover-dot" id="ovDot" r="4" visibility="hidden"/>
      <rect id="ovOverlay" x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent"/>
    </svg>
    <div class="chart-tip" id="ovTip"></div>`;

  const svg = wrap.querySelector("svg");
  const overlay = wrap.querySelector("#ovOverlay");
  const cross = wrap.querySelector("#ovX");
  const dot = wrap.querySelector("#ovDot");
  const tip = wrap.querySelector("#ovTip");
  overlay.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const mt = t0 + ((mx - L) / iw) * (t1 - t0);
    let bi = 0;
    for (let i = 0; i < totals.length; i++) {
      if (Math.abs(totals[i][0] - mt) < Math.abs(totals[bi][0] - mt)) bi = i;
    }
    const [pt, pv] = totals[bi];
    const px = x(pt), py = y(pv);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px);
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py);
    dot.setAttribute("visibility", "visible");
    const bd = [...breakdown[bi]].sort((a, b) => b[1] - a[1]);
    const shown = bd.slice(0, 5);
    const rest = bd.slice(5);
    let rows = shown.map(([n, v]) => `<div class="r"><span>${esc(truncateLabel(n, 14))}</span><b>${usd(v)}</b></div>`).join("");
    if (rest.length) rows += `<div class="r"><span>其他 ${rest.length} 个</span><b>${usd(rest.reduce((a, x) => a + x[1], 0))}</b></div>`;
    tip.style.display = "block";
    tip.innerHTML = `<div class="t">${fmtClock(pt)}</div><div class="v">合计 ${usd(pv)}</div>${rows}`;
    const wrapRect = wrap.getBoundingClientRect();
    const tipX = (px / W) * wrapRect.width;
    tip.style.left = Math.min(Math.max(tipX + 12, 4), wrapRect.width - 150) + "px";
    tip.style.top = Math.max(4, (py / H) * wrapRect.height - 40) + "px";
  });
  overlay.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.style.display = "none";
  });
}

// 各站日均消耗横向条形图：单一色相（对比的是数值不是身份），条端直接标数值
function drawBurnBars(wrap, stations) {
  let items = stations
    .map((s) => ({ name: s.name, burn: s.prediction?.burnPerDay || 0, eta: s.prediction?.etaDays ?? null }))
    .filter((x) => x.burn > 0)
    .sort((a, b) => b.burn - a.burn);
  if (!items.length) {
    wrap.innerHTML = '<div class="chart-empty">暂无消耗数据（需要几次查询后才能估算）</div>';
    return;
  }
  if (items.length > 8) {
    const rest = items.slice(7);
    items = items.slice(0, 7);
    items.push({ name: `其他 ${rest.length} 个`, burn: Math.round(rest.reduce((a, x) => a + x.burn, 0) * 100) / 100, eta: null });
  }
  const W = 380, rowH = 32, T = 6, B = 6, nameW = 112, valW = 66;
  const barMax = W - nameW - valW - 12;
  const H = T + items.length * rowH + B;
  const max = Math.max(...items.map((x) => x.burn));
  const rows = items.map((x, i) => {
    const yTop = T + i * rowH + (rowH - 18) / 2;
    const w = Math.max(2, (x.burn / max) * barMax);
    const r = Math.min(4, w / 2); // 数据端 4px 圆角，基线端直角
    const bar = `M${nameW},${yTop} h${(w - r).toFixed(1)} a${r},${r} 0 0 1 ${r},${r} v${18 - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${(w - r).toFixed(1)} z`;
    return `<g data-i="${i}">
      <text class="bar-name" x="${nameW - 8}" y="${yTop + 13}" text-anchor="end">${esc(truncateLabel(x.name, 12))}</text>
      <path class="chart-bar" d="${bar}"/>
      <text class="bar-value" x="${nameW + w + 6}" y="${yTop + 13}">${usd(x.burn)}</text>
      <rect class="bar-hit" data-i="${i}" x="0" y="${T + i * rowH}" width="${W}" height="${rowH}" fill="transparent"/>
    </g>`;
  }).join("");
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="各站日均消耗对比">${rows}</svg><div class="chart-tip" id="burnTip"></div>`;

  const svg = wrap.querySelector("svg");
  const tip = wrap.querySelector("#burnTip");
  svg.addEventListener("mousemove", (e) => {
    const hit = e.target.closest("[data-i]");
    if (!hit) { tip.style.display = "none"; return; }
    const it = items[Number(hit.dataset.i)];
    tip.style.display = "block";
    tip.innerHTML = `<div class="t">${esc(it.name)}</div><div class="v">${usd(it.burn)}/天</div>` +
      (it.eta != null ? `<div class="t">预计 ${it.eta} 天后耗尽</div>` : "");
    const wrapRect = wrap.getBoundingClientRect();
    tip.style.left = Math.min(e.clientX - wrapRect.left + 14, wrapRect.width - 150) + "px";
    tip.style.top = Math.max(4, e.clientY - wrapRect.top - 40) + "px";
  });
  svg.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}

// CJK 按 2 个单位计宽的标签截断
function truncateLabel(s, units = 14) {
  let u = 0, out = "";
  for (const ch of String(s)) {
    u += /[⺀-꓏가-힣豈-﫿︰-﹏＀-￯]/.test(ch) ? 2 : 1;
    if (u > units) return out + "…";
    out += ch;
  }
  return s;
}

function renderStations() {
  $("#headerActions").innerHTML = HDR_BTNS;
  $("#content").innerHTML = state.stations.length
    ? `<div class="panel">${state.stations.map(stationRow).join("")}</div>`
    : emptyState();
}

function emptyState() {
  return `<div class="empty">
    <svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="6" rx="2"/><rect x="2" y="14" width="20" height="6" rx="2"/></svg>
    <h3>还没有中转站</h3>
    <p>点击右上角「添加中转站」，填入站点地址与凭证即可监控余额。</p>
  </div>`;
}

// ---- 通知页 -----------------------------------------------------------------
function channelRow(c) {
  const t = state.channelTypes.find((x) => x.value === c.type);
  return `
  <div class="st-row" data-chid="${c.id}">
    <div class="ch-plate">${CH_PLATE[c.type] || "?"}</div>
    <div class="st-main" style="cursor:default">
      <div class="st-name">${esc(c.name)}</div>
      <div class="st-meta">${esc(t?.label || c.type)}</div>
    </div>
    <button class="toggle ${c.enabled ? "on" : ""}" data-chact="toggle" title="启用/停用"></button>
    <div class="st-actions">
      <button class="icon-btn" data-chact="test" title="发送测试"><svg viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg></button>
      <button class="icon-btn" data-chact="edit" title="编辑"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
      <button class="icon-btn" data-chact="delete" title="删除"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
    </div>
  </div>`;
}

function renderNotify() {
  $("#headerActions").innerHTML = `
    <button class="btn btn-primary" id="hdrAddCh"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>添加渠道</button>`;
  const r = state.rules;
  const chBody = state.channels.length
    ? state.channels.map(channelRow).join("")
    : `<div class="empty" style="padding:34px 20px"><h3>还没有通知渠道</h3><p>添加 Telegram、钉钉、企业微信、飞书、Bark、ntfy、Server酱或自定义 Webhook。</p></div>`;
  const tg = (key, label, desc) => `
    <div class="set-row">
      <div><div class="set-title">${label}</div><div class="set-desc">${desc}</div></div>
      <button class="toggle ${r[key] ? "on" : ""}" data-rule="${key}"></button>
    </div>`;
  $("#content").innerHTML = `
    <div class="section-head"><h2>通知渠道</h2><span class="muted">告警将同时推送到所有启用的渠道</span></div>
    <div class="panel">${chBody}</div>
    <div class="section-head" style="margin-top:20px"><h2>告警规则</h2></div>
    <div class="panel settings-list rules-grid">
      ${tg("onLow", "余额偏低", "剩余余额低于阈值时通知")}
      ${tg("onExhaust", "余额耗尽", "剩余余额归零时通知")}
      ${tg("onError", "查询失败", "接口查询出错时通知（令牌失效、站点宕机等）")}
      ${tg("onRecover", "恢复正常", "从异常状态恢复后通知")}
      ${tg("onEta", "耗尽预警", "按消耗速度预计即将耗尽时通知")}
      <div class="set-row">
        <div><div class="set-title">耗尽预警阈值</div><div class="set-desc">预计在该时间内耗尽则触发「耗尽预警」，可按天或小时设置</div></div>
        <div class="field-inline">
          <input class="input small" id="rule-etaVal" value="${etaRuleDisplay(r)}">
          <select class="select small" id="rule-etaUnit">
            <option value="days"${r.etaUnit === "hours" ? "" : " selected"}>天</option>
            <option value="hours"${r.etaUnit === "hours" ? " selected" : ""}>小时</option>
          </select>
        </div>
      </div>
      <div class="set-row">
        <div><div class="set-title">重复提醒间隔</div><div class="set-desc">同一异常持续存在时，每隔 N 小时再次提醒（0 = 只提醒一次）</div></div>
        <div class="field-inline"><input class="input small" id="rule-renotify" value="${r.renotifyHours ?? 24}"><span class="set-desc">小时</span></div>
      </div>
      <div class="set-row">
        <div><div class="set-title">保存规则</div><div class="set-desc">应用阈值与间隔修改</div></div>
        <button class="btn btn-primary" id="rulesSave">保存</button>
      </div>
    </div>`;

  // 切换单位时把输入值换算过去（两个单位间必然是互换）
  $("#rule-etaUnit").onchange = () => {
    const inp = $("#rule-etaVal");
    const v = Number(inp.value);
    if (!Number.isFinite(v) || v <= 0) return;
    inp.value = $("#rule-etaUnit").value === "hours" ? +(v * 24).toFixed(2) : +(v / 24).toFixed(2);
  };
}

// 阈值内部按天存储；界面按所选单位展示
function etaRuleDisplay(r) {
  const days = Number(r.etaDays ?? 3);
  return r.etaUnit === "hours" ? +(days * 24).toFixed(2) : +days.toFixed(2);
}

// ---- 设置页 -----------------------------------------------------------------
function renderSettings() {
  $("#headerActions").innerHTML = "";
  const s = state.settings;
  $("#content").innerHTML = `
  <div class="panel settings-list">
    <div class="set-row">
      <div><div class="set-title">自动刷新间隔</div><div class="set-desc">后台按此间隔自动查询各中转站余额</div></div>
      <div class="field-inline"><input class="input small" id="set-interval" value="${s.refreshIntervalSec}"><span class="set-desc">秒</span></div>
    </div>
    <div class="set-row">
      <div><div class="set-title">全局低余额阈值</div><div class="set-desc">剩余余额低于此值时标记为「余额偏低」（可被单站阈值覆盖）</div></div>
      <div class="field-inline"><span class="set-desc">$</span><input class="input small" id="set-low" value="${s.lowBalanceUsd}"></div>
    </div>
    <div class="set-row">
      <div><div class="set-title">深色 / 浅色主题</div><div class="set-desc">跟随此开关切换界面主题</div></div>
      <button class="toggle ${root.getAttribute("data-theme") === "dark" ? "on" : ""}" id="set-theme"></button>
    </div>
    <div class="set-row">
      <div><div class="set-title">保存设置</div><div class="set-desc">应用刷新间隔与告警阈值</div></div>
      <button class="btn btn-primary" id="set-save">保存</button>
    </div>
  </div>
  <div class="section-head" style="margin-top:20px"><h2>面板账号</h2></div>
  <div class="panel settings-list">
    <div class="set-row" style="display:block">
      <div style="margin-bottom:10px"><div class="set-title">修改登录密码</div><div class="set-desc">当前用户：${esc(state.user || "admin")}，密码至少 6 位</div></div>
      <div class="pw-grid">
        <div class="form-field"><label>原密码</label><input class="input" id="pw-old" type="password"></div>
        <div class="form-field"><label>新密码</label><input class="input" id="pw-new" type="password"></div>
        <button class="btn btn-primary" id="pw-save" style="height:34px">修改</button>
      </div>
    </div>
    <div class="set-row">
      <div><div class="set-title">退出登录</div><div class="set-desc">清除本机会话</div></div>
      <button class="btn btn-ghost" id="set-logout">退出</button>
    </div>
  </div>
  <div class="section-head" style="margin-top:20px"><h2>关于</h2></div>
  <div class="panel"><div class="st-row"><div class="st-main" style="cursor:default">
    <div class="st-name">中转站余额监控${state.app ? ` <span class="demo-tag">v${esc(state.app.version)}${state.app.commit ? " · " + esc(state.app.commit) : ""}</span>` : ""}</div>
    <div class="st-meta">支持 New API（访问令牌 / sk 密钥）与 Sub2API（登录令牌 / 账号密码自动续期）。界面基于 app-shell-ui 设计语言构建。凭证仅存储于本机 data/ 目录。</div>
  </div></div></div>`;

  $("#set-theme").onclick = () => applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
  $("#set-save").onclick = async () => {
    const r = await api.saveSettings({
      refreshIntervalSec: Number($("#set-interval").value),
      lowBalanceUsd: Number($("#set-low").value),
    });
    state.settings = r.settings;
    startAuto();
    toast("设置已保存");
    render();
  };
  $("#pw-save").onclick = async () => {
    try {
      await api.changePassword({ oldPassword: $("#pw-old").value, newPassword: $("#pw-new").value });
      $("#pw-old").value = ""; $("#pw-new").value = "";
      toast("密码已修改");
    } catch (e) { toast(e.message, "err"); }
  };
  $("#set-logout").onclick = () => $("#logoutBtn").click();
}

function render() {
  const titles = {
    dashboard: ["总览", "跨中转站的余额与用量一览"],
    stations: ["中转站", "管理你的 sub2api / new-api 中转站"],
    notify: ["通知", "告警渠道与触发规则"],
    settings: ["设置", "刷新策略、告警阈值与面板账号"],
  };
  $("#pageTitle").textContent = titles[state.view][0];
  $("#pageSub").textContent = titles[state.view][1];
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === state.view));
  if (state.view === "dashboard") renderDashboard();
  else if (state.view === "stations") renderStations();
  else if (state.view === "notify") renderNotify();
  else renderSettings();
  const ver = state.app ? `v${state.app.version}${state.app.commit ? ` (${state.app.commit})` : ""}` : "";
  $("#lastSync").innerHTML = `自动刷新：每 ${state.settings.refreshIntervalSec} 秒${ver ? `<br>${esc(ver)}` : ""}`;
}

// ---- 中转站弹窗 --------------------------------------------------------------
let editingId = null;
function openModal(station) {
  editingId = station?.id || null;
  $("#modalTitle").textContent = station ? "编辑中转站" : "添加中转站";
  const sel = $("#f-type");
  sel.innerHTML = state.types.map((t) => `<option value="${t.value}">${esc(t.label)}</option>`).join("");
  $("#f-name").value = station?.name || "";
  sel.value = station?.type || state.types[0].value;
  $("#f-baseUrl").value = station?.baseUrl || "";
  $("#f-accessToken").value = "";
  $("#f-userId").value = station?.userId || "";
  $("#f-apiKey").value = "";
  $("#f-email").value = station?.email || "";
  $("#f-password").value = "";
  $("#f-lowBalance").value = station?.lowBalanceUsd ?? "";
  if (station) {
    $("#f-accessToken").placeholder = station.hasAccessToken ? "已配置，留空保持不变" : "令牌 / JWT";
    $("#f-apiKey").placeholder = station.hasApiKey ? "已配置，留空保持不变" : "sk-...";
    $("#f-password").placeholder = station.hasPassword ? "已配置，留空保持不变" : "站点的登录密码";
  } else {
    $("#f-accessToken").placeholder = "令牌 / JWT";
    $("#f-apiKey").placeholder = "sk-...";
    $("#f-password").placeholder = "站点的登录密码";
  }
  syncCredFields();
  $("#modal").classList.add("open");
}
function closeModal() { $("#modal").classList.remove("open"); editingId = null; }

function syncCredFields() {
  const type = $("#f-type").value;
  const t = state.types.find((x) => x.value === type);
  const needs = t?.needs || [];
  document.querySelectorAll("#modal [data-cred]").forEach((el) => {
    el.style.display = needs.includes(el.dataset.cred) ? "" : "none";
  });
  const hints = {
    newapi: "New API 后台「个人设置」的系统访问令牌 + 用户 ID；地址填站点根地址。",
    "newapi-key": "任意可用的 sk- 密钥；通过 OpenAI 兼容计费接口查询额度。",
    sub2api: "Sub2API 登录后的访问令牌（JWT）；过期需手动更换，推荐用账号密码模式。",
    "sub2api-password": "填 Sub2API 的登录邮箱和密码，面板会自动登录并在令牌过期时自动续期。开启 2FA 的账号不支持。",
  };
  $("#f-type-hint").textContent = hints[type] || "";
  $("#l-accessToken").textContent = type.startsWith("sub2api") ? "登录令牌（JWT）" : "访问令牌";
}
$("#f-type").onchange = syncCredFields;

$("#modalSave").onclick = async () => {
  const payload = {
    name: $("#f-name").value.trim(),
    type: $("#f-type").value,
    baseUrl: $("#f-baseUrl").value.trim(),
    userId: $("#f-userId").value.trim(),
    email: $("#f-email").value.trim(),
    lowBalanceUsd: $("#f-lowBalance").value.trim(),
  };
  const at = $("#f-accessToken").value.trim();
  const ak = $("#f-apiKey").value.trim();
  const pw = $("#f-password").value;
  if (at) payload.accessToken = at;
  if (ak) payload.apiKey = ak;
  if (pw) payload.password = pw;
  if (!payload.baseUrl) return toast("请填写站点地址", "err");
  try {
    if (editingId) { await api.update(editingId, payload); toast("已更新"); }
    else { await api.create(payload); toast("已添加，正在查询余额…"); }
    closeModal();
    setTimeout(reload, 800);
    await reload();
  } catch (e) { toast(e.message || "保存失败", "err"); }
};
$("#modalCancel").onclick = closeModal;

// 点击遮罩关闭：要求 mousedown 也发生在遮罩上——
// 从输入框选中文本拖到遮罩再松手时，click 目标会是遮罩，不加判断会误关弹窗丢表单
function backdropClose(id, close) {
  const el = document.getElementById(id);
  let downOnBackdrop = false;
  el.addEventListener("mousedown", (e) => { downOnBackdrop = e.target === el; });
  el.addEventListener("click", (e) => { if (downOnBackdrop && e.target === el) close(); });
}
backdropClose("modal", closeModal);

// ---- 通知渠道弹窗 -------------------------------------------------------------
let editingChId = null;
function openChModal(channel) {
  editingChId = channel?.id || null;
  $("#chModalTitle").textContent = channel ? "编辑通知渠道" : "添加通知渠道";
  const sel = $("#ch-type");
  sel.innerHTML = state.channelTypes.map((t) => `<option value="${t.value}">${esc(t.label)}</option>`).join("");
  sel.value = channel?.type || state.channelTypes[0].value;
  sel.disabled = !!channel;
  $("#ch-name").value = channel?.name || "";
  renderChFields(channel);
  $("#chModal").classList.add("open");
}
function closeChModal() { $("#chModal").classList.remove("open"); editingChId = null; }

function renderChFields(channel) {
  const type = $("#ch-type").value;
  const t = state.channelTypes.find((x) => x.value === type);
  $("#ch-fields").innerHTML = (t?.fields || []).map((f) => `
    <div class="form-field">
      <label>${esc(f.label)}${f.required ? "" : ""}</label>
      <input class="input" data-cfg="${f.key}" value="${esc(channel?.config?.[f.key] || "")}" ${f.required ? "" : ""} />
    </div>`).join("");
}
$("#ch-type").onchange = () => renderChFields(null);

function chFormPayload() {
  const config = {};
  document.querySelectorAll("#ch-fields [data-cfg]").forEach((el) => { config[el.dataset.cfg] = el.value.trim(); });
  return { name: $("#ch-name").value.trim() || "未命名渠道", type: $("#ch-type").value, config };
}
$("#chSave").onclick = async () => {
  const p = chFormPayload();
  const t = state.channelTypes.find((x) => x.value === p.type);
  const missing = (t?.fields || []).filter((f) => f.required && !p.config[f.key]);
  if (missing.length) return toast(`请填写：${missing.map((f) => f.label).join("、")}`, "err");
  try {
    if (editingChId) await api.updateChannel(editingChId, p);
    else await api.addChannel(p);
    closeChModal();
    await loadNotifications();
    render();
    toast("已保存");
  } catch (e) { toast(e.message, "err"); }
};
$("#chTest").onclick = async () => {
  const p = chFormPayload();
  $("#chTest").disabled = true;
  try {
    const r = await api.testChannel({ type: p.type, config: p.config });
    toast(r.ok ? "测试消息已发送" : `发送失败：${r.error}`, r.ok ? "ok" : "err");
  } catch (e) { toast(e.message, "err"); }
  finally { $("#chTest").disabled = false; }
};
$("#chCancel").onclick = closeChModal;
backdropClose("chModal", closeChModal);

// ---- 趋势弹窗 -----------------------------------------------------------------
let trendSeq = 0; // 丢弃过期响应：快速切换站点时慢的那次不能覆盖后打开的图
async function openTrend(station) {
  const seq = ++trendSeq;
  $("#trendTitle").textContent = `余额趋势 · ${station.name}`;
  $("#trendModal").classList.add("open");
  $("#trendChart").innerHTML = '<div class="chart-empty">加载中…</div>';
  $("#trendStats").innerHTML = "";
  try {
    const { points, prediction } = await api.historyOf(station.id, 72);
    if (seq !== trendSeq) return;
    const b = station.balance;
    const eta = etaText(prediction);
    $("#trendStats").innerHTML = `
      <div class="stat-card"><div class="label">当前余额</div><div class="value">${b?.ok ? usd(b.remaining) : "—"}</div></div>
      <div class="stat-card"><div class="label">今日消耗</div><div class="value">${station.todayUsed != null ? (station.todayIsEstimate ? "≈ " : "") + usd(station.todayUsed) : "—"}</div>${
        station.todayTokens != null || station.todayRequests != null
          ? `<div class="stat-sub">${[
              station.todayTokens != null ? fmtTokens(station.todayTokens) + " tokens" : null,
              station.todayRequests != null ? station.todayRequests.toLocaleString("en-US") + " 次" : null,
            ].filter(Boolean).join(" · ")}</div>` : ""
      }</div>
      <div class="stat-card"><div class="label">日均消耗（估算）</div><div class="value">${prediction?.burnPerDay > 0 ? usd(prediction.burnPerDay) : "—"}</div></div>
      <div class="stat-card"><div class="label">预计耗尽</div><div class="value ${eta?.cls || ""}">${prediction?.etaDays != null ? fmtEtaText(prediction.etaDays) : "—"}</div></div>`;
    drawChart($("#trendChart"), points, prediction);
  } catch (e) {
    if (seq !== trendSeq) return;
    $("#trendChart").innerHTML = `<div class="chart-empty">${esc(e.message)}</div>`;
  }
}
$("#trendClose").onclick = () => $("#trendModal").classList.remove("open");
backdropClose("trendModal", () => $("#trendModal").classList.remove("open"));

function niceStep(rough) {
  const pow = Math.pow(10, Math.floor(Math.log10(rough || 1)));
  const r = rough / pow;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * pow;
}

// SVG 折线图：历史余额 + 虚线耗尽投影 + 悬停十字线
function drawChart(wrap, points, prediction) {
  wrap.innerHTML = "";
  if (!points || points.length < 2) {
    wrap.innerHTML = '<div class="chart-empty">数据点不足（需要至少两次成功查询），稍后再来看看</div>';
    return;
  }
  const W = 640, H = 240, L = 48, R = 16, T = 14, B = 28;
  const iw = W - L - R, ih = H - T - B;
  const t0 = points[0][0];
  const lastT = points[points.length - 1][0];
  const lastR = points[points.length - 1][1];
  let t1 = lastT;

  // 投影段：最多延伸一个历史窗口的长度，避免把历史压扁
  let proj = null;
  if (prediction && prediction.burnPerDay > 0 && prediction.etaDays != null) {
    const etaMs = new Date(prediction.etaAt).getTime();
    const cap = lastT + Math.max(lastT - t0, 3600000);
    if (etaMs <= cap) proj = { t: etaMs, r: 0, hitsZero: true };
    else {
      const rAtCap = Math.max(lastR - prediction.burnPerDay * ((cap - lastT) / 86400000), 0);
      proj = { t: cap, r: rAtCap, hitsZero: false };
    }
    t1 = proj.t;
  }

  const maxR = Math.max(...points.map((p) => p[1]), 0.01);
  const step = niceStep(maxR / 3);
  const yMax = Math.max(step * Math.ceil((maxR * 1.05) / step), step);
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * iw;
  const y = (r) => T + (1 - r / yMax) * ih;

  let grid = "", labels = "";
  for (let i = 0; i * step <= yMax + 1e-9; i++) {
    const v = +(i * step).toFixed(6); // 消除浮点累加误差，避免 $0.30000000000000004 这类刻度
    grid += `<line class="chart-grid" x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}"/>`;
    labels += `<text class="chart-axis-label" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">$${v >= 100 ? Math.round(v) : v}</text>`;
  }
  // x 轴 3 个刻度
  for (const f of [0, 0.5, 1]) {
    const t = t0 + (t1 - t0) * f;
    labels += `<text class="chart-axis-label" x="${x(t)}" y="${H - 8}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${fmtClock(t)}</text>`;
  }

  const linePath = points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const areaPath = linePath + `L${x(lastT).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;

  let projSvg = "";
  if (proj) {
    projSvg = `<path class="chart-proj" d="M${x(lastT).toFixed(1)},${y(lastR).toFixed(1)}L${x(proj.t).toFixed(1)},${y(proj.r).toFixed(1)}"/>`;
    if (proj.hitsZero) {
      const zx = x(proj.t), anchor = zx > W - 120 ? "end" : "start";
      projSvg += `<circle class="chart-zero-dot" cx="${zx}" cy="${y(0)}" r="4"/>
        <text class="chart-zero-label" x="${zx + (anchor === "end" ? -8 : 8)}" y="${y(0) - 8}" text-anchor="${anchor}">预计耗尽 ${fmtClock(proj.t)}</text>`;
    }
  }

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="余额历史折线图">
      ${grid}${labels}
      <path class="chart-area" d="${areaPath}"/>
      <path class="chart-line" d="${linePath}"/>
      ${projSvg}
      <line class="chart-crosshair" id="chX" y1="${T}" y2="${T + ih}" visibility="hidden"/>
      <circle class="chart-hover-dot" id="chDot" r="4" visibility="hidden"/>
      <rect id="chOverlay" x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent"/>
    </svg>
    <div class="chart-tip" id="chTip"></div>`;

  const svg = wrap.querySelector("svg");
  const overlay = wrap.querySelector("#chOverlay");
  const cross = wrap.querySelector("#chX");
  const dot = wrap.querySelector("#chDot");
  const tip = wrap.querySelector("#chTip");
  overlay.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const mt = t0 + ((mx - L) / iw) * (t1 - t0);
    let best = points[0];
    for (const p of points) if (Math.abs(p[0] - mt) < Math.abs(best[0] - mt)) best = p;
    const px = x(best[0]), py = y(best[1]);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px);
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py);
    dot.setAttribute("visibility", "visible");
    tip.style.display = "block";
    tip.innerHTML = `<div class="t">${fmtClock(best[0])}</div><div class="v">${usd(best[1])}</div>`;
    const wrapRect = wrap.getBoundingClientRect();
    const tipX = (px / W) * wrapRect.width;
    tip.style.left = Math.min(Math.max(tipX + 10, 4), wrapRect.width - 110) + "px";
    tip.style.top = Math.max(4, (py / H) * wrapRect.height - 44) + "px";
  });
  overlay.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.style.display = "none";
  });
}

// ---- 事件委托 --------------------------------------------------------------
document.querySelectorAll(".nav-item").forEach((n) => (n.onclick = () => { state.view = n.dataset.view; render(); }));

$(".main").addEventListener("click", async (e) => {
  if (e.target.closest("#hdrAdd")) return openModal(null);
  if (e.target.closest("#hdrAddCh")) return openChModal(null);
  const hdrRefresh = e.target.closest("#hdrRefresh");
  if (hdrRefresh) return doRefreshAll(hdrRefresh);

  // 总览趋势图时间范围切换（旧图保留到新数据画好，避免闪空）
  const rangeBtn = e.target.closest("#ovRange [data-hours]");
  if (rangeBtn) {
    state.trendHours = Number(rangeBtn.dataset.hours);
    document.querySelectorAll("#ovRange button").forEach((b) => b.classList.toggle("active", b === rangeBtn));
    mountOverviewChart();
    return;
  }

  // 规则开关 / 保存
  const ruleToggle = e.target.closest("[data-rule]");
  if (ruleToggle) {
    const key = ruleToggle.dataset.rule;
    try {
      const r = await api.saveRules({ [key]: !state.rules[key] });
      state.rules = r.rules;
      ruleToggle.classList.toggle("on", state.rules[key]);
    } catch (err) { toast(err.message, "err"); }
    return;
  }
  if (e.target.closest("#rulesSave")) {
    try {
      const unit = $("#rule-etaUnit").value;
      const val = Number($("#rule-etaVal").value);
      const r = await api.saveRules({
        etaDays: unit === "hours" ? val / 24 : val, // 内部统一按天
        etaUnit: unit,
        renotifyHours: Number($("#rule-renotify").value),
      });
      state.rules = r.rules;
      // 回显服务端钳制后的值（如非法输入被忽略、下限 1 小时），不然界面显示的是没生效的输入
      $("#rule-etaVal").value = etaRuleDisplay(state.rules);
      $("#rule-renotify").value = state.rules.renotifyHours;
      toast("规则已保存");
    } catch (err) { toast(err.message, "err"); }
    return;
  }

  // 渠道操作
  const chBtn = e.target.closest("[data-chact]");
  if (chBtn) {
    const id = chBtn.closest("[data-chid]")?.dataset.chid;
    const ch = state.channels.find((c) => c.id === id);
    if (!ch) return;
    const act = chBtn.dataset.chact;
    if (act === "toggle") {
      try {
        await api.updateChannel(id, { enabled: !ch.enabled });
        ch.enabled = !ch.enabled;
        chBtn.classList.toggle("on", ch.enabled);
      } catch (err) { toast(err.message, "err"); }
    } else if (act === "test") {
      chBtn.classList.add("spin");
      try {
        const r = await api.testChannel({ channelId: id });
        toast(r.ok ? `已发送到「${ch.name}」` : `发送失败：${r.error}`, r.ok ? "ok" : "err");
      } catch (err) { toast(err.message, "err"); }
      finally { chBtn.classList.remove("spin"); }
    } else if (act === "edit") {
      openChModal(ch);
    } else if (act === "delete") {
      if (!confirm(`确定删除渠道「${ch.name}」？`)) return;
      try {
        await api.removeChannel(id);
        await loadNotifications();
        render();
        toast("已删除");
      } catch (err) { if (!(err instanceof AuthError)) toast(err.message, "err"); }
    }
    return;
  }

  // 中转站操作
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const row = btn.closest(".st-row");
  const id = row?.dataset.id;
  const station = state.stations.find((s) => s.id === id);
  if (!station) return;
  const act = btn.dataset.act;
  if (act === "trend") {
    openTrend(station);
  } else if (act === "refresh") {
    btn.classList.add("spin");
    try {
      const r = await api.refreshOne(id);
      station.balance = r.balance;
      if (r.station) Object.assign(station, r.station);
      render();
      if (!r.balance.ok) toast(station.name + "：" + (r.balance.error || "查询失败"), "err");
    } catch (err) { if (!(err instanceof AuthError)) toast(err.message, "err"); }
    finally { btn.classList.remove("spin"); }
  } else if (act === "edit") {
    openModal(station);
  } else if (act === "delete") {
    if (!confirm(`确定删除「${station.name}」？`)) return;
    try {
      await api.remove(id);
      toast("已删除");
      await reload();
    } catch (err) { if (!(err instanceof AuthError)) toast(err.message, "err"); }
  }
});

$("#refreshBtn").onclick = (e) => doRefreshAll(e.currentTarget);

// 设置/通知页上有未保存的表单输入，重绘会把它们清空——
// 后台数据更新只在这两个数据视图上触发重绘
const isDataView = () => state.view === "dashboard" || state.view === "stations";

async function doRefreshAll(btn) {
  btn?.classList.add("spin");
  try {
    const r = await api.refreshAll();
    state.stations = r.stations;
    if (isDataView()) render();
    toast("已刷新全部");
  } catch (err) { if (!(err instanceof AuthError)) toast("刷新失败", "err"); }
  finally { btn?.classList.remove("spin"); }
}

// ---- 数据加载与自动刷新 ----------------------------------------------------
async function reload() {
  const r = await api.list();
  state.stations = r.stations;
  state.settings = r.settings;
  render();
}
async function loadNotifications() {
  const r = await api.notifications();
  state.channels = r.channels;
  state.rules = r.rules;
  state.channelTypes = r.channelTypes;
}
function startAuto() {
  if (autoTimer) clearInterval(autoTimer);
  const sec = Math.max(10, state.settings.refreshIntervalSec || 60);
  autoTimer = setInterval(() => { if (isDataView()) reload().catch(() => {}); }, sec * 1000);
}

async function bootData() {
  const meta = await api.meta();
  state.types = meta.types;
  state.channelTypes = meta.channelTypes;
  state.settings = meta.settings;
  state.rules = meta.rules;
  state.app = meta.app || null;
  await Promise.all([reload(), loadNotifications()]);
  render();
  startAuto();
}

(async function boot() {
  try {
    const me = await call("/api/auth/me");
    state.user = me.username;
    if (me.isDefaultPassword) toast("当前为默认密码 admin123，建议到「设置」中修改", "err");
    await bootData();
  } catch (e) {
    if (!(e instanceof AuthError)) console.error(e);
    // 401 已由 call() 弹出登录屏
  }
})();
