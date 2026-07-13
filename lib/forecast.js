// 日消费预测：加权线性趋势 + 星期因子 + 残差置信带
//
// 方法（可解释优先，不上黑盒）：
//   1. 数据满两周时计算星期因子（周末/工作日消费模式差异），先去季节化
//   2. 对去季节序列做指数加权最小二乘（近期权重大，w = 0.92^age），
//      拟合线性趋势 y = a + b·i
//   3. 预测值 = 趋势外推 × 当天星期因子；置信带用加权残差标准差的
//      ±1.28σ（约 80% 区间），随预测距离增宽

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * @param daily [{t: 当日零点 ms, cost: 当日消费}] 升序、无缺日（缺日补 0）
 * @param horizon 预测天数
 * @returns { points: [{t, cost, lo, hi}], nextTotal, method, sampleDays } 或 null（数据不足）
 */
export function forecastDaily(daily, horizon = 7) {
  const n = daily.length;
  if (n < 3) return null;

  const vals = daily.map((d) => d.cost);

  // 星期因子（不足两周不启用，避免小样本过拟合）
  let factors = Array(7).fill(1);
  if (n >= 14) {
    const sum = Array(7).fill(0), cnt = Array(7).fill(0);
    for (const d of daily) {
      const w = new Date(d.t).getDay();
      sum[w] += d.cost; cnt[w]++;
    }
    const overall = vals.reduce((a, b) => a + b, 0) / n;
    if (overall > 0) {
      factors = sum.map((s, i) => {
        const f = cnt[i] ? s / cnt[i] / overall : 1;
        return Math.min(3, Math.max(0.3, f || 1)); // 极端因子截断
      });
    }
  }

  // 去季节 + 指数加权线性回归
  const adj = daily.map((d) => d.cost / factors[new Date(d.t).getDay()]);
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  adj.forEach((y, i) => {
    const w = Math.pow(0.92, n - 1 - i);
    sw += w; swx += w * i; swy += w * y; swxx += w * i * i; swxy += w * i * y;
  });
  const denom = sw * swxx - swx * swx;
  const b = Math.abs(denom) > 1e-9 ? (sw * swxy - swx * swy) / denom : 0;
  const a = (swy - b * swx) / sw;

  let rss = 0;
  adj.forEach((y, i) => {
    const e = y - (a + b * i);
    rss += Math.pow(0.92, n - 1 - i) * e * e;
  });
  const sigma = Math.sqrt(rss / sw);

  const lastT = daily[n - 1].t;
  const points = [];
  for (let k = 1; k <= horizon; k++) {
    const t = lastT + k * 86400000;
    const f = factors[new Date(t).getDay()];
    const base = Math.max(0, (a + b * (n - 1 + k)) * f);
    const spread = 1.28 * sigma * f * Math.sqrt(1 + k * 0.15); // 越远越不确定
    points.push({ t, cost: r2(base), lo: r2(Math.max(0, base - spread)), hi: r2(base + spread) });
  }
  return {
    points,
    nextTotal: r2(points.reduce((x, p) => x + p.cost, 0)),
    method: n >= 14 ? "加权线性趋势 + 星期因子" : "加权线性趋势",
    sampleDays: n,
  };
}
