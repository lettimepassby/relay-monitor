"use client";
// 余额趋势详情弹窗（共享组件）：总览页与中转站页点击站点行时打开
// 从 stations/page.tsx 提取（v1 openTrend/drawChart 平移）：KPI 行 + 范围切换 +
// 历史实线 / 虚线耗尽投影；数据拉取 GET /api/stations/:id/history?hours=
import { useEffect, useMemo, useRef, useState } from "react";
import { Col, Modal, Row, Segmented, Spin, Statistic, theme } from "antd";
import { Line } from "@ant-design/plots";
import ChartBox from "./chart-box";
import { api, cny, usd, rateOf, fmtTokens, fmtEta } from "../../lib/client";
import { useThemeMode } from "../providers";

// 图表本体固定高度（与提取前 stations 页一致）
const CHART_H = 280;
// 语义色（antd 色板值，两种主题下都可读）；中性色一律走 token
const COLOR = { warn: "#faad14", danger: "#ff4d4f" };

// 范围切换选项（v1 RANGES）
const RANGES = [
  { label: "24 小时", value: 24 },
  { label: "3 天", value: 72 },
  { label: "7 天", value: 168 },
  { label: "30 天", value: 720 },
];

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
      height: CHART_H,
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
      <div style={{ height: CHART_H, display: "flex", alignItems: "center", justifyContent: "center", color: token.colorTextSecondary }}>
        数据点不足（需要至少两次成功查询），稍后再来看看
      </div>
    );
  return (
    <ChartBox h={CHART_H}>
      <Line {...cfg} />
    </ChartBox>
  );
}

// ---- 弹窗本体（v1 openTrend 平移，外加范围切换）-------------------------------
// station 为 null 时不渲染（弹窗关闭）；传入列表里的最新站点对象，KPI 随轮询更新
export default function TrendModal({
  station,
  onClose,
  etaDaysRule = 3,
}: {
  station: any | null;
  onClose: () => void;
  etaDaysRule?: number;
}) {
  const { token } = theme.useToken();
  const hint: React.CSSProperties = { fontSize: 12, color: token.colorTextSecondary, marginTop: 4, lineHeight: 1.6 };

  const [hours, setHours] = useState(72);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0); // 丢弃过期响应：快速切换站点/范围时慢的那次不能覆盖后打开的图
  const stationId = station?.id ?? null;

  // 打开（或换站点）时重置范围与数据（同提取前 openTrend）
  useEffect(() => {
    if (!stationId) return;
    setHours(72);
    setData(null);
    setErr("");
  }, [stationId]);

  useEffect(() => {
    if (!stationId) return;
    const s = ++seq.current;
    setLoading(true);
    setErr("");
    api(`/api/stations/${stationId}/history?hours=${hours}`)
      .then((r) => {
        if (s !== seq.current) return;
        setData(r);
      })
      .catch((e) => {
        if (s !== seq.current) return;
        setData(null);
        setErr(e.message);
      })
      .finally(() => {
        if (s === seq.current) setLoading(false);
      });
  }, [stationId, hours]);

  const rate = station ? rateOf(station) : 1;
  const pred = data?.prediction;
  const eta = etaText(pred, rate, etaDaysRule);

  return (
    <Modal
      title={station ? `余额趋势 · ${station.name}` : ""}
      open={!!station}
      onCancel={() => { seq.current++; onClose(); }}
      footer={null}
      width={760}
    >
      {station && (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
            <Col xs={12} sm={6}>
              <Statistic
                title="当前余额"
                value={station.balance?.ok ? cny(station.balance.remaining * rate) : "—"}
              />
              {station.balance?.ok && rate !== 1 ? (
                <div style={hint}>站点余额 {usd(station.balance.remaining)}</div>
              ) : null}
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="今日消耗"
                value={
                  station.todayUsed != null
                    ? (station.todayIsEstimate ? "≈ " : "") + cny(station.todayUsed * rate)
                    : "—"
                }
              />
              {station.todayTokens != null || station.todayRequests != null ? (
                <div style={hint}>
                  {[
                    station.todayTokens != null ? fmtTokens(station.todayTokens) + " tokens" : null,
                    station.todayRequests != null ? station.todayRequests.toLocaleString("en-US") + " 次" : null,
                  ].filter(Boolean).join(" · ")}
                </div>
              ) : null}
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="日均消耗（估算）"
                value={pred?.burnPerDay > 0 ? cny(pred.burnPerDay * rate) : "—"}
              />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="预计耗尽"
                value={pred?.etaDays != null ? fmtEta(pred.etaDays) : "—"}
                valueStyle={eta?.cls ? { color: eta.cls === "danger" ? COLOR.danger : COLOR.warn } : undefined}
              />
            </Col>
          </Row>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8, overflowX: "auto" }}>
            <Segmented options={RANGES} value={hours} onChange={(v) => setHours(Number(v))} />
          </div>
          <Spin spinning={loading}>
            {err ? (
              <div style={{ height: CHART_H, display: "flex", alignItems: "center", justifyContent: "center", color: token.colorTextSecondary }}>
                {err}
              </div>
            ) : data ? (
              // 图表纵轴按充值汇率折算成 ¥（耗尽时间等预测不受影响，同 v1）
              <TrendChart
                points={(data.points || []).map((p: any) => [p[0], p[1] * rate])}
                prediction={pred ? { ...pred, burnPerDay: pred.burnPerDay * rate } : pred}
              />
            ) : (
              <div style={{ height: CHART_H }} />
            )}
          </Spin>
        </>
      )}
    </Modal>
  );
}
