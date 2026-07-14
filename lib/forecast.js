// 消费预测：组合冠军 + 逐视界 conformal 经验区间
//
// v1.15.0 用 60 天真实数据（1439 小时点）滚动回测重新选型的结论：
//   日级——单模型对数阻尼 Holt 在趋势段最优但在震荡段崩坏（早期段 WAPE 92%），
//   四模型等权组合（Holt/Theta/中位/均线）在全部时间段稳定（全窗 1天 58%/7天 70%，
//   旧冠军 62%/82%）；岭回归等 ML 方法在几十个日样本上过拟合，全面落后。
//   区间——旧「1天比值分位×√k 加宽」逐日覆盖 62% 但宽度 2.76×实际；
//   逐视界 conformal（名义 80%）覆盖 71% 且宽度 2.01×，7 天合计区间单独用
//   7 日累计比值校准（多日求和平均掉单日噪声），覆盖 42%→52%、宽度 1.74×→1.30×。
//   小时级——总量的最大改进来自抗尖峰：近 5 个滚动日总量的中位数把 24h 总量
//   WAPE 从 70% 压到 60%（尖峰日免疫）；形状用递归加权画像（半衰期 3 天）比
//   7 天等权中位画像的逐小时 WAPE 低 3~13 个百分点；conformal 区间在覆盖率持平
//   的情况下把宽度从 2.60× 压到 1.55×。ridge/GBDT 形状略优但总量偏差大，不值得引入。
// 星期因子类模型依旧只作挑战者（需内部回测领先 20% 才切换，历史证明周律弱时有害）。

const r2 = (v) => Math.round(v * 100) / 100;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
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

// ---- 基模型：对数空间阻尼 Holt（乘性噪声 + 阻尼趋势） --------------------------
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

// ---- 基模型：log 空间 Theta（SES 水平 + 半强度整体趋势） -----------------------
function thetaLog(vals, ts, h) {
  const lv = vals.map((v) => Math.log(v + 1));
  const n = lv.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  lv.forEach((y, i) => { sx += i; sy += y; sxx += i * i; sxy += i * y; });
  const den = n * sxx - sx * sx;
  const b = Math.abs(den) > 1e-9 ? (n * sxy - sx * sy) / den : 0;
  let level = lv[0];
  for (let i = 1; i < n; i++) level = 0.4 * lv[i] + 0.6 * level;
  return Array.from({ length: h }, (_, k) => Math.max(0, Math.exp(level + 0.5 * b * (k + 1)) - 1));
}

// ---- 基模型：EWMA 水平平推 / 近 7 天中位数平推 --------------------------------
function ewmaFlat(vals, ts, h, hl = 10) {
  const alpha = 1 - Math.pow(0.5, 1 / hl);
  let level = vals[0];
  for (let i = 1; i < vals.length; i++) level = alpha * vals[i] + (1 - alpha) * level;
  return Array(h).fill(level);
}
const med7Flat = (vals, ts, h) => Array(h).fill(median(vals.slice(-7)));

// ---- 冠军：四模型等权组合（趋势段跟得上、震荡段拖不垮） ------------------------
function ens4(vals, ts, h) {
  const ps = [logHolt(vals, ts, h), thetaLog(vals, ts, h), med7Flat(vals, ts, h), ewmaFlat(vals, ts, h)];
  return ps[0].map((_, i) => (ps[0][i] + ps[1][i] + ps[2][i] + ps[3][i]) / 4);
}

// ---- 挑战者：加权回归 + 星期因子（强周律数据的最优解） -----------------------
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

// ---- 挑战者：EWMA 水平 × 收缩星期因子（温和周律） ----------------------------
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

const METHOD_LABEL = {
  ens4: "四模型组合",
  "reg-dow": "加权回归 + 星期因子",
  "ewma-dow": "均线 + 星期因子",
};

/**
 * 逐视界 conformal 校准：对最近 maxOrigins 个历史原点重放被选方法，
 * 收集各视界 k 的「实际/预测」比值分位 + 7 日累计比值分位。
 * 名义覆盖 80%（10/90 分位）；某视界样本 <8 时借全部视界的样本。
 */
function dailyConformal(fn, vals, ts, h, maxOrigins = 28) {
  const n = vals.length;
  const start = Math.max(5, n - maxOrigins);
  const byK = Array(h).fill(0).map(() => []);
  const sumRatios = [];
  for (let i = start; i < n; i++) {
    const hh = Math.min(h, n - i);
    const p = fn(vals.slice(0, i), ts.slice(0, i), hh);
    for (let k = 0; k < hh; k++) {
      if (p[k] > 0.01) byK[k].push(vals[i + k] / p[k]);
    }
    if (i + h <= n) {
      const ps = p.reduce((a, b) => a + b, 0);
      const as = vals.slice(i, i + h).reduce((a, b) => a + b, 0);
      if (ps > 0.01) sumRatios.push(as / ps);
    }
  }
  const all = byK.flat();
  const perK = byK.map((arr) => {
    const src = arr.length >= 8 ? arr : all;
    if (src.length < 5) return null; // 样本太少交给调用方兜底
    return {
      lo: Math.min(1, Math.max(0.05, quantile(src, 0.1))),
      hi: Math.max(1, Math.min(5, quantile(src, 0.9))),
    };
  });
  let tot = null;
  if (sumRatios.length >= 5) {
    tot = {
      lo: Math.min(1, Math.max(0.2, quantile(sumRatios, 0.1))),
      hi: Math.max(1, Math.min(3, quantile(sumRatios, 0.9))),
    };
  }
  return { perK, tot };
}

/**
 * @param daily [{t: 当日零点 ms, cost: 当日消费}] 升序、缺日补 0、不含今天
 * @param horizon 预测天数
 * @returns { points:[{t,cost,lo,hi}], nextTotal, nextLo, nextHi, method, sampleDays, backtestWapePct } 或 null
 */
export function forecastDaily(daily, horizon = 7) {
  const n = daily.length;
  if (n < 3) return null;
  const vals = daily.map((d) => d.cost);
  const ts = daily.map((d) => d.t);

  // 冠军-挑战者选型：挑战者需在内部回测领先 20% 才切换
  let pick = "ens4";
  let fn = ens4;
  let champ = { score: Infinity, wape1: null };
  if (n >= 8) {
    champ = backtestScore(ens4, vals, ts);
    if (n >= 14) {
      for (const [name, cand] of [["reg-dow", regDow], ["ewma-dow", ewmaDow]]) {
        const s = backtestScore(cand, vals, ts);
        if (s.score < champ.score * 0.8) { pick = name; fn = cand; champ = s; break; }
      }
    }
  }

  const preds = fn(vals, ts, horizon);
  const cal = n >= 8 ? dailyConformal(fn, vals, ts, horizon) : { perK: Array(horizon).fill(null), tot: null };

  const lastT = ts[n - 1];
  const points = preds.map((p, i) => {
    const q = cal.perK[i];
    if (q) return { t: lastT + (i + 1) * 86400000, cost: r2(p), lo: r2(Math.max(0, p * q.lo)), hi: r2(p * q.hi) };
    // 校准样本不足的兜底：±40% 起步、随距离温和加宽
    const widen = Math.min(Math.sqrt(i + 1), 1.8);
    return {
      t: lastT + (i + 1) * 86400000,
      cost: r2(p),
      lo: r2(Math.max(0, p * (1 - 0.4 * widen))),
      hi: r2(p * (1 + 0.4 * widen)),
    };
  });

  const nextTotal = r2(points.reduce((a, p) => a + p.cost, 0));
  return {
    points,
    nextTotal,
    // 合计区间：7 日累计比值单独校准（求和平均掉单日噪声，比逐日区间窄得多）
    nextLo: r2(nextTotal * (cal.tot ? cal.tot.lo : 0.6)),
    nextHi: r2(nextTotal * (cal.tot ? cal.tot.hi : 1.4)),
    method: METHOD_LABEL[pick] || pick,
    sampleDays: n,
    backtestWapePct: champ.wape1 != null ? Math.round(champ.wape1 * 100) : null,
  };
}

// ---- 小时级 -------------------------------------------------------------------

// 用 [0,end) 的数据预测 end 起往后 horizon 个小时（纯函数，回测与出线共用）
function hourlyPredict(vals, ts, hodOf, end, horizon) {
  const lastT = ts[end - 1];
  // 形状：近 14 天递归加权画像（半衰期 3 天，越近的日子权重越大）
  const cutT = lastT - 14 * 86400000;
  const wsum = Array(24).fill(0), vsum = Array(24).fill(0);
  for (let i = 0; i < end; i++) {
    if (ts[i] < cutT) continue;
    const w = Math.pow(0.5, (lastT - ts[i]) / 86400000 / 3);
    const h = hodOf(ts[i]);
    wsum[h] += w; vsum[h] += w * vals[i];
  }
  const prof = vsum.map((v, h) => (wsum[h] > 0 ? v / wsum[h] : 0));
  const profSum = prof.reduce((a, b) => a + b, 0);

  // 总量：近 5 个滚动日总量的中位数（尖峰日免疫）；不足 5 天用可用的整日块
  const dayTotals = [];
  for (let d = 1; d * 24 <= end && d <= 5; d++) {
    let s = 0;
    for (let i = end - d * 24; i < end - (d - 1) * 24; i++) s += vals[i];
    dayTotals.push(s);
  }
  const tot = dayTotals.length ? median(dayTotals) : profSum;

  const out = [];
  for (let k = 1; k <= horizon; k++) {
    const h = hodOf(lastT + k * 3600000);
    out.push(profSum > 1e-9 ? Math.max(0, (prof[h] / profSum) * tot) : 0);
  }
  return out;
}

/**
 * 小时级预测：递归加权小时画像出形状 × 近 5 日滚动总量中位数出总量，
 * conformal 校准逐小时区间（名义 60%，大/小预测值分桶：乘性/加性）。
 *
 * @param points [{t: 整点 ms, cost}] 升序、缺时补 0、不含当前未完小时
 * @param hodOf (ms) => 0-23，调用方提供时区感知的“当地钟点”函数
 * @param horizon 预测小时数
 * @returns { points:[{t,cost,lo,hi}], next24Total, backtestWapePct } 或 null
 */
export function forecastHourly(points, hodOf, horizon = 24) {
  const n = points.length;
  if (n < 72) return null; // 至少 3 天小时数据
  const vals = points.map((p) => p.cost);
  const ts = points.map((p) => p.t);

  const preds = hourlyPredict(vals, ts, hodOf, n, horizon);

  // conformal 校准 + 内部回测（同一批重放原点两用：区间分位 & 24h 总量 WAPE）
  const ratios = [], adds = [];
  let esum = 0, asum = 0;
  const calStart = Math.max(120, n - 14 * 24);
  for (let o = calStart; o + 24 <= n; o += 12) {
    const p = hourlyPredict(vals, ts, hodOf, o, 24);
    let ps = 0, as = 0;
    for (let k = 0; k < 24; k++) {
      const a = vals[o + k];
      ps += p[k]; as += a;
      if (p[k] > 0.5) ratios.push(a / p[k]);
      else adds.push(a - p[k]);
    }
    esum += Math.abs(ps - as); asum += as;
  }
  const rLo = ratios.length >= 20 ? Math.min(1, Math.max(0.05, quantile(ratios, 0.2))) : 0.3;
  const rHi = ratios.length >= 20 ? Math.max(1, Math.min(6, quantile(ratios, 0.8))) : 2.5;
  const aLo = adds.length >= 20 ? Math.min(0, quantile(adds, 0.2)) : -0.5;
  const aHi = adds.length >= 20 ? Math.max(0, quantile(adds, 0.8)) : 0.5;

  const lastT = ts[n - 1];
  const out = preds.map((p, i) => ({
    t: lastT + (i + 1) * 3600000,
    cost: r2(p),
    lo: r2(Math.max(0, p > 0.5 ? p * rLo : p + aLo)),
    hi: r2(p > 0.5 ? p * rHi : p + aHi),
  }));

  return {
    points: out,
    next24Total: r2(out.slice(0, 24).reduce((a, p) => a + p.cost, 0)),
    backtestWapePct: asum > 0 ? Math.round((esum / asum) * 100) : null,
  };
}
