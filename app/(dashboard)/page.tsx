"use client";
// 总览页：5 张 KPI + 总余额趋势图 + 今日消耗对比 + 中转站余额列表
// 功能与口径逐条对照 v1 app.js：renderDashboard / drawTotalChart / drawBurnBars / stationRow
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import { App, Button, Col, Empty, Row, Segmented, Spin, Tag, Tooltip, theme } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { Line, Bar } from "@ant-design/plots";
import { api, cny, usd, rateOf, fmtTokens, fmtEta, statusOf } from "../../lib/client";
import { useThemeMode } from "../providers";

// ---- v1 工具函数平移（app.js 同名实现，行为逐字对齐）------------------------

// 站点类型徽标缩写（app.js PLATE）
const PLATE: Record<string, string> = { newapi: "NA", "newapi-key": "KEY", sub2api: "S2", "sub2api-password": "S2" };

// 相对时间（app.js relTime）
function relTime(iso: string | null | undefined): string {
  if (!iso) return "从未";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.max(0, Math.floor(d))} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  return `${Math.floor(d / 3600)} 小时前`;
}

// 月/日 时:分（app.js fmtClock）
function fmtClock(ts: number | string | Date): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 预测文案（app.js etaText）：≈¥/天 + 预计耗尽；阈值内标红/橙
function etaText(p: any, rate: number, rules: any): { text: string; cls: string } | null {
  if (!p) return null;
  if (p.burnPerDay === 0) return { text: `${p.basis || "近期"}无消耗`, cls: "" };
  if (p.etaDays == null) return null;
  const cls = p.etaDays <= (rules?.etaDays ?? 3) ? "danger" : p.etaDays <= 7 ? "warn" : "";
  return { text: `≈ ${cny(p.burnPerDay * rate)}/天（${p.basis || "估算"}）· 预计 ${fmtEta(p.etaDays)}后耗尽`, cls };
}

// CJK 按 2 个单位计宽的标签截断（app.js truncateLabel）
function truncateLabel(s: any, units = 14): string {
  let u = 0, out = "";
  for (const ch of String(s)) {
    u += /[⺀-꓏가-힣豈-﫿︰-﹏＀-￯]/.test(ch) ? 2 : 1;
    if (u > units) return out + "…";
    out += ch;
  }
  return String(s);
}

// 颜色语义（对应 v1 css 的 warn/danger 文本色）：antd 色板值，两种主题下都可读
const C_DANGER = "#ff4d4f";
const C_WARN = "#faad14";
const clsColor = (cls: string) => (cls === "danger" ? C_DANGER : cls === "warn" ? C_WARN : undefined);

// 状态徽标（app.js statusPill）
function StatusPill({ st }: { st: string }) {
  const map: Record<string, [string, string]> = {
    ok: ["green", "正常"], warn: ["orange", "余额偏低"], danger: ["red", "已耗尽"],
    error: ["red", "查询失败"], pending: ["default", "待刷新"],
  };
  const [color, txt] = map[st] || map.pending;
  return <Tag color={color} style={{ marginInlineStart: 8 }}>{txt}</Tag>;
}

// 站点卡片里的迷你余额走势（app.js sparkSvg 平移为 JSX）：陡降 = 消耗快，平线 = 闲置，跳升 = 充值
function SparkSvg({ pts }: { pts: [number, number][] | null }) {
  const { token } = theme.useToken();
  if (!pts || pts.length < 2) return null;
  const W = 170, H = 30, P = 3;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  let min = Infinity, max = -Infinity;
  for (const [, v] of pts) { if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 1e-9) { min -= 1; max += 1; } // 余额没变化时画一条居中的平线
  const x = (t: number) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = (v: number) => P + (1 - (v - min) / (max - min)) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const area = `${line}L${x(t1).toFixed(1)},${H - P}L${x(t0).toFixed(1)},${H - P}Z`;
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={170} height={30} aria-hidden="true" style={{ display: "block" }}>
      <path d={area} fill={token.colorPrimaryBg} />
      <path d={line} fill="none" stroke={token.colorPrimary} strokeWidth={1.5} />
      <circle cx={x(last[0]).toFixed(1)} cy={y(last[1]).toFixed(1)} r={2.5} fill={token.colorPrimary} />
    </svg>
  );
}

// KPI 卡片（对应 v1 stat-card：label + value + 可选副行）
function StatCard({ label, value, valueColor, sub }: { label: string; value: React.ReactNode; valueColor?: string; sub?: React.ReactNode }) {
  const { token } = theme.useToken();
  return (
    <ProCard>
      <div style={{ fontSize: 13, color: token.colorTextSecondary }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.4, color: valueColor }}>{value}</div>
      {sub ? <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>{sub}</div> : null}
    </ProCard>
  );
}

// 图表占位（对应 v1 .chart-empty）
function ChartEmpty({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center", color: token.colorTextSecondary, fontSize: 13 }}>
      {text}
    </div>
  );
}

// 趋势图范围选项（app.js RANGES）
const RANGES = [
  { label: "24 小时", value: 24 },
  { label: "3 天", value: 72 },
  { label: "7 天", value: 168 },
  { label: "30 天", value: 720 },
];

export default function OverviewPage() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const { dark } = useThemeMode();
  const [stations, setStations] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({ refreshIntervalSec: 60, lowBalanceUsd: 5 });
  const [types, setTypes] = useState<any[]>([]);
  const [rules, setRules] = useState<any>({});
  const [loaded, setLoaded] = useState(false);
  const [trendHours, setTrendHours] = useState(24);
  // 总览趋势数据缓存 {hours, series}（对应 v1 state.overview）
  const [overview, setOverview] = useState<{ hours: number; series: any[] } | null>(null);
  const [overviewErr, setOverviewErr] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const hoursRef = useRef(trendHours);
  hoursRef.current = trendHours;

  const typeLabel = useCallback((v: string) => types.find((t) => t.value === v)?.label || v, [types]);

  // 拉站点列表（对应 v1 reload）
  const reload = useCallback(async () => {
    try {
      const r = await api("/api/stations");
      setStations(r.stations);
      setSettings(r.settings);
      setLoaded(true);
    } catch {
      /* 401 已由 api() 跳登录，其余错误静默等下轮 */
    }
  }, []);

  // 拉总览趋势（对应 v1 mountOverviewChart 的数据部分）
  const loadOverview = useCallback(async (hours: number) => {
    try {
      const r = await api(`/api/history/overview?hours=${hours}`);
      // 范围已被用户切走则丢弃过期响应
      if (hoursRef.current === hours) {
        setOverview({ hours, series: r.series });
        setOverviewErr(null);
      }
    } catch (e: any) {
      if (hoursRef.current === hours) setOverviewErr(e.message || "加载失败");
    }
  }, []);

  // 首次加载元信息（类型标签 + 通知规则阈值，供 etaText 用）
  useEffect(() => {
    api("/api/meta")
      .then((m) => { setTypes(m.types); setRules(m.rules); setSettings(m.settings); })
      .catch(() => {});
  }, []);

  // 30s 轮询列表 + 趋势；切回标签页立即刷新一次（同 v1 visibilitychange）
  useEffect(() => {
    const tick = () => { reload(); loadOverview(hoursRef.current); };
    tick();
    const timer = setInterval(tick, 30000);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [reload, loadOverview]);

  // 切换范围立即重新拉取（缓存范围一致时先展示旧图，避免闪“加载中”）
  useEffect(() => { loadOverview(trendHours); }, [trendHours, loadOverview]);

  // 单站刷新（对应 stationRow 的刷新按钮）
  const refreshOne = async (id: string) => {
    setRefreshingId(id);
    try {
      await api(`/api/stations/${id}/refresh`, { method: "POST", body: {} });
      await reload();
    } catch (e: any) {
      message.error(e.message || "刷新失败");
    } finally {
      setRefreshingId(null);
    }
  };

  // ---- 聚合统计（renderDashboard 逐行平移）---------------------------------
  // 聚合统计只算上游：标记「我的站点」的余额是自家 root 账号额度，混进来会污染数字
  const ups = useMemo(() => stations.filter((s) => !s.isOwn), [stations]);
  const agg = useMemo(() => {
    const okList = ups.filter((s) => s.balance?.ok);
    const anyRate = ups.some((s) => rateOf(s) !== 1);
    const totalRemaining = okList.reduce((a, s) => a + s.balance.remaining, 0);
    const totalRemainingCny = okList.reduce((a, s) => a + s.balance.remaining * rateOf(s), 0);
    const totalUsedCny = okList.reduce((a, s) => a + s.balance.used * rateOf(s), 0);
    const totalBurnCny = ups.reduce((a, s) => a + (s.prediction?.burnPerDay || 0) * rateOf(s), 0);
    const todayTotalCny = ups.reduce((a, s) => a + (s.todayUsed || 0) * rateOf(s), 0);
    // 任一站点的今日消耗是历史推算值时，合计也只能算约数
    const todayApprox = ups.some((s) => (s.todayUsed || 0) > 0 && s.todayIsEstimate);
    const lowCount = ups.filter((s) => ["warn", "danger"].includes(statusOf(s, settings))).length;
    const errCount = ups.filter((s) => statusOf(s, settings) === "error").length;
    // 今日 tokens / 请求数：只有 sub2api 站点能提供，有数据才显示
    const tokList = ups.filter((s) => s.todayTokens != null);
    const reqList = ups.filter((s) => s.todayRequests != null);
    const subBits: string[] = [];
    if (tokList.length) subBits.push(`${fmtTokens(tokList.reduce((a, s) => a + s.todayTokens, 0))} tokens`);
    if (reqList.length) subBits.push(`${reqList.reduce((a, s) => a + s.todayRequests, 0).toLocaleString("en-US")} 次请求`);
    return { anyRate, totalRemaining, totalRemainingCny, totalUsedCny, totalBurnCny, todayTotalCny, todayApprox, lowCount, errCount, subBits };
  }, [ups, settings]);

  // ---- 总余额趋势数据（drawTotalChart 的聚合部分平移）------------------------
  // 聚合上游站点：时间并集 + 各站前向填充求和（按各站充值汇率折算成 ¥，不含我的站点）
  const trend = useMemo(() => {
    if (!overview) return null;
    const rateMap = new Map(stations.map((s) => [s.id, rateOf(s)]));
    const ownIds = new Set(stations.filter((s) => s.isOwn).map((s) => s.id));
    const seriesList = overview.series
      .filter((s) => s.points && s.points.length && !ownIds.has(s.id))
      .map((s) => ({ ...s, rate: rateMap.get(s.id) ?? 1 }));
    const times: number[] = [];
    for (const s of seriesList) for (const p of s.points) times.push(p[0]);
    times.sort((a, b) => a - b);
    const uniq: number[] = [];
    for (const t of times) if (!uniq.length || t - uniq[uniq.length - 1] > 30000) uniq.push(t);
    if (uniq.length < 2) return { data: [], breakdown: new Map() };
    const idx = seriesList.map(() => -1);
    const data: { tms: number; date: Date; v: number }[] = [];
    const breakdown = new Map<number, [string, number][]>();
    for (const t of uniq) {
      let sum = 0;
      const bd: [string, number][] = [];
      seriesList.forEach((s, i) => {
        while (idx[i] + 1 < s.points.length && s.points[idx[i] + 1][0] <= t) idx[i]++;
        if (idx[i] >= 0) {
          const v = s.points[idx[i]][1] * s.rate;
          sum += v;
          bd.push([s.name, v]);
        }
      });
      data.push({ tms: t, date: new Date(t), v: Math.round(sum * 100) / 100 });
      breakdown.set(t, bd);
    }
    return { data, breakdown };
  }, [overview, stations]);

  // ---- 今日消耗对比数据（drawBurnBars 的数据部分平移）------------------------
  // 数值取当日实际扣费 todayUsed（真实数据），非预测——todayIsEstimate 为历史推算，tooltip 标 ≈
  const burnItems = useMemo(() => {
    let items = ups
      .map((s) => ({
        name: s.name,
        burn: (s.todayUsed || 0) * rateOf(s),
        est: !!s.todayIsEstimate,
        eta: s.prediction?.etaDays ?? null,
      }))
      .filter((x) => x.burn > 0)
      .sort((a, b) => b.burn - a.burn);
    if (items.length > 8) {
      const rest = items.slice(7);
      items = items.slice(0, 7);
      items.push({
        name: `其他 ${rest.length} 个`,
        burn: Math.round(rest.reduce((a, x) => a + x.burn, 0) * 100) / 100,
        est: rest.some((x) => x.est),
        eta: null,
      });
    }
    return items;
  }, [ups]);

  // ---- 单站行（stationRow 平移）--------------------------------------------
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 14, padding: "14px 4px", borderBottom: `1px solid ${token.colorBorderSecondary}` };
  const plateStyle: React.CSSProperties = {
    width: 40, height: 40, borderRadius: 10, flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
    background: token.colorPrimaryBg, color: token.colorPrimary, fontWeight: 700, fontSize: 12,
  };

  function renderStationRow(s: any) {
    // 固定成本渠道：不访问接口，展示当前生效各笔的摊销汇总
    if (s.type === "fixed") {
      const ps: any[] = Array.isArray(s.fixedPurchases) ? s.fixedPurchases : [];
      const nowMs = Date.now();
      let daily = 0, active = 0, pendingStart = 0, nextEnd: number | null = null;
      for (const p of ps) {
        const d = p.amount > 0 && p.days > 0 ? p.amount / p.days : 0;
        if (!p.startDate) { daily += d; active++; continue; }
        const st = Date.parse(p.startDate + "T00:00:00");
        const end = st + p.days * 86400000;
        if (st > nowMs) { pendingStart++; continue; }
        if (end > nowMs) {
          daily += d; active++;
          if (nextEnd == null || end < nextEnd) nextEnd = end;
        }
      }
      const expiredAll = ps.length > 0 && active === 0 && pendingStart === 0;
      const pieces: React.ReactNode[] = [
        <span key="d">日均摊销 {cny(daily)}</span>,
        <span key="a">生效 {active}/{ps.length} 笔</span>,
      ];
      if (pendingStart) pieces.push(<span key="p">待生效 {pendingStart} 笔</span>);
      if (nextEnd != null) {
        const remain = Math.ceil((nextEnd - nowMs) / 86400000);
        pieces.push(
          <span key="n" style={{ color: remain <= 3 ? C_WARN : undefined }}>
            最近一笔 {fmtClock(nextEnd).split(" ")[0]} 到期（剩 {remain} 天）
          </span>
        );
      }
      if (expiredAll) pieces.push(<span key="e" style={{ color: C_DANGER }}>已全部到期，续费请追加付费记录</span>);
      return (
        <div key={s.id} style={rowStyle}>
          <div style={plateStyle}>¥</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>
              {s.name}
              <Tag style={{ marginInlineStart: 8 }}>固定成本</Tag>
            </div>
            <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>
              {s.baseUrl ? `${s.baseUrl} · ` : ""}不访问接口 · 仅计入利润成本
            </div>
            <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 4, display: "flex", flexWrap: "wrap", gap: "0 6px" }}>
              {pieces.reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, <span key={`sep${i}`}>·</span>, el] : [el]), [])}
            </div>
          </div>
          <div style={{ textAlign: "right", flex: "none" }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: expiredAll ? C_DANGER : undefined }}>{cny(daily)}</div>
            <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{expiredAll ? "已到期" : "每天"}</div>
          </div>
        </div>
      );
    }

    const st = statusOf(s, settings);
    const b = s.balance;
    const rate = rateOf(s);
    const amtColor = st === "danger" || st === "error" ? C_DANGER : st === "warn" ? C_WARN : undefined;
    const amount = b && b.ok ? cny(b.remaining * rate) : "—";
    // 副信息行：类型 · 账号 · 令牌续期 · 查询时间 · 延迟；失败时红字错误
    let meta: React.ReactNode;
    if (b && b.ok) {
      const bits = [typeLabel(s.type)];
      if (b.account) bits.push(b.account);
      if (s.type === "sub2api-password" && s.tokenInfo?.expiresAt) {
        bits.push(`令牌自动续期（有效至 ${fmtClock(s.tokenInfo.expiresAt)}）`);
      }
      bits.push(relTime(b.checkedAt));
      if (b.latencyMs != null) bits.push(b.latencyMs + "ms");
      meta = bits.join(" · ");
    } else if (b && !b.ok) {
      meta = (
        <>
          {typeLabel(s.type)} · <span style={{ color: C_DANGER }}>{b.error || "查询失败"}</span>
        </>
      );
    } else {
      meta = `${typeLabel(s.type)} · 尚未查询`;
    }
    const eta = etaText(s.prediction, rate, rules);
    const pieces: React.ReactNode[] = [];
    if (b && b.ok && s.todayUsed != null) {
      pieces.push(<span key="t">今日消耗 {s.todayIsEstimate ? "≈" : ""}{cny(s.todayUsed * rate)}</span>);
      if (s.todayTokens != null) pieces.push(<span key="k">{fmtTokens(s.todayTokens)} tokens</span>);
    }
    if (eta) pieces.push(<span key="e" style={{ color: clsColor(eta.cls) }}>{eta.text}</span>);
    return (
      <div key={s.id} style={rowStyle}>
        <div style={plateStyle}>{PLATE[s.type] || "?"}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, display: "flex", alignItems: "center", flexWrap: "wrap" }}>
            {s.name}
            {s.isOwn ? <Tag style={{ marginInlineStart: 8 }}>我的站</Tag> : null}
            {s.demo ? <Tag style={{ marginInlineStart: 8 }}>演示</Tag> : null}
            <StatusPill st={st} />
          </div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>{meta}</div>
          {b && b.ok && s.spark && s.spark.length >= 2 ? (
            <Tooltip title="近 48 小时余额走势">
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                <SparkSvg pts={s.spark} />
                <span style={{ fontSize: 12, color: token.colorTextSecondary }}>近 48h 余额</span>
              </div>
            </Tooltip>
          ) : null}
          {pieces.length ? (
            <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 4, display: "flex", flexWrap: "wrap", gap: "0 6px" }}>
              {pieces.reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, <span key={`sep${i}`}>·</span>, el] : [el]), [])}
            </div>
          ) : null}
        </div>
        <div style={{ textAlign: "right", flex: "none" }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: amtColor }}>{amount}</div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
            {b && b.ok && rate !== 1 ? `站点余额 ${usd(b.remaining)}` : "剩余余额"}
          </div>
        </div>
        <div style={{ flex: "none" }}>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            loading={refreshingId === s.id}
            onClick={() => refreshOne(s.id)}
            title="刷新"
          />
        </div>
      </div>
    );
  }

  // ---- 图表 ------------------------------------------------------------------
  // 总余额趋势：折线 + 自定义 tooltip（时间点各站分解，前 5 名 + 其他合并，同 v1）
  const lineConfig = trend && trend.data.length >= 2 ? {
    data: trend.data,
    xField: "date",
    yField: "v",
    height: 260,
    theme: dark ? "classicDark" : "classic",
    style: { stroke: token.colorPrimary, lineWidth: 2 },
    axis: {
      x: { labelFormatter: (d: Date) => fmtClock(d), grid: false },
      y: { labelFormatter: (v: number) => `¥${v >= 100 ? Math.round(v).toLocaleString("en-US") : v}` },
    },
    scale: { y: { nice: true, domainMin: 0 } },
    tooltip: {
      title: (d: any) => String(d.tms),
      items: [{ channel: "y" }],
    },
    interaction: {
      tooltip: {
        render: (_e: any, { title }: any) => {
          const tms = Number(title);
          const bd = [...(trend.breakdown.get(tms) || [])].sort((a, b) => b[1] - a[1]);
          const total = bd.reduce((a, x) => a + x[1], 0);
          const shown = bd.slice(0, 5);
          const rest = bd.slice(5);
          let rows = shown
            .map(([n, v]) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${truncateLabel(n, 14)}</span><b>${cny(v)}</b></div>`)
            .join("");
          if (rest.length) {
            rows += `<div style="display:flex;justify-content:space-between;gap:16px"><span>其他 ${rest.length} 个</span><b>${cny(rest.reduce((a, x) => a + x[1], 0))}</b></div>`;
          }
          return `<div style="padding:4px 2px;font-size:12px"><div style="color:${token.colorTextSecondary}">${fmtClock(tms)}</div><div style="font-weight:600;margin:2px 0">合计 ${cny(Math.round(total * 100) / 100)}</div>${rows}</div>`;
        },
      },
    },
    animate: false,
  } : null;

  // 今日消耗对比：横向条形（plots Bar，对齐 v1 drawBurnBars），条端标数值，tooltip 含历史推算标记与预计耗尽天数
  const barConfig = burnItems.length ? {
    data: burnItems,
    xField: "name",
    yField: "burn",
    height: Math.max(200, burnItems.length * 40 + 40),
    theme: dark ? "classicDark" : "classic",
    // 单一色相：对比的是数值不是身份（同 v1 drawBurnBars 注释）
    style: { fill: token.colorPrimary, radiusTopRight: 4, radiusBottomRight: 4 },
    label: {
      // 条端金额标注；历史推算站加 ≈ 前缀（同 v1）
      text: (d: any) => `${d.est ? "≈ " : ""}${cny(d.burn)}`,
      position: "right" as const,
      dx: 4,
      style: { fontSize: 11, fill: token.colorTextSecondary },
    },
    axis: {
      x: { labelFormatter: (n: string) => truncateLabel(n, 12), title: false },
      y: false as const,
    },
    legend: false as const,
    tooltip: {
      title: (d: any) => d.name,
      items: [{ channel: "y" }],
    },
    interaction: {
      tooltip: {
        render: (_e: any, { title }: any) => {
          const it = burnItems.find((x) => x.name === title);
          if (!it) return "";
          const etaLine = it.eta != null ? `<div style="color:${token.colorTextSecondary}">预计 ${it.eta} 天后耗尽</div>` : "";
          return `<div style="padding:4px 2px;font-size:12px"><div style="color:${token.colorTextSecondary}">${it.name}${it.est ? " · 历史推算" : ""}</div><div style="font-weight:600;margin:2px 0">${it.est ? "≈ " : ""}${cny(it.burn)}</div>${etaLine}</div>`;
        },
      },
    },
    animate: false,
  } : null;

  if (!loaded) {
    return (
      <PageContainer title="总览">
        <div style={{ display: "flex", justifyContent: "center", padding: 80 }}><Spin /></div>
      </PageContainer>
    );
  }

  return (
    <PageContainer title="总览">
      {/* 5 张 KPI（renderDashboard stats 区，口径逐项一致） */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 16 }}>
        <StatCard
          label="总剩余余额"
          value={cny(agg.totalRemainingCny)}
          sub={agg.anyRate ? `站点余额合计 ${usd(agg.totalRemaining)}` : undefined}
        />
        <StatCard
          label="今日总消耗"
          value={`${agg.todayApprox ? "≈ " : ""}${cny(agg.todayTotalCny)}`}
          sub={agg.subBits.length ? agg.subBits.join(" · ") : undefined}
        />
        <StatCard label="日均消耗（估算）" value={agg.totalBurnCny > 0 ? cny(agg.totalBurnCny) : "—"} />
        <StatCard
          label="低余额 / 耗尽"
          value={<>{agg.lowCount}<small style={{ fontSize: 14, marginInlineStart: 2 }}>个</small></>}
          valueColor={agg.lowCount ? C_WARN : undefined}
        />
        <StatCard
          label="查询异常"
          value={<>{agg.errCount}<small style={{ fontSize: 14, marginInlineStart: 2 }}>个</small></>}
          valueColor={agg.errCount ? C_DANGER : undefined}
        />
      </div>

      {/* 图表区：仅有站点时展示（同 v1 charts 条件）；窄屏降为单列（xs=24 lg 分栏） */}
      {stations.length ? (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} lg={14}>
            <ProCard
              // 标题不换行不收缩，避免 ~800px 时被 extra 挤成竖排；副标题允许换行
              title={<span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>总余额趋势</span>}
              subTitle={<span style={{ whiteSpace: "normal" }}>上游站点剩余余额合计（按充值汇率折算 ¥，不含我的站点）</span>}
              extra={
                <Segmented
                  size="small"
                  value={trendHours}
                  options={RANGES}
                  onChange={(v) => setTrendHours(v as number)}
                />
              }
            >
              {!overview && !overviewErr ? (
                <ChartEmpty text="加载中…" />
              ) : overviewErr && !overview ? (
                <ChartEmpty text={overviewErr} />
              ) : lineConfig ? (
                <Line {...(lineConfig as any)} />
              ) : (
                <ChartEmpty text="数据积累中（需要至少两次成功查询）" />
              )}
            </ProCard>
          </Col>
          <Col xs={24} lg={10}>
            <ProCard
              title={<span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>今日消耗对比</span>}
              subTitle={<span style={{ whiteSpace: "normal" }}>各站当日 0 点至今实际扣费（¥）</span>}
            >
              {barConfig ? <Bar {...(barConfig as any)} /> : <ChartEmpty text="今日暂无消耗" />}
            </ProCard>
          </Col>
        </Row>
      ) : null}

      {/* 中转站余额列表（stationRow 全字段） */}
      {stations.length ? (
        <ProCard
          title={<span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>中转站余额</span>}
          subTitle={`共 ${stations.length} 个 · 累计已用 ${cny(agg.totalUsedCny)}`}
          style={{ marginTop: 16 }}
        >
          <div>{stations.map(renderStationRow)}</div>
        </ProCard>
      ) : (
        <ProCard style={{ marginTop: 16 }}>
          <Empty
            description={
              <>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有中转站</div>
                <div style={{ color: token.colorTextSecondary }}>到「中转站」页面添加站点，填入站点地址与凭证即可监控余额。</div>
              </>
            }
          />
        </ProCard>
      )}
    </PageContainer>
  );
}
