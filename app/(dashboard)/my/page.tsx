"use client";
// 我的站点页：自有中转站的下游用量分析 + 利润分析 + 消费预测
// 对照 v1 app.js renderOwn/renderOwnBody/drawHourlyChart/renderResoldManager/drawOwnUsers/drawForecast，
// 功能与文案逐条平移；图表改用 @ant-design/plots，布局用 ProCard 重排
import { useEffect, useRef, useState } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Col,
  Input,
  Result,
  Row,
  Segmented,
  Statistic,
  Table,
  Tag,
  Typography,
  theme,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Bar, Column, Line } from "@ant-design/plots";
import ChartBox from "../chart-box";
import LastRefreshed from "../last-refreshed";
import { api, cny, cny4, fmtTokens, rateOf } from "../../../lib/client";
import { useThemeMode } from "../../providers";

const { Text, Title } = Typography;

// 范围选项与 v1 OWN_RANGES 一致（默认看今天）
const OWN_RANGES = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

// 成本口径标签（同 v1 MODE_LABEL）
const MODE_LABEL: Record<string, string> = { usage: "按用量", fixed: "固定摊销", history: "余额推算 ≈" };
// 角色标签（同 v1 renderResoldManager 的 ROLE）
const ROLE_LABEL: Record<number, string> = { 10: "管理员", 100: "root" };

const num = (n: any) => Number(n ?? 0).toLocaleString("en-US");
const hourLabel = (t: any) => `${String(new Date(Number(t)).getHours()).padStart(2, "0")}:00`;
const fmtDay = (v: any) => {
  const dd = new Date(v);
  return `${dd.getMonth() + 1}/${dd.getDate()}`;
};
// y 轴金额刻度：≥100 取整（同 v1 各图 "¥" 轴标签）
const yuanTick = (v: any) => `¥${Number(v) >= 100 ? Math.round(Number(v)) : Number(v)}`;
// 图表长名截断（v1 truncateLabel 的简化版）
const trunc = (s: any, n: number) => {
  const a = [...String(s ?? "")];
  return a.length > n ? a.slice(0, n - 1).join("") + "…" : String(s ?? "");
};

// 超过 10 项时聚合为「其他 N 个」（同 v1 drawUsageModels / drawOwnUsers）
function top10<T extends Record<string, any>>(list: T[], nameField: string): T[] {
  if (list.length <= 10) return list;
  const rest = list.slice(9);
  return [
    ...list.slice(0, 9),
    {
      [nameField]: `其他 ${rest.length} 个`,
      tokens: rest.reduce((a, x) => a + (x.tokens || 0), 0),
      cost: rest.reduce((a, x) => a + (x.cost || 0), 0),
      requests: rest.reduce((a, x) => a + (x.requests || 0), 0),
    } as any,
  ];
}

// 区块标题行（v1 .section-head：标题 + 灰色说明 + 右侧按钮）
// 标题不收缩不换行，窄屏下说明文字整体折到下一行而不是把标题挤成竖排
function SectionHead({ title, sub, extra }: { title: string; sub?: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, margin: "20px 0 12px" }}>
      <Title level={5} style={{ margin: 0, whiteSpace: "nowrap", flexShrink: 0 }}>{title}</Title>
      {sub ? <Text type="secondary" style={{ fontSize: 12, minWidth: 0 }}>{sub}</Text> : null}
      {extra ? <span style={{ marginLeft: "auto" }}>{extra}</span> : null}
    </div>
  );
}

// 图表本体统一固定高度，同排两图高度一致（全站规范）
const CHART_H = 300;

// 图表卡统一两行头（全站规范）：标题一行，副标题换行放标题下方，允许自动换行
function ChartHead({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {sub ? (
        <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal", whiteSpace: "normal", wordBreak: "break-word" }}>
          {sub}
        </Text>
      ) : null}
    </div>
  );
}

// KPI 统计卡（全站规范 2）：每张卡都渲染副行占位，避免有无副行导致同排高低不齐；卡片撑满列高
function KpiCard({ sub, children }: { sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <ProCard style={{ height: "100%" }}>
      {children}
      <div style={{ minHeight: 20 }}>{sub || null}</div>
    </ProCard>
  );
}

// 名称/说明在左、金额在右的一行（v1 .st-row.profit-row）
function ProfitRow({ name, meta, amt, sub }: { name: React.ReactNode; meta?: React.ReactNode; amt?: React.ReactNode; sub?: React.ReactNode }) {
  const { token } = theme.useToken();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{name}</div>
        {meta ? <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>{meta}</div> : null}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {amt ? <div style={{ fontWeight: 600 }}>{amt}</div> : null}
        {sub ? <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{sub}</div> : null}
      </div>
    </div>
  );
}

// 图表空态占位（v1 .chart-empty）
function ChartEmpty({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div style={{ height: CHART_H, display: "flex", alignItems: "center", justifyContent: "center", color: token.colorTextTertiary, fontSize: 13 }}>
      {text}
    </div>
  );
}

// 转售管理器里的账号 Key 数据形状（GET /api/own/admin-keys 的 accounts）
type AdminToken = { name: string; status?: number; usedUsd: number | null; flagged: boolean };
type AdminAccount = { username: string; role: number; enumerable: boolean; error?: string; tokens: AdminToken[] };

export default function MyStationPage() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const { dark } = useThemeMode();
  // @ant-design/plots 不随 ConfigProvider 算法切换，需显式指定主题
  const plotTheme = dark ? "classicDark" : "classic";
  const [range, setRange] = useState<string>("today");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  // 转售 Key 管理器状态
  const [mgrOpen, setMgrOpen] = useState(false);
  const [mgrLoading, setMgrLoading] = useState(false);
  const [mgrError, setMgrError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [addInputs, setAddInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // 客户端缓存：同范围 60 秒内直接复用（同 v1 loadOwn 的 cached 判断）
  const cacheRef = useRef<Record<string, { at: number; data: any }>>({});
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const load = async (force: boolean, r: string = rangeRef.current) => {
    const cached = cacheRef.current[r];
    if (!force && cached && Date.now() - cached.at < 60000) {
      setData(cached.data);
      setError(null);
      setRefreshedAt(cached.at);
      return;
    }
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await api(`/api/own/analytics?range=${r}&tz=${encodeURIComponent(tz)}`);
      cacheRef.current[r] = { at: Date.now(), data: res };
      // 响应回来时范围已切走则丢弃（同 v1 state.ownRange === range 判断）
      if (rangeRef.current !== r) return;
      setData(res);
      setError(null);
      setRefreshedAt(Date.now());
    } catch (e: any) {
      if (rangeRef.current !== r) return;
      setError(e.message || String(e));
    }
  };

  // 范围变化立即拉取；自动刷新约 30 秒一次（对照 v1 的自动刷新节奏），切回标签页立即刷一次
  useEffect(() => {
    load(false, range);
    const timer = setInterval(() => load(true), 30000);
    const onVis = () => {
      if (!document.hidden) load(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  };

  // ---- 转售 Key 管理器（v1 #manageResold / renderResoldManager / #resoldSave）----
  const toggleManager = async () => {
    if (mgrOpen) {
      setMgrOpen(false);
      setAccounts(null);
      setMgrError(null);
      return;
    }
    setMgrOpen(true);
    setMgrLoading(true);
    setMgrError(null);
    try {
      const r = await api("/api/own/admin-keys");
      setAccounts(r.accounts);
    } catch (e: any) {
      setMgrError(e.message || String(e));
    } finally {
      setMgrLoading(false);
    }
  };

  const toggleKey = (username: string, tokenName: string, checked: boolean) => {
    setAccounts((prev) =>
      (prev || []).map((a) =>
        a.username !== username
          ? a
          : { ...a, tokens: a.tokens.map((t) => (t.name === tokenName ? { ...t, flagged: checked } : t)) }
      )
    );
  };

  // 不可枚举账号手动补 Key 名（同 v1 [data-resold-add]，重名不重复添加）
  const addManualKey = (username: string) => {
    const name = (addInputs[username] || "").trim();
    if (!name) return;
    setAccounts((prev) =>
      (prev || []).map((a) => {
        if (a.username !== username) return a;
        if (a.tokens.some((t) => t.name === name)) return a;
        return { ...a, tokens: [...a.tokens, { name, flagged: true, usedUsd: null }] };
      })
    );
    setAddInputs((m) => ({ ...m, [username]: "" }));
  };

  const saveResold = async () => {
    const keys = (accounts || []).flatMap((a) =>
      a.tokens.filter((t) => t.flagged).map((t) => ({ username: a.username, tokenName: t.name }))
    );
    setSaving(true);
    try {
      await api("/api/own/admin-keys", { method: "PUT", body: { keys } });
      message.success(`已保存 ${keys.length} 个转售 Key，正在重算利润…`);
      setMgrOpen(false);
      setAccounts(null);
      await load(true);
    } catch (e: any) {
      message.error(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // ---- 页面头部：范围切换 + 手动刷新（v1 #ownRange / #ownRefresh）----
  const headerExtra = [
    <LastRefreshed key="refreshed" at={refreshedAt} />,
    <Segmented key="range" options={OWN_RANGES} value={range} onChange={(v) => setRange(String(v))} />,
    <Button key="refresh" icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>
      刷新
    </Button>,
  ];

  if (error) {
    return (
      <PageContainer title="我的站点" subTitle="自有中转站的下游用量分析与消费预测" extra={headerExtra}>
        <Result status="warning" title="无法加载下游数据" subTitle={error} />
      </PageContainer>
    );
  }
  if (!data) {
    return (
      <PageContainer title="我的站点" subTitle="自有中转站的下游用量分析与消费预测" extra={headerExtra}>
        {/* 初次加载统一 ProCard 骨架屏（全站规范 3），形状对齐真实布局：4 KPI + 两图 */}
        <Row gutter={[12, 12]}>
          {[0, 1, 2, 3].map((i) => (
            <Col key={i} xs={12} md={6}>
              <ProCard loading style={{ height: "100%" }} />
            </Col>
          ))}
        </Row>
        <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
          <Col xs={24} lg={14}>
            <ProCard loading style={{ height: "100%", minHeight: CHART_H }} />
          </Col>
          <Col xs={24} lg={10}>
            <ProCard loading style={{ height: "100%", minHeight: CHART_H }} />
          </Col>
        </Row>
      </PageContainer>
    );
  }

  // ---- 数据整形（严格对照 v1 renderOwnBody 的口径：全部金额 × 售价汇率）----
  const d = data;
  const rate = rateOf(d.station);
  const totCost = d.byModel.reduce((a: number, m: any) => a + m.cost, 0) * rate;
  const totTokens = d.byModel.reduce((a: number, m: any) => a + m.tokens, 0);
  const totReqs = d.byModel.reduce((a: number, m: any) => a + m.requests, 0);
  const hourly = d.range === "today";

  const buckets = d.trend.map((p: any) => {
    const dt = new Date(p.t);
    return {
      ...p,
      cost: p.cost * rate,
      label: hourly ? `${String(dt.getHours()).padStart(2, "0")}:00` : `${dt.getMonth() + 1}/${dt.getDate()}`,
    };
  });
  const models = d.byModel.map((m: any) => ({ ...m, cost: m.cost * rate }));
  const users = d.byUser.map((u: any) => ({ ...u, cost: u.cost * rate }));

  const fc = d.forecast;
  const fcLo = fc ? (fc.nextLo ?? fc.points.reduce((a: number, p: any) => a + p.lo, 0)) : 0;
  const fcHi = fc ? (fc.nextHi ?? fc.points.reduce((a: number, p: any) => a + p.hi, 0)) : 0;
  const fcSub = fc
    ? `未来 7 天预计 ${cny(fc.nextTotal * rate)}（区间 ${cny(fcLo * rate)} ~ ${cny(fcHi * rate)}）· ${fc.method} · 基于 ${fc.sampleDays} 天${
        fc.backtestWapePct != null ? ` · 近 2 周回测日均偏差 ±${fc.backtestWapePct}%` : ""
      }`
    : "历史数据不足 3 天，暂无法预测";

  // 未来 24 小时：过去实际 + 预测（同 v1 drawHourlyChart 的输入）
  const hourlyAll = d.hourly
    ? [
        ...d.hourly.past.map((p: any) => ({ t: p.t, cost: p.cost * rate, kind: "实际" })),
        ...d.hourly.next.map((p: any) => ({ t: p.t, cost: p.cost * rate, lo: p.lo * rate, hi: p.hi * rate, kind: "预测" })),
      ]
    : [];

  // 日消费历史 + 预测：预测线从最后一个历史点接出（同 v1 drawForecast）
  const dailyHist = d.daily.map((x: any) => ({ t: x.t, cost: x.cost * rate }));
  const fcPts = fc ? fc.points.map((p: any) => ({ t: p.t, cost: p.cost * rate, lo: p.lo * rate, hi: p.hi * rate })) : [];
  const lastHist = dailyHist[dailyHist.length - 1];
  const fcLineData = fc ? [...(lastHist ? [{ t: lastHist.t, cost: lastHist.cost }] : []), ...fcPts] : [];
  const forecastLineData = [
    ...dailyHist.map((p: any) => ({ ...p, kind: "历史日消费" })),
    ...fcLineData.map((p: any) => ({ ...p, kind: "预测" })),
  ].map((p: any) => ({ ...p, date: new Date(p.t) }));
  const bandData = fc
    ? [...(lastHist ? [{ t: lastHist.t, lo: lastHist.cost, hi: lastHist.cost }] : []), ...fcPts].map((p: any) => ({
        ...p,
        date: new Date(p.t),
      }))
    : [];

  const p = d.profit;
  const profitColor = p && !p.error ? (p.profitCny >= 0 ? "#3f8600" : "#cf1322") : undefined;
  const incomeSub = p && !p.error
    ? [
        (p.resoldCny || 0) > 0 ? `含转售管理员 Key ${cny(p.resoldCny)}` : "",
        p.adminUsageCny > 0 ? `管理员自用 ${cny(p.adminUsageCny)}（计成本不计收入）` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  // 用户余额（不含管理员/root）：非零余额排序展示，零余额只报数量
  const balances = d.userBalances as any[] | null;
  const nonZeroBal = balances ? balances.filter((u) => u.balanceUsd > 0.0001) : [];
  const zeroBalCount = balances ? balances.length - nonZeroBal.length : 0;
  const totalBalCny = balances ? balances.reduce((a, u) => a + u.balanceUsd, 0) * rate : 0;

  const pctCol = (cost: number) => (totCost > 0 ? ((cost / totCost) * 100).toFixed(1) + "%" : "—");

  // byModel 按消费(cost)降序（v1 口径，模型明细表沿用）；本图纵轴是 tokens，
  // 必须按 tokens 重排——否则巨量 token 的便宜模型排在中间、长尾全是隐形细条，
  // top10 折叠也会按错误顺序吞掉高 token 模型
  const modelItems = top10([...models].sort((a, b) => (b.tokens || 0) - (a.tokens || 0)), "model");
  const userItems = top10(users, "user");

  return (
    <PageContainer title="我的站点" subTitle="自有中转站的下游用量分析与消费预测" extra={headerExtra}>
      {/* KPI：期内消费 / Tokens / 请求数 / 活跃用户 */}
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <KpiCard><Statistic title="期内消费" value={cny4(totCost)} /></KpiCard>
        </Col>
        <Col xs={12} md={6}>
          <KpiCard>
            <Statistic title="Tokens" value={fmtTokens(totTokens)} valueRender={(node) => <span title={num(totTokens)}>{node}</span>} />
          </KpiCard>
        </Col>
        <Col xs={12} md={6}>
          <KpiCard><Statistic title="请求数" value={num(totReqs)} /></KpiCard>
        </Col>
        <Col xs={12} md={6}>
          <KpiCard><Statistic title="活跃用户" value={users.length} suffix="个" /></KpiCard>
        </Col>
      </Row>

      {/* ---- 利润分析（v1 profitSection）---- */}
      {p && p.error ? (
        <Alert style={{ marginTop: 14 }} type="warning" showIcon message={`利润分析不可用：${p.error}`} />
      ) : null}
      {p && !p.error ? (
        <>
          {p.warnings?.length ? (
            <Alert
              style={{ marginTop: 14 }}
              type={p.complete ? "info" : "warning"}
              showIcon
              message={!p.complete ? "利润数据尚不完整" : p.estimated ? "成本中包含估算值" : "利润口径提示"}
              description={p.warnings.join("；")}
            />
          ) : null}
          <SectionHead
            title="利润分析"
            sub={`收入 = 普通用户消费 × 售价汇率（不含管理员/root，除非该 Key 已标为转售）· 成本按各上游口径（窗口 ${p.windowDays} 天）`}
          />
          <Row gutter={[12, 12]}>
            <Col xs={12} md={6}>
              <KpiCard sub={incomeSub ? <Text type="secondary" style={{ fontSize: 12 }}>{incomeSub}</Text> : null}>
                <Statistic title="期内收入" value={cny(p.incomeCny)} />
              </KpiCard>
            </Col>
            <Col xs={12} md={6}>
              <KpiCard><Statistic title="期内成本" value={cny(p.totalCostCny)} /></KpiCard>
            </Col>
            <Col xs={12} md={6}>
              <KpiCard><Statistic title="利润" value={cny(p.profitCny)} valueStyle={{ color: profitColor }} /></KpiCard>
            </Col>
            <Col xs={12} md={6}>
              <KpiCard>
                <Statistic title="利润率" value={p.marginPct != null ? p.marginPct + "%" : "—"} valueStyle={{ color: profitColor }} />
              </KpiCard>
            </Col>
          </Row>

          {/* 管理员转售 Key（v1 resoldSection + renderResoldManager） */}
          <SectionHead
            title="管理员转售 Key"
            extra={<Button onClick={toggleManager}>{mgrOpen ? "收起" : "管理转售 Key"}</Button>}
          />
          {(p.resoldKeys || []).length ? (
            <ProCard>
              {p.resoldKeys.map((k: any) => (
                <ProfitRow
                  key={`${k.username}/${k.tokenName}`}
                  name={
                    <>
                      <Text code>{k.username} / {k.tokenName}</Text>
                      {k.error ? <Tag color="warning" style={{ marginLeft: 6 }}>查询失败</Tag> : null}
                    </>
                  }
                  meta={k.error ? k.error : "转售给下游 · 计入收入"}
                  amt={cny(k.cny || 0)}
                  sub="期内收入"
                />
              ))}
            </ProCard>
          ) : (
            <Alert
              type="info"
              showIcon
              message="还没有标记转售 Key。若某个管理员/root 账号的 API Key 实际给了下游，点「管理转售 Key」勾选它，其消费即计入收入。"
            />
          )}
          {mgrOpen ? (
            <ProCard style={{ marginTop: 12 }}>
              {mgrLoading ? (
                <div style={{ padding: 20, textAlign: "center", color: token.colorTextSecondary }}>正在拉取管理员账号的 Key…</div>
              ) : mgrError ? (
                <Alert type="warning" showIcon message={`拉取失败：${mgrError}`} />
              ) : !accounts || !accounts.length ? (
                <Alert type="warning" showIcon message="没有找到管理员/root 账号（role ≥ 10）。" />
              ) : (
                <>
                  <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 10 }}>
                    勾选实际转售给下游的 Key，其期内消费将从「管理员自用（成本）」改计入「收入 × 售价汇率」。Key
                    名可能跨账号重名，故按「账号 + Key 名」定位。
                  </Text>
                  {accounts.map((a) => (
                    <div key={a.username} style={{ marginBottom: 14 }}>
                      <div style={{ marginBottom: 8, fontWeight: 500 }}>
                        {a.username} <Tag>{ROLE_LABEL[a.role] || `role ${a.role}`}</Tag>
                      </div>
                      {a.enumerable ? (
                        a.tokens.length ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {a.tokens.map((t) => (
                              <Checkbox
                                key={t.name}
                                checked={t.flagged}
                                onChange={(e) => toggleKey(a.username, t.name, e.target.checked)}
                              >
                                {t.name || "（未命名）"}
                                {t.usedUsd != null ? (
                                  <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                                    累计用 {cny(t.usedUsd * rate)}
                                  </Text>
                                ) : null}
                              </Checkbox>
                            ))}
                          </div>
                        ) : (
                          <Text type="secondary" style={{ fontSize: 12 }}>该账号没有 API Key</Text>
                        )
                      ) : (
                        <>
                          <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
                            此账号无法自动列出 Key（{a.error || "接口限制"}）。若它有转售 Key，请手动填 Key 名：
                          </Text>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                            {a.tokens.map((t) => (
                              <Checkbox
                                key={t.name}
                                checked={t.flagged}
                                onChange={(e) => toggleKey(a.username, t.name, e.target.checked)}
                              >
                                {t.name || "（未命名）"}
                              </Checkbox>
                            ))}
                          </div>
                          <div style={{ display: "flex", gap: 8, maxWidth: 360 }}>
                            <Input
                              size="small"
                              placeholder="Key 名（token_name）"
                              value={addInputs[a.username] || ""}
                              onChange={(e) => setAddInputs((m) => ({ ...m, [a.username]: e.target.value }))}
                              onPressEnter={() => addManualKey(a.username)}
                            />
                            <Button size="small" icon={<PlusOutlined />} onClick={() => addManualKey(a.username)}>
                              添加
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  <Button type="primary" loading={saving} onClick={saveResold}>
                    保存并重算
                  </Button>
                </>
              )}
            </ProCard>
          ) : null}

          {/* 成本明细：所有启用计入成本的监控上游，不依赖渠道 URL 是否匹配 */}
          {p.costs.length ? (
            <>
              <SectionHead title="成本明细" sub={`共 ${p.costs.length} 个纳入成本的上游 · 按各上游口径计入期内成本`} />
              <ProCard>
                {p.costs.map((c: any) => (
                  <ProfitRow
                    key={c.name}
                    name={
                      <>
                        {c.name} <Tag>{MODE_LABEL[c.mode] || c.mode}</Tag>
                        {c.note ? <Tag color={c.mode === "history" || c.note === "已到期" ? "warning" : undefined}>{c.note}</Tag> : null}
                      </>
                    }
                    meta={`渠道：${c.channels.join("、")}`}
                    amt={cny(c.cny)}
                    sub="期内成本"
                  />
                ))}
              </ProCard>
            </>
          ) : (
            <Alert
              style={{ marginTop: 14 }}
              type="warning"
              showIcon
              message="没有启用计入利润成本的上游，成本暂计 ¥0"
            />
          )}

          {/* 未直接关联监控站的渠道，仅用于检查是否还有未监控成本 */}
          {p.unmatched.length ? (
            <>
              <SectionHead
                title="未直接关联监控站的渠道"
                sub={`共 ${p.unmatched.length} 个渠道地址（按 URL 合并）· 监控列表中的上游成本已独立计入，此处仅用于检查是否还有未添加的外部上游`}
              />
              <ProCard>
                {p.unmatched.map((u: any) => (
                  <ProfitRow key={u.label} name={u.label} meta={u.names.join("、")} sub={`${u.enabled}/${u.total} 个渠道启用`} />
                ))}
              </ProCard>
            </>
          ) : null}
          <SectionHead title="用量分析" />
        </>
      ) : null}

      {/* ---- 用量趋势 + 分模型 Token ---- */}
      <Row gutter={[12, 12]} style={{ marginTop: p && !p.error ? 0 : 14 }}>
        <Col xs={24} lg={14}>
          <ProCard style={{ height: "100%" }} title={<ChartHead title="用量趋势" sub={`${hourly ? "按小时" : "按天"}汇总（tokens）`} />}>
            {!buckets.length || buckets.every((b: any) => !b.tokens) ? (
              <ChartEmpty text="该范围内暂无用量数据" />
            ) : (
              <ChartBox h={CHART_H}>
              <Column
                theme={plotTheme}
                height={CHART_H}
                data={buckets}
                xField="label"
                yField="tokens"
                axis={{ y: { labelFormatter: (v: any) => fmtTokens(v) } }}
                tooltip={{
                  title: (b: any) => b.label,
                  items: [
                    (b: any) => ({ name: "Tokens", value: num(b.tokens) }),
                    (b: any) => ({ name: "消耗", value: cny4(b.cost) }),
                    (b: any) => ({ name: "请求", value: num(b.requests) }),
                  ],
                }}
              />
              </ChartBox>
            )}
          </ProCard>
        </Col>
        <Col xs={24} lg={10}>
          <ProCard style={{ height: "100%" }} title={<ChartHead title="分模型 Token" sub="按用量降序，最多 10 项" />}>
            {!modelItems.length ? (
              <ChartEmpty text="该范围内暂无用量数据" />
            ) : (
              <ChartBox h={CHART_H}>
              <Bar
                theme={plotTheme}
                height={CHART_H}
                data={modelItems}
                xField="model"
                yField="tokens"
                axis={{ x: { labelFormatter: (v: any) => trunc(v, 20) }, y: { labelFormatter: (v: any) => fmtTokens(v) } }}
                label={{ text: (m: any) => fmtTokens(m.tokens), position: "right", dx: 4 }}
                tooltip={{
                  title: (m: any) => m.model,
                  items: [
                    (m: any) => ({ name: "Tokens", value: num(m.tokens) }),
                    (m: any) => ({ name: "消耗", value: cny4(m.cost) }),
                    (m: any) => ({ name: "请求", value: num(m.requests) }),
                  ],
                }}
              />
              </ChartBox>
            )}
          </ProCard>
        </Col>
      </Row>

      {/* ---- 未来 24 小时预测（仅今天范围有 hourly）---- */}
      {d.hourly ? (
        <ProCard
          style={{ marginTop: 12 }}
          title={
            <ChartHead
              title="未来 24 小时预测"
              sub={`今天已消费 ${cny(d.hourly.todaySoFar * rate)} · 全天预计 ≈${cny(d.hourly.todayEst * rate)} · 未来 24h 合计 ≈${cny(
                d.hourly.next24Total * rate
              )}${d.hourly.backtestWapePct != null ? ` · 24h 总量回测偏差 ±${d.hourly.backtestWapePct}%` : ""}`}
            />
          }
        >
          {hourlyAll.length < 4 ? (
            <ChartEmpty text="小时数据不足" />
          ) : (
            <ChartBox h={CHART_H}>
            <Column
              theme={plotTheme}
              height={CHART_H}
              data={hourlyAll}
              xField="t"
              yField="cost"
              colorField="kind"
              scale={{ color: { domain: ["实际", "预测"], range: ["#1677ff", "rgba(22,119,255,0.35)"] } }}
              axis={{ x: { labelFormatter: (v: any) => hourLabel(v) }, y: { labelFormatter: yuanTick } }}
              annotations={
                d.hourly.next.length
                  ? [{ type: "lineX", data: [d.hourly.next[0].t], style: { stroke: token.colorTextTertiary, lineDash: [4, 4] } }]
                  : []
              }
              tooltip={{
                title: (x: any) => `${hourLabel(x.t)}（${x.kind}）`,
                items: [
                  (x: any) => ({ name: "消费", value: cny4(x.cost) }),
                  (x: any) => ({ name: "区间", value: x.kind === "预测" ? `${cny(x.lo)} ~ ${cny(x.hi)}` : "—" }),
                ],
              }}
            />
            </ChartBox>
          )}
        </ProCard>
      ) : null}

      {/* ---- 消费预测 + 分用户消费 ---- */}
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} lg={14}>
          <ProCard style={{ height: "100%" }} title={<ChartHead title="消费预测" sub={fcSub} />}>
            {!dailyHist.length && !fcPts.length ? (
              <ChartEmpty text="历史数据不足，暂无法预测" />
            ) : (
              <>
                <ChartBox h={CHART_H}>
                <Line
                  theme={plotTheme}
                  height={CHART_H}
                  data={forecastLineData}
                  xField="date"
                  yField="cost"
                  colorField="kind"
                  legend={false}
                  scale={{ color: { domain: ["历史日消费", "预测"], range: ["#1677ff", "#1677ff"] } }}
                  style={{
                    lineWidth: 2,
                    lineDash: (items: any) => {
                      const one = Array.isArray(items) ? items[0] : items;
                      return one?.kind === "预测" ? [5, 4] : null;
                    },
                  }}
                  axis={{ x: { labelFormatter: (v: any) => fmtDay(v) }, y: { labelFormatter: yuanTick } }}
                  annotations={
                    bandData.length
                      ? [
                          {
                            type: "area",
                            data: bandData,
                            encode: { x: "date", y: "lo", y1: "hi" },
                            style: { fill: "#1677ff", fillOpacity: 0.12 },
                            tooltip: false,
                          },
                        ]
                      : []
                  }
                  tooltip={{
                    title: (x: any) => `${fmtDay(x.date)}${x.kind === "预测" ? "（预测）" : ""}`,
                    items: [
                      (x: any) => ({ name: "消费", value: cny(x.cost) }),
                      (x: any) => ({ name: "区间", value: x.kind === "预测" && x.lo != null ? `${cny(x.lo)} ~ ${cny(x.hi)}` : "—" }),
                    ],
                  }}
                />
                </ChartBox>
                {/* 图例（对照 v1 .fc-legend） */}
                <div style={{ display: "flex", flexWrap: "wrap", minWidth: 0, gap: 16, marginTop: 8, fontSize: 12, color: token.colorTextSecondary }}>
                  <span><span style={{ display: "inline-block", width: 18, borderTop: "2px solid #1677ff", verticalAlign: "middle", marginRight: 4 }} />历史日消费</span>
                  <span><span style={{ display: "inline-block", width: 18, borderTop: "2px dashed #1677ff", verticalAlign: "middle", marginRight: 4 }} />预测</span>
                  <span><span style={{ display: "inline-block", width: 18, height: 10, background: "rgba(22,119,255,0.12)", verticalAlign: "middle", marginRight: 4 }} />80% 置信区间</span>
                </div>
              </>
            )}
          </ProCard>
        </Col>
        <Col xs={24} lg={10}>
          <ProCard style={{ height: "100%" }} title={<ChartHead title="分用户消费" sub="期内消费降序，最多 10 项（¥）" />}>
            {!userItems.length ? (
              <ChartEmpty text="该范围内暂无数据" />
            ) : (
              <ChartBox h={CHART_H}>
              <Bar
                theme={plotTheme}
                height={CHART_H}
                data={userItems}
                xField="user"
                yField="cost"
                axis={{ x: { labelFormatter: (v: any) => trunc(v, 14) }, y: { labelFormatter: yuanTick } }}
                label={{ text: (u: any) => cny(u.cost), position: "right", dx: 4 }}
                tooltip={{
                  title: (u: any) => u.user,
                  items: [
                    (u: any) => ({ name: "消费", value: cny4(u.cost) }),
                    (u: any) => ({ name: "Tokens", value: fmtTokens(u.tokens) }),
                    (u: any) => ({ name: "请求", value: num(u.requests) }),
                  ],
                }}
              />
              </ChartBox>
            )}
          </ProCard>
        </Col>
      </Row>

      {/* ---- 用户明细 ---- */}
      <SectionHead title="用户明细" sub={`共 ${users.length} 个用户`} />
      <ProCard>
        <Table
          size="small"
          rowKey="user"
          pagination={false}
          scroll={{ x: "max-content" }}
          dataSource={users}
          locale={{ emptyText: "该范围内暂无数据" }}
          columns={[
            {
              title: "用户",
              dataIndex: "user",
              render: (v: string, r: any) => (
                <>
                  <Text code>{v}</Text>
                  {r.isAdmin ? <Tag color="warning" style={{ marginLeft: 6 }}>管理员</Tag> : null}
                </>
              ),
            },
            { title: "请求数", dataIndex: "requests", render: (v: number) => num(v) },
            { title: "Tokens", dataIndex: "tokens", render: (v: number) => num(v) },
            { title: "消费", dataIndex: "cost", render: (v: number) => cny4(v) },
            { title: "占比", dataIndex: "cost", key: "pct", render: (v: number) => pctCol(v) },
          ]}
        />
      </ProCard>

      {/* ---- 用户余额（不含管理员/root）---- */}
      {balances ? (
        <>
          <SectionHead title="用户余额" sub={`不含管理员 · 共 ${balances.length} 个用户 · 余额合计 ${cny(totalBalCny)}`} />
          <ProCard>
            <Table
              size="small"
              rowKey="user"
              pagination={false}
              scroll={{ x: "max-content" }}
              dataSource={nonZeroBal}
              locale={{ emptyText: "没有余额大于 0 的用户" }}
              footer={zeroBalCount > 0 ? () => <Text type="secondary">另有 {zeroBalCount} 个用户余额为 0</Text> : undefined}
              columns={[
                { title: "用户", dataIndex: "user", render: (v: string) => <Text code>{v}</Text> },
                { title: "余额", dataIndex: "balanceUsd", render: (v: number) => cny4(v * rate) },
                { title: "累计已用", dataIndex: "usedUsd", render: (v: number) => cny(v * rate) },
                {
                  title: "状态",
                  dataIndex: "status",
                  render: (v: number) => (v === 1 ? "正常" : <Text type="secondary">已禁用</Text>),
                },
              ]}
            />
          </ProCard>
        </>
      ) : null}

      {/* ---- 模型明细 ---- */}
      <SectionHead title="模型明细" sub={`共 ${models.length} 个模型`} />
      <ProCard>
        <Table
          size="small"
          rowKey="model"
          pagination={false}
          scroll={{ x: "max-content" }}
          dataSource={models}
          locale={{ emptyText: "该范围内暂无数据" }}
          columns={[
            { title: "模型", dataIndex: "model", render: (v: string) => <Text code>{v}</Text> },
            { title: "请求数", dataIndex: "requests", render: (v: number) => num(v) },
            { title: "Tokens", dataIndex: "tokens", render: (v: number) => num(v) },
            { title: "消费", dataIndex: "cost", render: (v: number) => cny4(v) },
            { title: "占比", dataIndex: "cost", key: "pct", render: (v: number) => pctCol(v) },
          ]}
        />
      </ProCard>
    </PageContainer>
  );
}
