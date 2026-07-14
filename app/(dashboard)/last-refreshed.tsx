"use client";
// 页面级「最近刷新时间」：数据页每次轮询成功后更新。
// 显示的是本页最近一次成功拉取数据的时刻；上游余额的实际查询节奏
// 由服务端按「设置 → 自动刷新间隔」执行，两者不是一回事。
import { Typography, theme } from "antd";
import { SyncOutlined } from "@ant-design/icons";

const { Text } = Typography;

function fmt(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function LastRefreshed({ at }: { at: number | null }) {
  const { token } = theme.useToken();
  if (!at) return null;
  return (
    <Text type="secondary" style={{ fontSize: token.fontSizeSM, whiteSpace: "nowrap" }}>
      <SyncOutlined style={{ marginRight: 4 }} />
      最近刷新 {fmt(at)}
    </Text>
  );
}
