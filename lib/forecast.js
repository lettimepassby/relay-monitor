// 日消费预测：冠军-挑战者自适应选择 + 经验分位置信带
//
// 用真实数据回测（前 N 天预测第 N+1 天 vs 真实值）选型的结论：
//   - 中转站日消费噪声极大（单日 2~5 倍波动），星期因子在无周律数据上放大噪声，
//     旧「加权回归+星期因子」1 天误差 80%；
//   - 对数空间阻尼 Holt（乘性噪声 + 阻尼趋势）在真实与增长场景稳定最优（52%）；
//   - 周律类方法只有在数据真有周律时才应启用。
// 因此：默认冠军 = 对数阻尼 Holt；每次预测时在最近 14 天做内部回测，
// 周律类挑战者领先 20% 以上才切换（高门槛避免选择噪声）。
// 置信带取自被选方法内部回测的「实际/预测」比值分位数（经验带，非参数假设），
// 并把回测误差随结果返回，界面直接展示预测的真实可信度。

const r2 = (v) => Math.round(v * 100) / 100;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[idx];
};

// ---- 冠军：对数空间阻尼 Holt --------------------------------------------------
function logHolt(vals, ts, h, alpha = 0.5, beta = 0.1, phi = 0.9) {
  const lv = vals.map((v) => Math.log(v + 1));
  let level = lv[0], trend = 0;
  for (let i = 1; i < lv.length; i++) {
    const prev = level;
    level = alpha * lv[i] + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - prev) + (1 - beta) * phi * trend;
  }
  const out = [];
  let acc = 0;
  for (let k = 1; k <= h; k++) {
    acc += Math.pow(phi, k);
    out.push(Math.max(0, Math.exp(level + acc * trend) - 1));
  }
  return out;
}

// ---- 挑战者 1：加权回归 + 星期因子（强周律数据的最优解） -----------------------
function regDow(vals, ts, h) {
  const n = vals.length;
  let factors = Array(7).fill(1);
  const sum = Array(7).fill(0), cnt = Array(7).fill(0);
  vals.forEach((v, i) => { const w = new Date(ts[i]).getDay(); sum[w] += v; cnt[w]++; });
  const overall = vals.reduce((a, b) => a + b, 0) / n;
  if (overall > 0) {
    factors = sum.map((s, i) => Math.min(3, Math.max(0.3, (cnt[i] ? s / cnt[i] / overall : 1) || 1)));
  }
  const adj = vals.map((v, i) => v / factors[new Date(ts[i]).getDay()]);
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  adj.forEach((y, i) => {
    const w = Math.pow(0.92, n - 1 - i);
    sw += w; swx += w * i; swy += w * y; swxx += w * i * i; swxy += w * i * y;
  });
  const den = sw * swxx - swx * swx;
  const b = Math.abs(den) > 1e-9 ? (sw * swxy - swx * swy) / den : 0;
  const a = (swy - b * swx) / sw;
  return Array.from({ length: h }, (_, k) =>
    Math.max(0, (a + b * (n + k)) * factors[new Date(ts[n - 1] + (k + 1) * 86400000).getDay()]));
}

// ---- 挑战者 2：EWMA 水平 × 收缩星期因子（温和周律） ----------------------------
function ewmaDow(vals, ts, h, hl = 5, shrinkK = 3) {
  const alpha = 1 - Math.pow(0.5, 1 / hl);
  let level = vals[0];
  const levels = [level];
  for (let i = 1; i < vals.length; i++) {
    level = alpha * vals[i] + (1 - alpha) * level;
    levels.push(level);
  }
  const rel = Array(7).fill(0).map(() => []);
  vals.forEach((v, i) => { if (levels[i] > 0) rel[new Date(ts[i]).getDay()].push(v / levels[i]); });
  const factors = rel.map((arr) => {
    if (!arr.length) return 1;
    return (shrinkK + arr.length * median(arr)) / (shrinkK + arr.length); // 样本少时向 1 收缩
  });
  const n = vals.length;
  return Array.from({ length: h }, (_, k) =>
    Math.max(0, level * factors[new Date(ts[n - 1] + (k + 1) * 86400000).getDay()]));
}

// ---- 内部回测：混合 1 天 + 3 天累计的加权绝对百分比误差 -------------------------
function backtestScore(fn, vals, ts) {
  const start = Math.max(5, vals.length - 14);
  let e1 = 0, a1 = 0, e3 = 0, a3 = 0;
  for (let i = start; i < vals.length; i++) {
    const p = fn(vals.slice(0, i), ts.slice(0, i), 3);
    e1 += Math.abs(p[0] - vals[i]); a1 += vals[i];
    if (i + 2 < vals.length) {
      e3 += Math.abs(p[0] + p[1] + p[2] - (vals[i] + vals[i + 1] + vals[i + 2]));
      a3 += vals[i] + vals[i + 1] + vals[i + 2];
    }
  }
  return {
    score: (a1 > 0 ? e1 / a1 : 9) + (a3 > 0 ? e3 / a3 : 9),
    wape1: a1 > 0 ? e1 / a1 : null,
  };
}

// 被选方法在内部回测窗口的「实际/预测」比值（经验置信带的原料）
function backtestRatios(fn, vals, ts) {
  const start = Math.max(5, vals.length - 14);
  const ratios = [];
  for (let i = start; i < vals.length; i++) {
    const p = fn(vals.slice(0, i), ts.slice(0, i), 1)[0];
    if (p > 0.01) ratios.push(vals[i] / p);
  }
  return ratios;
}

const METHOD_LABEL = {
  "log-holt": "阻尼指数趋势",
  "reg-dow": "加权回归 + 星期因子",
  "ewma-dow": "均线 + 星期因子",
};

/**
 * 小时级预测：小时画像（每个钟点的中位消费）× 近期水平缩放。
 * 回测选型结论：昼夜规律强的数据上，24 小时总量误差比日级方法更低
 *（真实数据 38% vs 日级 46%）；持续性/混合法都更差。
 *
 * @param points [{t: 整点 ms, cost}] 升序、缺时补 0、不含当前未完小时
 * @param hodOf (ms) => 0-23，调用方提供时区感知的“当地钟点”函数
 * @param horizon 预测小时数
 * @returns { points:[{t,cost,lo,hi}], next24Total, backtestWapePct } 或 null
 */
export function forecastHourly(points, hodOf, horizon = 24) {
  const n = points.length;
  if (n < 72) return null; // 至少 3 天小时数据

  const fit = (vals, ts) => {
    // 画像：近 7 天每个钟点的中位数与分位（不足 7 天用全部）
    const cut = ts[ts.length - 1] - 7 * 86400000;
    const byH = Array(24).fill(0).map(() => []);
    for (let i = 0; i < vals.length; i++) if (ts[i] >= cut) byH[hodOf(ts[i])].push(vals[i]);
    const prof = byH.map((a) => median(a));
    const profSum = prof.reduce((a, b) => a + b, 0);
    // 水平：近 48 小时均值折算成日总量
    const lvCut = ts[ts.length - 1] - 48 * 3600000;
    let recent = 0, hours = 0;
    for (let i = 0; i < vals.length; i++) if (ts[i] >= lvCut) { recent += vals[i]; hours++; }
    const dailyLevel = hours > 0 ? (recent / hours) * 24 : profSum;
    const scale = profSum > 1e-9 ? dailyLevel / profSum : 0;
    return { prof, byH, scale };
  };

  const vals = points.map((p) => p.cost);
  const ts = points.map((p) => p.t);
  const { prof, byH, scale } = fit(vals, ts);

  const lastT = ts[n - 1];
  const out = [];
  for (let k = 1; k <= horizon; k++) {
    const t = lastT + k * 3600000;
    const h = hodOf(t);
    const p = Math.max(0, prof[h] * scale);
    const qlo = quantile(byH[h].length ? byH[h] : [0], 0.2) * scale;
    const qhi = quantile(byH[h].length ? byH[h] : [0], 0.8) * scale;
    out.push({ t, cost: r2(p), lo: r2(Math.min(qlo, p)), hi: r2(Math.max(qhi, p * 1.2)) });
  }

  // 内部回测：每 6 小时一个测试点，评估未来 24 小时总量误差
  let esum = 0, asum = 0;
  for (let i = Math.max(72, n - 7 * 24); i + 24 <= n; i += 6) {
    const f = fit(vals.slice(0, i), ts.slice(0, i));
    let ps = 0, as = 0;
    for (let k = 0; k < 24; k++) {
      ps += Math.max(0, f.prof[hodOf(ts[i] + (k + 1) * 3600000)] * f.scale);
      as += vals[i + k];
    }
    esum += Math.abs(ps - as); asum += as;
  }

  return {
    points: out,
    next24Total: r2(out.slice(0, 24).reduce((a, p) => a + p.cost, 0)),
    backtestWapePct: asum > 0 ? Math.round((esum / asum) * 100) : null,
  };
}

/**
 * @param daily [{t: 当日零点 ms, cost: 当日消费}] 升序、缺日补 0、不含今天
 * @param horizon 预测天数
 * @returns { points:[{t,cost,lo,hi}], nextTotal, method, sampleDays, backtestWapePct } 或 null
 */
export function forecastDaily(daily, horizon = 7) {
  const n = daily.length;
  if (n < 3) return null;
  const vals = daily.map((d) => d.cost);
  const ts = daily.map((d) => d.t);

  // 冠军-挑战者选型：挑战者需在内部回测领先 20% 才切换
  let pick = "log-holt";
  let fn = logHolt;
  let champ = { score: Infinity, wape1: null };
  if (n >= 8) {
    champ = backtestScore(logHolt, vals, ts);
    if (n >= 14) {
      for (const [name, cand] of [["reg-dow", regDow], ["ewma-dow", ewmaDow]]) {
        const s = backtestScore(cand, vals, ts);
        if (s.score < champ.score * 0.8) { pick = name; fn = cand; champ = s; break; }
      }
    }
  }

  const preds = fn(vals, ts, horizon);

  // 经验置信带：比值分位（15%~85%），随预测距离温和加宽；样本不足退回 ±40%
  const ratios = n >= 8 ? backtestRatios(fn, vals, ts) : [];
  let qlo = 0.6, qhi = 1.4;
  if (ratios.length >= 5) {
    qlo = Math.min(1, Math.max(0.15, quantile(ratios, 0.15)));
    qhi = Math.max(1, Math.min(4, quantile(ratios, 0.85)));
  }
  const lastT = ts[n - 1];
  const points = preds.map((p, i) => {
    const k = i + 1;
    const widen = Math.min(Math.sqrt(k), 1.8); // 远期更不确定，但别无限扩张
    return {
      t: lastT + k * 86400000,
      cost: r2(p),
      lo: r2(Math.max(0, p * (1 - (1 - qlo) * widen))),
      hi: r2(p * (1 + (qhi - 1) * widen)),
    };
  });

  const nextTotal = r2(points.reduce((a, p) => a + p.cost, 0));
  return {
    points,
    nextTotal,
    // 合计的区间用 1 天分位（多日求和会平均掉单日噪声，不再随距离加宽）
    nextLo: r2(nextTotal * qlo),
    nextHi: r2(nextTotal * qhi),
    method: METHOD_LABEL[pick] || pick,
    sampleDays: n,
    backtestWapePct: champ.wape1 != null ? Math.round(champ.wape1 * 100) : null,
  };
}
