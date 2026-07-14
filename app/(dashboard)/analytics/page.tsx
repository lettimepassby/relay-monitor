"use client";
// 经营分析页（v2 新增，无 v1 对应）：从经营视角看成本/收入/利润与余额跑道。
// 数据源：GET /api/analytics?days=N（history_points SQL 聚合 + 固定摊销 + 跑道预测）；
// 收入系列客户端合并自 GET /api/own/analytics（无「我的站点」时自动隐藏收入与毛利）。
// 口径与 /api/own/analytics 的利润计算一致：成本只算上游站（isOwn 排除），¥ 按站点汇率折算。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import { Col, Empty, Row, Segmented, Statistic, Typography, theme } from "antd";
import { Bar, Column, DualAxes, Heatmap, Line, Pie } from "@ant-design/plots";
import { api, cny } from "../../../lib/client";
import { useThemeMode } from "../../providers";

const { Text } = Typography;

// 与后端 WEEKDAY() 对齐：0=周一 … 6=周日
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const r2 = (v: number) => Math.round(v * 100) / 100;
// 跑道分档色（antd 色板）：<3 天红 / <7 天黄 / 其他绿
const runwayColor = (d: number) => (d < 3 ? "#ff4d4f" : d < 7 ? "#faad14" : "#52c41a");

// 卡片内空态（数据窗口内没有任何消耗快照时）
function Blank() {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" style={{ padding: "48px 0" }} />;
}

// 窄视口下卡片标题不被 tooltip/extra 挤成竖排
function CardTitle({ children }: { children: ReactNode }) {
  return <span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>{children}</span>;
}

export default function AnalyticsPage() {
  const { dark } = useThemeMode();
  const { token } = theme.useToken();
  // plots 图表不随 ConfigProvider 算法切换，需显式跟随暗色主题
  const chartTheme = dark ? "classicDark" : "classic";
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<any>(null);
  const [own, setOwn] = useState<any>(null); // /api/own/analytics 响应（无自有站/拉取失败为 null）
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: number) => {
    try {
      const resp = await api(`/api/analytics?days=${d}`);
      setData(resp);
    } catch {
      /* 顶层错误交给下次轮询重试，页面保留旧数据 */
    }
    try {
      // 收入数据：own 端点只有 7d/30d 档，取覆盖窗口的档位后在客户端裁剪
      const o = await api(`/api/own/analytics?range=${d <= 7 ? "7d" : "30d"}`);
      setOwn(o);
    } catch {
      setOwn(null); // 未标记「我的中转站」（400）或上游失败：隐藏收入/毛利系列
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次 + 每 30 秒轮询（与面板其它页面的自动刷新节奏一致），切换范围立即重拉
  useEffect(() => {
    setLoading(true);
    load(days);
    const timer = setInterval(() => load(days), 30000);
    return () => clearInterval(timer);
  }, [days, load]);

  // ---- 派生数据 ---------------------------------------------------------------
  const derived = useMemo(() => {
    if (!data) return null;
    const upstream = data.stations.filter((s: any) => !s.isOwn);
    const upstreamIds = new Set(upstream.map((s: any) => s.id));

    // 窗口内完整日期序列（缺日补 0，图表 x 轴连续）
    const dates: string[] = [];
    {
      const [y, m, d] = String(data.start).split("-").map(Number);
      const cur = new Date(y, m - 1, d);
      for (let i = 0; i < data.days; i++) {
        dates.push(
          `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`
        );
        cur.setDate(cur.getDate() + 1);
      }
    }

    // 每日用量成本 / 固定摊销（¥，仅上游站）
    const usageBy = new Map<string, number>();
    for (const r of data.daily) {
      if (!upstreamIds.has(r.stationId)) continue;
      usageBy.set(r.date, (usageBy.get(r.date) || 0) + r.cny);
    }
    const fixedBy = new Map<string, number>();
    for (const r of data.fixedDaily) {
      if (!upstreamIds.has(r.stationId)) continue;
      fixedBy.set(r.date, (fixedBy.get(r.date) || 0) + r.cny);
    }
    const costSeries = dates.map((date) => {
      const usage = r2(usageBy.get(date) || 0);
      const fixed = r2(fixedBy.get(date) || 0);
      return { date, usage, fixed, cost: r2(usage + fixed) };
    });

    // KPI：窗口总成本 / 日均 / 峰值日 / 预计月化（日均 × 30）
    const totalCost = r2(costSeries.reduce((a, d) => a + d.cost, 0));
    const avgCost = r2(totalCost / data.days);
    const peak = costSeries.reduce((a, d) => (d.cost > a.cost ? d : a), costSeries[0]);
    const monthly = r2(avgCost * 30);

    // 日收入：own 分析只给窗口总收入（含转售 Key 重归），按每日下游消费占比摊到天。
    // 比例分摊保证收入合计与利润口径严格一致，逐日形状随消费波动。
    let incomeBy: Map<string, number> | null = null;
    if (own && own.profit && !own.profit.error && Array.isArray(own.trend)) {
      const rate = own.station?.cnyPerUsd > 0 ? own.station.cnyPerUsd : 1;
      const trendTotal = own.trend.reduce((a: number, t: any) => a + t.cost, 0);
      if (trendTotal > 0) {
        const ratio = own.profit.incomeCny / (trendTotal * rate);
        incomeBy = new Map();
        for (const t of own.trend) {
          const dt = new Date(t.t);
          const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
          incomeBy.set(key, r2((incomeBy.get(key) || 0) + t.cost * rate * ratio));
        }
      }
    }

    // 图 1：收支柱（长表）+ 毛利线
    const cashCols: any[] = [];
    const profitLine: any[] = [];
    for (const d of costSeries) {
      cashCols.push({ date: d.date, type: "成本", cny: d.cost });
      if (incomeBy) {
        const inc = incomeBy.get(d.date) || 0;
        cashCols.push({ date: d.date, type: "收入", cny: inc });
        profitLine.push({ date: d.date, type: "毛利", cny: r2(inc - d.cost) });
      }
    }

    // 图 2：星期 × 小时 热力矩阵（补全 7×24 空格）
    const heatBy = new Map((data.heatmap || []).map((h: any) => [`${h.weekday}|${h.hour}`, h.cny]));
    const heat: any[] = [];
    for (let w = 0; w < 7; w++) {
      for (let h = 0; h < 24; h++) {
        heat.push({ weekday: WEEKDAYS[w], hour: String(h).padStart(2, "0"), cny: Number(heatBy.get(`${w}|${h}`) || 0) });
      }
    }

    // 图 3：站点成本占比（用量 + 固定摊销，仅有成本的站）
    const pie = upstream
      .map((s: any) => ({ name: s.name, cny: r2(s.totalCny + s.fixedCny) }))
      .filter((x: any) => x.cny > 0)
      .sort((a: any, b: any) => b.cny - a.cny);

    // 图 4：余额跑道（全部站点，剩余天数升序，最紧急在最上面）
    const runway = data.stations
      .filter((s: any) => s.runway && s.runway.etaDays != null)
      .map((s: any) => ({ name: s.name, etaDays: s.runway.etaDays, burnPerDay: s.runway.burnPerDay }))
      .sort((a: any, b: any) => a.etaDays - b.etaDays);

    // 图 5：固定 vs 用量堆叠（长表）
    const stacked: any[] = [];
    for (const d of costSeries) {
      stacked.push({ date: d.date, type: "用量成本", cny: d.usage });
      stacked.push({ date: d.date, type: "固定摊销", cny: d.fixed });
    }

    // 图 6：累计消耗
    let acc = 0;
    const cumulative = costSeries.map((d) => ({ date: d.date, cny: (acc = r2(acc + d.cost)) }));

    // 历史覆盖天数：余额历史累积不足窗口时（如刚迁移），成本侧偏低——显式标注避免误读
    const coveredDays = costSeries.filter((d) => d.usage > 0).length;
    const hasData = data.daily.length > 0 || data.fixedDaily.length > 0;
    return { costSeries, totalCost, avgCost, peak, monthly, cashCols, profitLine, heat, pie, runway, stacked, cumulative, hasIncome: !!incomeBy, hasData, coveredDays };
  }, [data, own]);

  const yAxisCny = { y: { labelFormatter: (v: number) => `¥${v}` } };
  const tooltipCny = { items: [{ channel: "y", valueFormatter: (v: number) => cny(v) }] };

  return (
    <PageContainer
      title="经营分析"
      subTitle="上游成本 · 下游收入 · 余额跑道"
      extra={
        <Segmented
          value={days}
          onChange={(v) => setDays(Number(v))}
          options={[
            { label: "7 天", value: 7 },
            { label: "14 天", value: 14 },
            { label: "30 天", value: 30 },
          ]}
        />
      }
    >
      {/* KPI 行：总成本 / 日均 / 峰值日 / 预计月化 */}
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <ProCard loading={loading && !data}>
            <Statistic title={`${days} 天总成本`} value={derived ? cny(derived.totalCost) : "-"} />
            {derived && derived.coveredDays < days ? (
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                余额历史覆盖 {derived.coveredDays} 天，将随运行自动补全
              </Text>
            ) : null}
          </ProCard>
        </Col>
        <Col xs={12} md={6}>
          <ProCard loading={loading && !data}>
            <Statistic title="日均成本" value={derived ? cny(derived.avgCost) : "-"} />
          </ProCard>
        </Col>
        <Col xs={12} md={6}>
          <ProCard loading={loading && !data}>
            <Statistic title="峰值日" value={derived ? cny(derived.peak?.cost ?? 0) : "-"} />
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>{derived?.peak?.date || ""}</Text>
          </ProCard>
        </Col>
        <Col xs={12} md={6}>
          <ProCard loading={loading && !data}>
            <Statistic title="预计月化成本" value={derived ? cny(derived.monthly) : "-"} />
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>按近 {days} 天日均 × 30</Text>
          </ProCard>
        </Col>
      </Row>

      {/* 图 1：收支利润趋势（无自有站时退化为成本柱） */}
      <ProCard
        title={<CardTitle>{derived?.hasIncome ? "收支利润趋势" : "成本趋势"}</CardTitle>}
        tooltip={derived?.hasIncome ? "日成本 = 上游消耗 × 汇率 + 固定摊销；日收入按下游消费占比分摊；毛利 = 收入 − 成本" : "日成本 = 上游消耗 × 汇率 + 固定摊销"}
        style={{ marginTop: 16 }}
        loading={loading && !data}
      >
        {derived && derived.hasData ? (
          <DualAxes
            height={320}
            theme={chartTheme}
            xField="date"
            legend={{ color: { position: "top" } }}
            children={[
              {
                data: derived.cashCols,
                type: "interval",
                yField: "cny",
                colorField: "type",
                group: true,
                scale: { color: { domain: derived.hasIncome ? ["成本", "收入"] : ["成本"], range: ["#1677ff", "#52c41a"] } },
                axis: yAxisCny,
                tooltip: tooltipCny,
              },
              ...(derived.hasIncome
                ? [{
                    data: derived.profitLine,
                    type: "line",
                    yField: "cny",
                    colorField: "type",
                    style: { lineWidth: 2, stroke: "#fa8c16" },
                    axis: { y: { position: "right", labelFormatter: (v: number) => `¥${v}` } },
                    scale: { y: { independent: true }, color: { range: ["#fa8c16"] } },
                    tooltip: tooltipCny,
                  }]
                : []),
            ]}
          />
        ) : (
          <Blank />
        )}
      </ProCard>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* 图 2：时段热力图 */}
        <Col xs={24} lg={14}>
          <ProCard title={<CardTitle>消耗时段热力图</CardTitle>} tooltip="星期 × 小时的消耗强度（¥），颜色越深消耗越大" loading={loading && !data}>
            {derived && derived.hasData ? (
              <Heatmap
                height={300}
                theme={chartTheme}
                data={derived.heat}
                xField="hour"
                yField="weekday"
                colorField="cny"
                mark="cell"
                // 色带交给 G2 主题默认 sequential：浅/暗两种主题下都可读，勿写死浅色端
                style={{ inset: 0.5 }}
                axis={{ x: { title: "时" }, y: { title: null } }}
                legend={{ color: { position: "bottom" } }}
                tooltip={{ items: [{ channel: "color", valueFormatter: (v: number) => cny(v) }] }}
              />
            ) : (
              <Blank />
            )}
          </ProCard>
        </Col>
        {/* 图 3：站点成本占比 */}
        <Col xs={24} lg={10}>
          <ProCard title={<CardTitle>{`站点成本占比（近 ${days} 天）`}</CardTitle>} tooltip="用量成本 + 固定摊销，¥ 口径" loading={loading && !data}>
            {derived && derived.pie.length ? (
              <Pie
                height={300}
                theme={chartTheme}
                data={derived.pie}
                angleField="cny"
                colorField="name"
                innerRadius={0.6}
                label={{ text: "name", position: "outside" }}
                legend={{ color: { position: "bottom" } }}
                tooltip={{ items: [{ channel: "y", valueFormatter: (v: number) => cny(v) }] }}
              />
            ) : (
              <Blank />
            )}
          </ProCard>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* 图 4：余额跑道 */}
        <Col xs={24} lg={10}>
          <ProCard title={<CardTitle>余额跑道（预计可用天数）</CardTitle>} tooltip="按实时消耗速率预测的耗尽天数：红 <3 天、黄 <7 天、绿 ≥7 天" loading={loading && !data}>
            {derived && derived.runway.length ? (
              <Bar
                height={Math.max(200, derived.runway.length * 44)}
                theme={chartTheme}
                data={derived.runway}
                xField="name"
                yField="etaDays"
                style={{ fill: (d: any) => runwayColor(d.etaDays), maxWidth: 24 }}
                label={{ text: (d: any) => `${d.etaDays} 天`, position: "right", dx: 4 }}
                axis={{ y: { title: "天" }, x: { title: null } }}
                tooltip={{ items: [{ channel: "y", valueFormatter: (v: number) => `${v} 天` }] }}
              />
            ) : (
              <Blank />
            )}
          </ProCard>
        </Col>
        {/* 图 5：固定成本 vs 用量成本 */}
        <Col xs={24} lg={14}>
          <ProCard title={<CardTitle>固定成本 vs 用量成本</CardTitle>} tooltip="固定摊销 = 每笔付费按 金额÷天数 摊到生效日" loading={loading && !data}>
            {derived && derived.hasData ? (
              <Column
                height={300}
                theme={chartTheme}
                data={derived.stacked}
                xField="date"
                yField="cny"
                colorField="type"
                stack
                scale={{ color: { domain: ["用量成本", "固定摊销"], range: ["#1677ff", "#faad14"] } }}
                axis={yAxisCny}
                legend={{ color: { position: "top" } }}
                tooltip={tooltipCny}
              />
            ) : (
              <Blank />
            )}
          </ProCard>
        </Col>
      </Row>

      {/* 图 6：累计消耗 */}
      <ProCard title={<CardTitle>{`累计消耗（近 ${days} 天）`}</CardTitle>} style={{ marginTop: 16 }} loading={loading && !data}>
        {derived && derived.hasData ? (
          <Line
            height={280}
            theme={chartTheme}
            data={derived.cumulative}
            xField="date"
            yField="cny"
            shapeField="smooth"
            style={{ lineWidth: 2 }}
            axis={yAxisCny}
            tooltip={tooltipCny}
          />
        ) : (
          <Blank />
        )}
      </ProCard>
    </PageContainer>
  );
}
