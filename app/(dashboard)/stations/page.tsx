"use client";
// 中转站管理页：站点列表 + 添加/编辑弹窗 + 单站刷新/删除 + 余额趋势详情弹窗
// 功能对照 v1 app.js：renderStations/stationRow（553-586、193-288）、站点表单弹窗（1487-1614）、
// 趋势弹窗 openTrend/drawChart（1675-1822）——文案与数字口径逐条对齐，布局用 Pro 风格重排
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import {
  App,
  Button,
  Checkbox,
  Col,
  DatePicker,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Tag,
  theme,
} from "antd";
import {
  PlusOutlined,
  ReloadOutlined,
  EditOutlined,
  DeleteOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import { Line } from "@ant-design/plots";
import ChartBox from "../chart-box";
import LastRefreshed from "../last-refreshed";
import dayjs from "dayjs";
import { api, cny, usd, rateOf, fmtTokens, fmtEta, statusOf } from "../../../lib/client";
import { useThemeMode } from "../../providers";

// ---- 展示工具（v1 app.js 同名函数平移）--------------------------------------
const PLATE: Record<string, string> = { newapi: "NA", "newapi-key": "KEY", sub2api: "S2", "sub2api-password": "S2" };
// 语义色（antd 色板值，两种主题下都可读）；中性色一律走 token
const COLOR = { warn: "#faad14", danger: "#ff4d4f" };

function relTime(iso: any) {
  if (!iso) return "从未";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.max(0, Math.floor(d))} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  return `${Math.floor(d / 3600)} 小时前`;
}
function fmtClock(ts: any) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 耗尽预测文案：≈ ¥x/天（依据）· 预计 N 天后耗尽；阈值内标红、7 天内标黄（同 v1 etaText）
function etaText(p: any, rate: number, etaDaysRule: number): { text: string; cls: "" | "warn" | "danger" } | null {
  if (!p) return null;
  if (p.burnPerDay === 0) return { text: `${p.basis || "近期"}无消耗`, cls: "" };
  if (p.etaDays == null) return null;
  const cls = p.etaDays <= etaDaysRule ? "danger" : p.etaDays <= 7 ? "warn" : "";
  return { text: `≈ ${cny(p.burnPerDay * rate)}/天（${p.basis || "估算"}）· 预计 ${fmtEta(p.etaDays)}后耗尽`, cls };
}
// 状态徽标（v1 statusPill）：文案一致，样式换 antd Tag
function statusPill(st: string) {
  const map: Record<string, [string, string]> = {
    ok: ["success", "正常"],
    warn: ["warning", "余额偏低"],
    danger: ["error", "已耗尽"],
    error: ["error", "查询失败"],
    pending: ["default", "待刷新"],
  };
  const [color, txt] = map[st] || map.pending;
  return <Tag color={color} style={{ marginInlineStart: 6 }}>{txt}</Tag>;
}

// 表单类型提示（v1 syncCredFields 的 hints，逐字平移）
const TYPE_HINTS: Record<string, string> = {
  newapi: "New API 后台「个人设置」的系统访问令牌 + 用户 ID；地址填站点根地址。",
  "newapi-key": "任意可用的 sk- 密钥；通过 OpenAI 兼容计费接口查询额度。",
  sub2api: "Sub2API 登录后的访问令牌（JWT）；过期需手动更换，推荐用账号密码模式。",
  "sub2api-password": "填 Sub2API 的登录邮箱和密码，面板会自动登录并在令牌过期时自动续期。开启 2FA 的账号不支持。",
  fixed: "包月 / 包年等定期投入的上游：不访问任何接口，只按天摊销计入利润成本。",
};

const hintStyle = (token: ReturnType<typeof theme.useToken>["token"]): React.CSSProperties => ({
  fontSize: 12,
  color: token.colorTextSecondary,
  marginTop: 4,
  lineHeight: 1.6,
});

// ---- 迷你余额走势（近 48 小时，v1 sparkSvg 的 plots 版）-----------------------
function Spark({ pts }: { pts: any[] }) {
  const { dark } = useThemeMode();
  const data = useMemo(() => (pts || []).map((p: any) => ({ date: new Date(p[0]), v: p[1] })), [pts]);
  if (!pts || pts.length < 2) return null;
  return (
    <div style={{ width: 170, maxWidth: "100%", height: 30, overflow: "hidden" }}>
      <Line
        data={data}
        xField="date"
        yField="v"
        width={170}
        height={30}
        axis={false}
        legend={false}
        tooltip={false}
        animate={false}
        padding={3}
        theme={dark ? "classicDark" : "classic"}
        style={{ lineWidth: 1.5 }}
      />
    </div>
  );
}

// ---- 详情弹窗的余额走势图（v1 drawChart 平移：历史实线 + 虚线耗尽投影）---------
function TrendChart({ points, prediction }: { points: any[]; prediction: any }) {
  const { dark } = useThemeMode();
  const { token } = theme.useToken();
  const cfg = useMemo(() => {
    if (!points || points.length < 2) return null;
    const t0 = points[0][0];
    const lastT = points[points.length - 1][0];
    const lastR = points[points.length - 1][1];
    // 投影段：最多延伸一个历史窗口的长度，避免把历史压扁（同 v1）
    let proj: { t: number; r: number; hitsZero: boolean } | null = null;
    if (prediction && prediction.burnPerDay > 0 && prediction.etaDays != null) {
      const etaMs = new Date(prediction.etaAt).getTime();
      const cap = lastT + Math.max(lastT - t0, 3600000);
      if (etaMs <= cap) proj = { t: etaMs, r: 0, hitsZero: true };
      else proj = { t: cap, r: Math.max(lastR - prediction.burnPerDay * ((cap - lastT) / 86400000), 0), hitsZero: false };
    }
    const data = [
      ...points.map((p: any) => ({ date: new Date(p[0]), v: p[1], s: "余额" })),
      ...(proj
        ? [
            { date: new Date(lastT), v: lastR, s: "预测" },
            { date: new Date(proj.t), v: proj.r, s: "预测" },
          ]
        : []),
    ];
    return {
      data,
      xField: "date",
      yField: "v",
      colorField: "s",
      height: 280,
      animate: false,
      theme: dark ? "classicDark" : "classic",
      scale: { color: { range: ["#1677ff", "#faad14"] }, y: { domainMin: 0, nice: true } },
      // 预测段画虚线（G2 折线的 style 回调收到的是该分组的数据数组）
      style: { lineWidth: 2, lineDash: (d: any[]) => (d[0]?.s === "预测" ? [5, 5] : null) },
      axis: {
        x: { labelFormatter: (d: any) => fmtClock(d) },
        y: { labelFormatter: (v: any) => `¥${v >= 100 ? Math.round(v) : v}` },
      },
      legend: proj ? undefined : false,
      tooltip: {
        title: (d: any) => fmtClock(d.date),
        items: [{ channel: "y", valueFormatter: (v: any) => cny(v) }],
      },
      // 耗尽点：投影落到 0 时标红点 + 「预计耗尽」时间
      annotations: proj?.hitsZero
        ? [
            {
              type: "point",
              data: [{ date: new Date(proj.t), v: 0 }],
              encode: { x: "date", y: "v" },
              style: { fill: COLOR.danger, r: 4 },
              tooltip: false,
            },
            {
              type: "text",
              data: [{ date: new Date(proj.t), v: 0 }],
              encode: { x: "date", y: "v" },
              style: { text: `预计耗尽 ${fmtClock(proj.t)}`, dy: -10, dx: -6, textAlign: "end", fill: COLOR.danger, fontSize: 12 },
              tooltip: false,
            },
          ]
        : [],
    } as any;
  }, [points, prediction, dark]);

  if (!cfg)
    return (
      <div style={{ height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: token.colorTextSecondary }}>
        数据点不足（需要至少两次成功查询），稍后再来看看
      </div>
    );
  return (
    <ChartBox h={280}>
      <Line {...cfg} />
    </ChartBox>
  );
}

// ---- 单行站点（v1 stationRow 平移）-------------------------------------------
function StationRow(props: {
  s: any;
  settings: any;
  types: any[];
  etaDaysRule: number;
  refreshing: boolean;
  onTrend: (s: any) => void;
  onRefresh: (s: any) => void;
  onEdit: (s: any) => void;
  onDelete: (s: any) => void;
}) {
  const { s, settings, types, etaDaysRule, refreshing, onTrend, onRefresh, onEdit, onDelete } = props;
  const { token } = theme.useToken();
  const typeLabel = (v: string) => types.find((t) => t.value === v)?.label || v;
  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap", // 窄屏时金额/操作按钮换行，避免横向溢出
    gap: 14,
    rowGap: 8,
    padding: "14px 4px",
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
  };
  const plateStyle: React.CSSProperties = {
    width: 44,
    height: 44,
    borderRadius: 10,
    background: token.colorPrimaryBg,
    color: token.colorPrimary,
    fontWeight: 700,
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
  const mutedStyle: React.CSSProperties = { color: token.colorTextSecondary };
  const sep = <span style={{ margin: "0 6px", ...mutedStyle }}>·</span>;

  // 固定成本渠道：不访问接口，展示当前生效各笔的摊销汇总
  if (s.type === "fixed") {
    const ps = Array.isArray(s.fixedPurchases) ? s.fixedPurchases : [];
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
        <span key="n" style={remain <= 3 ? { color: COLOR.warn } : undefined}>
          最近一笔 {fmtClock(nextEnd).split(" ")[0]} 到期（剩 {remain} 天）
        </span>
      );
    }
    if (expiredAll) pieces.push(<span key="e" style={{ color: COLOR.danger }}>已全部到期，续费请追加付费记录</span>);
    return (
      <div style={rowStyle}>
        <div style={plateStyle}>¥</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            {s.name}<Tag style={{ marginInlineStart: 6 }}>固定成本</Tag>
          </div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>
            {s.baseUrl ? `${s.baseUrl} · ` : ""}不访问接口 · 仅计入利润成本
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            {pieces.map((p, i) => (<span key={i}>{i ? sep : null}{p}</span>))}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: expiredAll ? COLOR.danger : undefined }}>{cny(daily)}</div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{expiredAll ? "已到期" : "每天"}</div>
        </div>
        <Space size={2} style={{ flexShrink: 0 }}>
          <Button type="text" icon={<EditOutlined />} title="编辑" onClick={() => onEdit(s)} />
          <Button type="text" danger icon={<DeleteOutlined />} title="删除" onClick={() => onDelete(s)} />
        </Space>
      </div>
    );
  }

  const st = statusOf(s, settings);
  const b = s.balance;
  const rate = rateOf(s);
  const amtColor = st === "danger" || st === "error" ? COLOR.danger : st === "warn" ? COLOR.warn : undefined;
  const amount = b && b.ok ? cny(b.remaining * rate) : "—";
  // 副标题行：类型 · 账号 · 令牌续期 · 上次查询 · 延迟（同 v1 meta 拼接顺序）
  let meta: React.ReactNode;
  if (b && b.ok) {
    const bits: string[] = [typeLabel(s.type)];
    if (b.account) bits.push(b.account);
    if (s.type === "sub2api-password" && s.tokenInfo?.expiresAt) {
      bits.push(`令牌自动续期（有效至 ${fmtClock(s.tokenInfo.expiresAt)}）`);
    }
    bits.push(relTime(b.checkedAt));
    if (b.latencyMs != null) bits.push(b.latencyMs + "ms");
    meta = bits.join(" · ");
  } else if (b && !b.ok) {
    meta = (<>{typeLabel(s.type)} · <span style={{ color: COLOR.danger }}>{b.error || "查询失败"}</span></>);
  } else {
    meta = `${typeLabel(s.type)} · 尚未查询`;
  }
  const eta = etaText(s.prediction, rate, etaDaysRule);
  const pieces: React.ReactNode[] = [];
  if (b && b.ok && s.todayUsed != null) {
    pieces.push(<span key="t">今日消耗 {s.todayIsEstimate ? "≈" : ""}{cny(s.todayUsed * rate)}</span>);
    if (s.todayTokens != null) pieces.push(<span key="k">{fmtTokens(s.todayTokens)} tokens</span>);
  }
  if (eta) {
    pieces.push(
      <span key="e" style={eta.cls ? { color: eta.cls === "danger" ? COLOR.danger : COLOR.warn } : undefined}>
        {eta.text}
      </span>
    );
  }
  if (pieces.length) pieces.push(<span key="c" style={{ color: token.colorTextSecondary }}>点击查看趋势</span>);

  return (
    <div style={rowStyle}>
      <div style={plateStyle}>{PLATE[s.type] || "?"}</div>
      <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} title="查看余额趋势" onClick={() => onTrend(s)}>
        <div style={{ fontWeight: 600 }}>
          {s.name}
          {s.isOwn ? <Tag color="blue" style={{ marginInlineStart: 6 }}>我的站</Tag> : null}
          {s.demo ? <Tag style={{ marginInlineStart: 6 }}>演示</Tag> : null}
          {statusPill(st)}
        </div>
        <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>{meta}</div>
        {b && b.ok && s.spark && s.spark.length > 1 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }} title="近 48 小时余额走势">
            <Spark pts={s.spark} />
            <span style={{ fontSize: 12, color: token.colorTextSecondary, whiteSpace: "nowrap", flexShrink: 0 }}>近 48h 余额</span>
          </div>
        ) : null}
        {pieces.length ? (
          <div style={{ fontSize: 12, marginTop: 4 }}>
            {pieces.map((p, i) => (<span key={i}>{i ? sep : null}{p}</span>))}
          </div>
        ) : null}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: amtColor }}>{amount}</div>
        <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
          {b && b.ok && rate !== 1 ? `站点余额 ${usd(b.remaining)}` : "剩余余额"}
        </div>
      </div>
      <Space size={2} style={{ flexShrink: 0 }}>
        <Button type="text" icon={<ReloadOutlined />} title="刷新" loading={refreshing} onClick={() => onRefresh(s)} />
        <Button type="text" icon={<EditOutlined />} title="编辑" onClick={() => onEdit(s)} />
        <Button type="text" danger icon={<DeleteOutlined />} title="删除" onClick={() => onDelete(s)} />
      </Space>
    </div>
  );
}

// ---- 页面 --------------------------------------------------------------------
const RANGES = [
  { label: "24 小时", value: 24 },
  { label: "3 天", value: 72 },
  { label: "7 天", value: 168 },
  { label: "30 天", value: 720 },
];

export default function StationsPage() {
  const { message, modal } = App.useApp();
  const { token } = theme.useToken();
  const hint = hintStyle(token);
  const [form] = Form.useForm();

  const [stations, setStations] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({ refreshIntervalSec: 60, lowBalanceUsd: 5 });
  const [types, setTypes] = useState<any[]>([]);
  const [rules, setRules] = useState<any>({});
  const [loaded, setLoaded] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<Record<string, boolean>>({});
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  // 添加/编辑弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null); // null = 新增
  const [saving, setSaving] = useState(false);
  const [purchases, setPurchases] = useState<any[]>([]); // 固定成本付费记录行
  const formType = Form.useWatch("type", form);

  // 趋势详情弹窗
  const [trendStation, setTrendStation] = useState<any>(null);
  const [trendHours, setTrendHours] = useState(72);
  const [trendData, setTrendData] = useState<any>(null);
  const [trendErr, setTrendErr] = useState("");
  const [trendLoading, setTrendLoading] = useState(false);
  const trendSeq = useRef(0); // 丢弃过期响应：快速切换站点/范围时慢的那次不能覆盖后打开的图

  // 列表加载（GET /api/stations 同时带回全局设置，同 v1 reload）
  const reload = useCallback(async () => {
    const r = await api("/api/stations");
    setStations(r.stations);
    setSettings(r.settings);
    setLoaded(true);
    setRefreshedAt(Date.now());
  }, []);

  useEffect(() => {
    reload().catch(() => {});
    api("/api/meta")
      .then((m) => { setTypes(m.types); setRules(m.rules); })
      .catch(() => {});
  }, [reload]);

  // 自动刷新：跟随全局设置的刷新间隔（同 v1 startAuto，下限 10 秒）
  useEffect(() => {
    const sec = Math.max(10, Number(settings.refreshIntervalSec) || 60);
    const t = setInterval(() => { reload().catch(() => {}); }, sec * 1000);
    return () => clearInterval(t);
  }, [settings.refreshIntervalSec, reload]);

  // 手动全量刷新（v1 doRefreshAll）
  const onRefreshAll = async () => {
    setRefreshingAll(true);
    try {
      const r = await api("/api/refresh", { method: "POST", body: {} });
      setStations(r.stations);
      message.success("已刷新全部");
    } catch {
      message.error("刷新失败");
    } finally {
      setRefreshingAll(false);
    }
  };

  // 单站刷新（v1 data-act="refresh"）
  const onRefreshOne = async (s: any) => {
    setRefreshingIds((m) => ({ ...m, [s.id]: true }));
    try {
      const r = await api(`/api/stations/${s.id}/refresh`, { method: "POST", body: {} });
      setStations((list) => list.map((x) => (x.id === s.id ? { ...x, ...(r.station || {}), balance: r.balance } : x)));
      if (!r.balance.ok) message.error(s.name + "：" + (r.balance.error || "查询失败"));
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setRefreshingIds((m) => ({ ...m, [s.id]: false }));
    }
  };

  // 删除（v1 data-act="delete"：confirm 文案一致）
  const onDelete = (s: any) => {
    modal.confirm({
      title: `确定删除「${s.name}」？`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api(`/api/stations/${s.id}`, { method: "DELETE" });
          message.success("已删除");
          await reload();
        } catch (e: any) {
          message.error(e.message);
        }
      },
    });
  };

  // ---- 添加/编辑弹窗（v1 openModal/modalSave 平移）---------------------------
  const openModal = (station: any) => {
    setEditing(station || null);
    form.setFieldsValue({
      name: station?.name || "",
      type: station?.type || types[0]?.value,
      baseUrl: station?.baseUrl || "",
      accessToken: "",
      userId: station?.userId || "",
      apiKey: "",
      email: station?.email || "",
      password: "",
      lowBalanceUsd: station?.lowBalanceUsd ?? "",
      cnyPerUsd: station?.cnyPerUsd ?? "",
      isOwn: !!station?.isOwn,
    });
    // 付费记录：无记录时默认给一行、起始日期今天（同 v1 seedPurchaseRows）
    const list = station?.fixedPurchases;
    setPurchases(list && list.length ? list.map((p: any) => ({ ...p })) : [{ startDate: dayjs().format("YYYY-MM-DD") }]);
    setModalOpen(true);
  };

  // 编辑时密钥不回显：placeholder 提示「已配置，留空保持不变」（同 v1）
  const credPlaceholder = (configured: boolean, fallback: string) =>
    editing ? (configured ? "已配置，留空保持不变" : fallback) : fallback;

  const onSave = async () => {
    const v = form.getFieldsValue();
    const payload: any = {
      name: String(v.name || "").trim(),
      type: v.type,
      baseUrl: String(v.baseUrl || "").trim(),
      userId: String(v.userId ?? "").trim(),
      email: String(v.email || "").trim(),
      lowBalanceUsd: String(v.lowBalanceUsd ?? "").trim(),
      cnyPerUsd: String(v.cnyPerUsd ?? "").trim(),
      // 金额/天数保持字符串提交（同 v1 collectPurchases），全空行剔除
      fixedPurchases: purchases
        .map((p) => ({
          amount: String(p.amount ?? "").trim(),
          days: String(p.days ?? "").trim(),
          startDate: p.startDate || "",
        }))
        .filter((p) => p.amount !== "" || p.days !== ""),
      isOwn: v.type === "newapi" && !!v.isOwn,
    };
    const at = String(v.accessToken || "").trim();
    const ak = String(v.apiKey || "").trim();
    const pw = v.password || "";
    if (at) payload.accessToken = at;
    if (ak) payload.apiKey = ak;
    if (pw) payload.password = pw;
    if (payload.type === "fixed") {
      const bad = payload.fixedPurchases.find((p: any) => !(Number(p.amount) > 0) || !(Number(p.days) > 0));
      if (bad) return message.error("每笔付费需填写金额与天数（均大于 0）");
      if (!payload.fixedPurchases.length) return message.error("请至少填写一笔付费记录");
    } else if (!payload.baseUrl) {
      return message.error("请填写站点地址");
    }
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/stations/${editing.id}`, { method: "PUT", body: payload });
        message.success("已更新");
      } else {
        await api("/api/stations", { method: "POST", body: payload });
        message.success("已添加，正在查询余额…");
      }
      setModalOpen(false);
      setTimeout(() => reload().catch(() => {}), 800); // 新增后台正在首查，稍后再拉一次拿到余额
      await reload();
    } catch (e: any) {
      message.error(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // ---- 趋势详情弹窗（v1 openTrend 平移，外加范围切换）-------------------------
  const openTrend = (s: any) => {
    setTrendStation(s);
    setTrendHours(72);
    setTrendData(null);
    setTrendErr("");
  };
  useEffect(() => {
    if (!trendStation) return;
    const seq = ++trendSeq.current;
    setTrendLoading(true);
    setTrendErr("");
    api(`/api/stations/${trendStation.id}/history?hours=${trendHours}`)
      .then((r) => {
        if (seq !== trendSeq.current) return;
        setTrendData(r);
      })
      .catch((e) => {
        if (seq !== trendSeq.current) return;
        setTrendData(null);
        setTrendErr(e.message);
      })
      .finally(() => {
        if (seq === trendSeq.current) setTrendLoading(false);
      });
  }, [trendStation, trendHours]);

  // 弹窗内 KPI 用列表里的最新站点数据（轮询会更新）
  const trendCur = trendStation ? stations.find((x) => x.id === trendStation.id) || trendStation : null;
  const trendRate = trendCur ? rateOf(trendCur) : 1;
  const trendPred = trendData?.prediction;
  const trendEta = etaText(trendPred, trendRate, rules.etaDays ?? 3);

  // 表单当前类型的凭证需求与可见性（v1 syncCredFields）
  const curType = types.find((t) => t.value === formType);
  const needs: string[] = curType?.needs || [];
  const isFixed = formType === "fixed";

  return (
    <PageContainer
      title="中转站"
      subTitle="管理你的 sub2api / new-api 中转站"
      extra={[
        <LastRefreshed key="last-refreshed" at={refreshedAt} />,
        <Button key="refresh" icon={<ReloadOutlined />} loading={refreshingAll} onClick={onRefreshAll}>刷新</Button>,
        <Button key="add" type="primary" icon={<PlusOutlined />} onClick={() => openModal(null)}>添加中转站</Button>,
      ]}
    >
      <ProCard loading={!loaded}>
        {stations.length ? (
          <div>
            {stations.map((s) => (
              <StationRow
                key={s.id}
                s={s}
                settings={settings}
                types={types}
                etaDaysRule={rules.etaDays ?? 3}
                refreshing={!!refreshingIds[s.id]}
                onTrend={openTrend}
                onRefresh={onRefreshOne}
                onEdit={openModal}
                onDelete={onDelete}
              />
            ))}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有中转站</div>
                <div style={{ color: token.colorTextSecondary }}>点击右上角「添加中转站」，填入站点地址与凭证即可监控余额。</div>
              </div>
            }
            style={{ padding: "40px 0" }}
          />
        )}
      </ProCard>

      {/* ---- 添加/编辑弹窗 ---- */}
      <Modal
        title={editing ? "编辑中转站" : "添加中转站"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={onSave}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden={false}
        width={520}
      >
        <div style={{ ...hint, marginBottom: 12 }}>凭证仅保存在本机，用于向该中转站查询余额。</div>
        <Form form={form} layout="vertical" size="middle">
          <Form.Item label="名称" name="name" style={{ marginBottom: 12 }}>
            <Input placeholder="例如：某某中转站" />
          </Form.Item>
          <Form.Item label="类型" name="type" style={{ marginBottom: 12 }} extra={TYPE_HINTS[formType] || ""}>
            <Select options={types.map((t) => ({ value: t.value, label: t.label }))} />
          </Form.Item>
          <Form.Item label="站点地址" name="baseUrl" style={{ marginBottom: 12 }}>
            <Input placeholder="https://your-relay.com" />
          </Form.Item>
          {needs.includes("accessToken") && (
            <Form.Item
              label={String(formType || "").startsWith("sub2api") ? "登录令牌（JWT）" : "访问令牌"}
              name="accessToken"
              style={{ marginBottom: 12 }}
            >
              <Input placeholder={credPlaceholder(!!editing?.hasAccessToken, "令牌 / JWT")} />
            </Form.Item>
          )}
          {needs.includes("userId") && (
            <Form.Item label="用户 ID（New-Api-User）" name="userId" style={{ marginBottom: 12 }}>
              <Input placeholder="例如 1" />
            </Form.Item>
          )}
          {needs.includes("apiKey") && (
            <Form.Item label="API 密钥" name="apiKey" style={{ marginBottom: 12 }}>
              <Input placeholder={credPlaceholder(!!editing?.hasApiKey, "sk-...")} />
            </Form.Item>
          )}
          {needs.includes("email") && (
            <Form.Item label="登录邮箱" name="email" style={{ marginBottom: 12 }}>
              <Input placeholder="you@example.com" />
            </Form.Item>
          )}
          {needs.includes("password") && (
            <Form.Item label="登录密码" name="password" style={{ marginBottom: 12 }}>
              <Input.Password placeholder={credPlaceholder(!!editing?.hasPassword, "站点的登录密码")} />
            </Form.Item>
          )}
          {!isFixed && (
            <Form.Item label="低余额告警阈值（按站点余额 $ 计，可留空）" name="lowBalanceUsd" style={{ marginBottom: 12 }}>
              <Input placeholder="留空则用全局阈值" />
            </Form.Item>
          )}
          {!isFixed && (
            <Form.Item
              label="充值折算汇率（站点 $1 折合人民币 ¥）"
              name="cnyPerUsd"
              style={{ marginBottom: 12 }}
              extra="面板金额将按此汇率折算成人民币展示；余额告警仍按站点余额判断。"
            >
              <Input placeholder="如 2 表示 $1 = ¥2，留空按 1:1" />
            </Form.Item>
          )}
          {isFixed && (
            <Form.Item label="固定成本付费记录（可叠加多笔）" style={{ marginBottom: 12 }}>
              {purchases.map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <Input
                    placeholder="金额（¥）"
                    value={p.amount ?? ""}
                    onChange={(e) => setPurchases((l) => l.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  />
                  <Input
                    placeholder="天数"
                    style={{ width: 90 }}
                    value={p.days ?? ""}
                    onChange={(e) => setPurchases((l) => l.map((x, j) => (j === i ? { ...x, days: e.target.value } : x)))}
                  />
                  <DatePicker
                    style={{ width: 150 }}
                    value={p.startDate ? dayjs(p.startDate) : null}
                    onChange={(d) =>
                      setPurchases((l) => l.map((x, j) => (j === i ? { ...x, startDate: d ? d.format("YYYY-MM-DD") : "" } : x)))
                    }
                  />
                  <Button
                    type="text"
                    icon={<CloseOutlined />}
                    title="删除这笔"
                    onClick={() => setPurchases((l) => l.filter((_, j) => j !== i))}
                  />
                </div>
              ))}
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => setPurchases((l) => [...l, { startDate: dayjs().format("YYYY-MM-DD") }])}
              >
                追加一笔
              </Button>
              <div style={hint}>
                每笔 = 金额 ÷ 天数 按天摊销，从购买日起生效、到期归零；多笔重叠期间成本叠加
                （在现有套餐上加购/续费就追加一笔）。不访问任何接口；站点地址可留空，
                填主机（不带端口）可匹配该主机所有端口的渠道。
              </div>
            </Form.Item>
          )}
          {formType === "newapi" && (
            <Form.Item
              name="isOwn"
              valuePropName="checked"
              style={{ marginBottom: 0 }}
              extra="启用「我的站点」下游分析（分用户/分模型用量与消费预测）。需要管理员（root）账号的系统访问令牌与用户 ID。转售给他人的管理员 Key 可在「我的站点」页的「管理员转售 Key」中勾选，其消费计入转售收入。"
            >
              <Checkbox>这是我自己的中转站</Checkbox>
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* ---- 趋势详情弹窗 ---- */}
      <Modal
        title={trendStation ? `余额趋势 · ${trendStation.name}` : ""}
        open={!!trendStation}
        onCancel={() => { setTrendStation(null); trendSeq.current++; }}
        footer={null}
        width={760}
      >
        {trendCur && (
          <>
            <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
              <Col xs={12} sm={6}>
                <Statistic
                  title="当前余额"
                  value={trendCur.balance?.ok ? cny(trendCur.balance.remaining * trendRate) : "—"}
                />
                {trendCur.balance?.ok && trendRate !== 1 ? (
                  <div style={hint}>站点余额 {usd(trendCur.balance.remaining)}</div>
                ) : null}
              </Col>
              <Col xs={12} sm={6}>
                <Statistic
                  title="今日消耗"
                  value={
                    trendCur.todayUsed != null
                      ? (trendCur.todayIsEstimate ? "≈ " : "") + cny(trendCur.todayUsed * trendRate)
                      : "—"
                  }
                />
                {trendCur.todayTokens != null || trendCur.todayRequests != null ? (
                  <div style={hint}>
                    {[
                      trendCur.todayTokens != null ? fmtTokens(trendCur.todayTokens) + " tokens" : null,
                      trendCur.todayRequests != null ? trendCur.todayRequests.toLocaleString("en-US") + " 次" : null,
                    ].filter(Boolean).join(" · ")}
                  </div>
                ) : null}
              </Col>
              <Col xs={12} sm={6}>
                <Statistic
                  title="日均消耗（估算）"
                  value={trendPred?.burnPerDay > 0 ? cny(trendPred.burnPerDay * trendRate) : "—"}
                />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic
                  title="预计耗尽"
                  value={trendPred?.etaDays != null ? fmtEta(trendPred.etaDays) : "—"}
                  valueStyle={
                    trendEta?.cls ? { color: trendEta.cls === "danger" ? COLOR.danger : COLOR.warn } : undefined
                  }
                />
              </Col>
            </Row>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8, overflowX: "auto" }}>
              <Segmented options={RANGES} value={trendHours} onChange={(v) => setTrendHours(Number(v))} />
            </div>
            <Spin spinning={trendLoading}>
              {trendErr ? (
                <div style={{ height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: token.colorTextSecondary }}>
                  {trendErr}
                </div>
              ) : trendData ? (
                // 图表纵轴按充值汇率折算成 ¥（耗尽时间等预测不受影响，同 v1）
                <TrendChart
                  points={(trendData.points || []).map((p: any) => [p[0], p[1] * trendRate])}
                  prediction={trendPred ? { ...trendPred, burnPerDay: trendPred.burnPerDay * trendRate } : trendPred}
                />
              ) : (
                <div style={{ height: 280 }} />
              )}
            </Spin>
          </>
        )}
      </Modal>
    </PageContainer>
  );
}
