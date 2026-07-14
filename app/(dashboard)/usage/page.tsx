"use client";
// 用量统计页：分站点、分模型、分时段的 Token 消耗
// 对照 v1 app.js renderUsage/renderUsageBody/drawUsageTrend/drawUsageModels（681-931 行）逐条平移：
// 时间档位、站点筛选、四张合计卡、错误站点提示、趋势/分模型图、模型明细表，口径与文案一致
import { useEffect, useMemo, useRef, useState } from "react";
import { PageContainer, ProCard, ProTable } from "@ant-design/pro-components";
import { Alert, Button, Segmented, Select, Space, Statistic, Typography, theme } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { Bar, Column } from "@ant-design/plots";
import { api, cny4, fmtTokens, rateOf } from "../../../lib/client";
import ChartBox from "../chart-box";
import LastRefreshed from "../last-refreshed";
import { useThemeMode } from "../../providers";

// 时间档位（照抄 v1 USAGE_RANGES）
const USAGE_RANGES = [
  ["today", "今天"],
  ["24h", "近 24 小时"],
  ["7d", "近 7 天"],
  ["30d", "近 30 天"],
] as const;

// CJK 按 2 个单位计宽的标签截断（同 v1 truncateLabel）
function truncateLabel(s: any, units = 14): string {
  let u = 0,
    out = "";
  for (const ch of String(s)) {
    u += /[⺀-꓏가-힣豈-﫿︰-﹏＀-￯]/.test(ch) ? 2 : 1;
    if (u > units) return out + "…";
    out += ch;
  }
  return String(s);
}

const num = (n: any) => Number(n ?? 0).toLocaleString("en-US");

// 全站统一：图表本体固定高度，保证同排两图等高
const CHART_H = 300;

const { Text } = Typography;

// 图表空态 / 正文加载与错误态（文案照抄 v1 chart-empty）
function ChartEmpty({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div style={{ height: CHART_H, display: "flex", alignItems: "center", justifyContent: "center", color: token.colorTextTertiary, fontSize: 13 }}>
      {text}
    </div>
  );
}

// 全站统一两行卡头：标题在上、副标题换行放下方（允许换行，不再与标题同行挤）
function CardTitle({ text, sub }: { text: string; sub: string }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{text}</div>
      <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal", whiteSpace: "normal" }}>
        {sub}
      </Text>
    </div>
  );
}

export default function UsagePage() {
  const { token } = theme.useToken();
  const { dark } = useThemeMode();
  const [range, setRange] = useState<string>("today");
  const [station, setStation] = useState<string>("all");
  const [stations, setStations] = useState<any[]>([]); // 下拉用的站点列表（/api/stations）
  const [data, setData] = useState<any>(null); // /api/usage 响应
  const [err, setErr] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  // 与 v1 loadUsage 相同的 30 秒前端缓存（单槽，按 range 记）
  const cacheRef = useRef<{ range: string; at: number; data: any } | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  // 站点下拉：同 v1 用列表接口的 stations（排除固定成本站点）
  useEffect(() => {
    api("/api/stations")
      .then((r) => setStations((r.stations || []).filter((s: any) => s.type !== "fixed")))
      .catch(() => {});
  }, []);

  // 拉取用量：force 跳过缓存；tz 传浏览器时区（同 v1 api.usage）
  const load = async (force = false, r = rangeRef.current) => {
    const cached = cacheRef.current;
    if (!force && cached && cached.range === r && Date.now() - cached.at < 30000) {
      setData(cached.data);
      setErr("");
      return;
    }
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const resp = await api(`/api/usage?range=${r}&tz=${encodeURIComponent(tz)}`);
      cacheRef.current = { range: r, at: Date.now(), data: resp };
      setRefreshedAt(Date.now());
      if (rangeRef.current === r) {
        setData(resp);
        setErr("");
      }
    } catch (e: any) {
      if (rangeRef.current === r) setErr(e.message || String(e));
    }
  };

  // 档位变化即加载；自动刷新每 30 秒强制拉一次；切回标签页立即刷新（同 v1）
  useEffect(() => {
    load(false, range);
    const t = setInterval(() => load(true), 30000);
    const onVis = () => {
      if (!document.hidden) load(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
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

  // ---- 聚合（照抄 v1 renderUsageBody）--------------------------------------
  const agg = useMemo(() => {
    if (!data) return null;
    // 「全部」只聚合上游；我的站点仍可在下拉里单独选看
    const sts =
      station === "all"
        ? (data.stations || []).filter((s: any) => !s.isOwn)
        : (data.stations || []).filter((s: any) => s.id === station);
    const okSts = sts.filter((s: any) => s.ok);
    const errSts = sts.filter((s: any) => !s.ok);

    // 跨站点汇总：按模型名合并（消耗按各站充值汇率折算成 ¥）
    const mmap = new Map<string, any>();
    for (const s of okSts) {
      const rate = rateOf(s);
      for (const m of s.models || []) {
        const acc = mmap.get(m.model) || { model: m.model, tokens: 0, cost: 0, requests: 0, inputTokens: 0, outputTokens: 0, hasIO: false };
        acc.tokens += m.tokens || 0;
        acc.cost += (m.cost || 0) * rate;
        acc.requests += m.requests || 0;
        if (m.inputTokens != null) {
          acc.inputTokens += m.inputTokens || 0;
          acc.outputTokens += m.outputTokens || 0;
          acc.hasIO = true;
        }
        mmap.set(m.model, acc);
      }
    }
    const models = [...mmap.values()].sort((a, b) => b.tokens - a.tokens);

    // 按时间桶合并：能解析出时间戳的按小时/天取整分桶（跨天时小时标签会重复，
    // 不能拿标签当键），解析不出的按原始标签
    const hourly = data.granularity === "hour";
    const bucketKey = (p: any) => {
      if (p.t == null) return "l:" + (p.label || "?");
      if (hourly) return "t:" + Math.floor(p.t / 3600000);
      const d = new Date(p.t);
      return "d:" + (d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
    };
    const today = new Date();
    const bucketLabel = (p: any) => {
      if (p.t == null) return p.label || "?";
      const d = new Date(p.t);
      if (!hourly) return `${d.getMonth() + 1}/${d.getDate()}`;
      const hh = `${String(d.getHours()).padStart(2, "0")}:00`;
      return d.getDate() === today.getDate() && d.getMonth() === today.getMonth()
        ? hh
        : `${d.getMonth() + 1}/${d.getDate()} ${hh}`;
    };
    const bmap = new Map<string, any>();
    for (const s of okSts) {
      const rate = rateOf(s);
      for (const p of s.trend || []) {
        const k = bucketKey(p);
        const acc = bmap.get(k) || { label: bucketLabel(p), t: p.t ?? Infinity, tokens: 0, cost: 0, requests: 0 };
        acc.tokens += p.tokens || 0;
        acc.cost += (p.cost || 0) * rate;
        acc.requests += p.requests || 0;
        acc.t = Math.min(acc.t, p.t ?? Infinity);
        bmap.set(k, acc);
      }
    }
    const buckets = [...bmap.values()].sort((a, b) => a.t - b.t);

    // 合计口径按范围选：今天 = 站点仪表盘同款数字（和站点页面显示一致）；
    // 近 24 小时 = 截好窗的趋势求和；7/30 天 = 模型明细求和
    let totTokens: number, totCost: number, totReqs: number;
    if (data.range === "today") {
      totTokens = okSts.reduce((a: number, s: any) => a + (s.summary?.tokens ?? (s.models || []).reduce((x: number, m: any) => x + m.tokens, 0)), 0);
      totCost = okSts.reduce((a: number, s: any) => a + (s.summary?.cost ?? (s.models || []).reduce((x: number, m: any) => x + m.cost, 0)) * rateOf(s), 0);
      totReqs = okSts.reduce((a: number, s: any) => a + (s.summary?.requests ?? (s.models || []).reduce((x: number, m: any) => x + m.requests, 0)), 0);
    } else {
      const src: any[] = data.range === "24h" ? buckets : models;
      totTokens = src.reduce((a, m) => a + m.tokens, 0);
      totCost = src.reduce((a, m) => a + m.cost, 0);
      totReqs = src.reduce((a, m) => a + m.requests, 0);
    }
    const modelsByDate = data.range === "24h" && okSts.some((s: any) => s.modelsWindow === "date");

    return { sts, okSts, errSts, models, buckets, totTokens, totCost, totReqs, modelsByDate };
  }, [data, station]);

  // 分模型图：超过 10 项时后段合并为「其他 N 个」（同 v1 drawUsageModels）
  const modelChartItems = useMemo(() => {
    if (!agg) return [];
    let items = agg.models;
    if (items.length > 10) {
      const rest = items.slice(9);
      items = items.slice(0, 9);
      items.push({
        model: `其他 ${rest.length} 个`,
        tokens: rest.reduce((a: number, x: any) => a + x.tokens, 0),
        cost: rest.reduce((a: number, x: any) => a + x.cost, 0),
        requests: rest.reduce((a: number, x: any) => a + x.requests, 0),
      });
    }
    return items;
  }, [agg]);

  const trendEmpty = !agg || !agg.buckets.length || agg.buckets.every((b: any) => !b.tokens);

  // 悬停提示项：tokens / 消耗 / 请求（同 v1 attachUsageTip 内容）
  const tipItems = [
    { field: "tokens", name: "Tokens", valueFormatter: (v: any) => num(v) },
    { field: "cost", name: "消耗", valueFormatter: (v: any) => cny4(v) },
    { field: "requests", name: "请求", valueFormatter: (v: any) => num(v) },
  ];

  // 模型明细表列（同 v1 u-table：hasIO 缺失的输入/输出显示 —）
  const columns = [
    {
      title: "模型",
      dataIndex: "model",
      render: (v: any) => <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{v}</span>,
    },
    { title: "请求数", dataIndex: "requests", align: "right" as const, render: (v: any) => num(v) },
    { title: "输入 Tokens", dataIndex: "inputTokens", align: "right" as const, render: (v: any, r: any) => (r.hasIO ? num(v) : "—") },
    { title: "输出 Tokens", dataIndex: "outputTokens", align: "right" as const, render: (v: any, r: any) => (r.hasIO ? num(v) : "—") },
    { title: "总 Tokens", dataIndex: "tokens", align: "right" as const, render: (v: any) => num(v) },
    { title: "实际消耗", dataIndex: "cost", align: "right" as const, render: (v: any) => cny4(v) },
  ];

  return (
    <PageContainer
      title="用量统计"
      subTitle="分站点、分模型、分时段的 Token 消耗"
      extra={[
        <LastRefreshed key="last-refreshed" at={refreshedAt} />,
        <Button key="refresh" icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>
          刷新
        </Button>,
      ]}
    >
      {/* 筛选：时间档位 + 站点（同 v1 usage-filters） */}
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented
          value={range}
          onChange={(v) => setRange(String(v))}
          options={USAGE_RANGES.map(([v, l]) => ({ value: v, label: l }))}
        />
        <Select
          value={station}
          onChange={setStation}
          style={{ minWidth: 200 }}
          options={[
            { value: "all", label: "全部上游站点" },
            ...stations.map((s: any) => ({ value: s.id, label: `${s.name}${s.isOwn ? "（我的站）" : ""}` })),
          ]}
        />
      </Space>

      {err ? (
        <ProCard>
          <ChartEmpty text={err} />
        </ProCard>
      ) : !agg ? (
        // 初次加载：与其它页面统一的 ProCard 骨架屏（合计卡一排 + 两张图占位）
        <>
          <ProCard gutter={16} wrap style={{ marginBottom: 16 }} ghost>
            {[0, 1, 2, 3].map((i) => (
              <ProCard key={i} colSpan={{ xs: 12, md: 6 }} variant="outlined" loading style={{ height: "100%" }} />
            ))}
          </ProCard>
          <ProCard gutter={16} wrap style={{ marginBottom: 16 }} ghost>
            <ProCard colSpan={{ xs: 24, lg: 14 }} variant="outlined" loading style={{ height: "100%", minHeight: CHART_H }} />
            <ProCard colSpan={{ xs: 24, lg: 10 }} variant="outlined" loading style={{ height: "100%", minHeight: CHART_H }} />
          </ProCard>
        </>
      ) : (
        <>
          {/* 合计卡：总 Tokens / 实际消耗 / 请求数 / 数据来源 */}
          <ProCard gutter={16} wrap style={{ marginBottom: 16 }}>
            <ProCard colSpan={{ xs: 12, md: 6 }} variant="outlined" style={{ height: "100%" }}>
              <Statistic
                title="总 Tokens"
                valueRender={() => <span title={num(agg.totTokens)}>{fmtTokens(agg.totTokens)}</span>}
                value={agg.totTokens}
              />
              <div style={{ minHeight: 20 }}>{null}</div>
            </ProCard>
            <ProCard colSpan={{ xs: 12, md: 6 }} variant="outlined" style={{ height: "100%" }}>
              <Statistic title="实际消耗" value={cny4(agg.totCost)} />
              <div style={{ minHeight: 20 }}>{null}</div>
            </ProCard>
            <ProCard colSpan={{ xs: 12, md: 6 }} variant="outlined" style={{ height: "100%" }}>
              <Statistic title="请求数" value={num(agg.totReqs)} />
              <div style={{ minHeight: 20 }}>{null}</div>
            </ProCard>
            <ProCard colSpan={{ xs: 12, md: 6 }} variant="outlined" style={{ height: "100%" }}>
              <Statistic
                title="数据来源"
                valueRender={() => (
                  <span>
                    {agg.okSts.length}
                    <span style={{ fontSize: 14, color: token.colorTextSecondary, marginLeft: 4 }}>/ {agg.sts.length} 个站点</span>
                  </span>
                )}
                value={agg.okSts.length}
              />
              <div style={{ minHeight: 20 }}>{null}</div>
            </ProCard>
          </ProCard>

          {/* 查询失败的站点提示（同 v1 usage-errors） */}
          {agg.errSts.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={
                <Space direction="vertical" size={2}>
                  {agg.errSts.map((s: any) => (
                    <span key={s.id}>
                      {s.name}：{s.error}
                    </span>
                  ))}
                </Space>
              }
            />
          )}

          {/* 两张图：Token 消耗趋势 + 分模型 Token */}
          <ProCard gutter={16} wrap style={{ marginBottom: 16 }} ghost>
            <ProCard
              colSpan={{ xs: 24, lg: 14 }}
              variant="outlined"
              style={{ height: "100%" }}
              title={<CardTitle text="Token 消耗趋势" sub={`${data.granularity === "hour" ? "按小时" : "按天"}汇总`} />}
            >
              {trendEmpty ? (
                <ChartEmpty text="该范围内暂无用量数据" />
              ) : (
                <ChartBox h={CHART_H}>
                <Column
                  data={agg.buckets}
                  xField="label"
                  yField="tokens"
                  height={CHART_H}
                  theme={dark ? "classicDark" : "classic"}
                  style={{ radiusTopLeft: 4, radiusTopRight: 4, maxWidth: 24 }}
                  axis={{
                    x: { title: false },
                    y: { title: false, labelFormatter: (v: any) => fmtTokens(v) },
                  }}
                  tooltip={{ title: (d: any) => d.label, items: tipItems }}
                />
                </ChartBox>
              )}
            </ProCard>
            <ProCard
              colSpan={{ xs: 24, lg: 10 }}
              variant="outlined"
              style={{ height: "100%" }}
              title={
                <CardTitle
                  text="分模型 Token"
                  sub={agg.modelsByDate ? "Sub2API 模型明细按自然日（昨日+今日）统计" : "按用量降序，最多显示 10 项"}
                />
              }
            >
              {!modelChartItems.length ? (
                <ChartEmpty text="该范围内暂无用量数据" />
              ) : (
                <ChartBox h={CHART_H}>
                <Bar
                  data={modelChartItems}
                  xField="model"
                  yField="tokens"
                  height={CHART_H}
                  theme={dark ? "classicDark" : "classic"}
                  style={{ maxWidth: 16, radiusTopRight: 4, radiusBottomRight: 4 }}
                  axis={{
                    x: { title: false, labelFormatter: (v: any) => truncateLabel(v, 20) },
                    y: false,
                  }}
                  label={{ text: (d: any) => fmtTokens(d.tokens), position: "right", dx: 4 }}
                  tooltip={{ title: (d: any) => d.model, items: tipItems }}
                />
                </ChartBox>
              )}
            </ProCard>
          </ProCard>

          {/* 模型明细表 */}
          <ProTable
            headerTitle="模型明细"
            tooltip={false}
            toolBarRender={() => [<span key="count" style={{ color: token.colorTextSecondary }}>共 {agg.models.length} 个模型</span>]}
            search={false}
            options={false}
            pagination={false}
            size="small"
            rowKey="model"
            dataSource={agg.models}
            columns={columns as any}
            locale={{ emptyText: "该范围内暂无用量数据" }}
          />
        </>
      )}
    </PageContainer>
  );
}
