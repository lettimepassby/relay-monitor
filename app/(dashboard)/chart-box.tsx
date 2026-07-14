"use client";
// 图表统一容器：G2(plots) 在栅格/卡片样式尚未稳定时挂载会按错误宽度首绘，
// 表现为「图表向右溢出卡片、稍后自己回弹」。此容器先用 ResizeObserver 量到
// 真实宽度（>0，即布局已稳定）再挂载图表，让 autoFit 从正确基准开始；
// minWidth:0 允许在 flex/grid 里收缩，overflow:hidden 兜底裁剪残余溢出。
import { useEffect, useRef, useState } from "react";

export default function ChartBox({ h, children }: { h: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      if (entries[0]?.contentRect.width > 0) setReady(true);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width: "100%", minWidth: 0, overflow: "hidden", height: h }}>
      {ready ? children : null}
    </div>
  );
}
