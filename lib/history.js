// 余额历史快照 + 耗尽预测（线性回归）
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_POINTS = 5000; // 每站上限
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 保留 30 天
const MIN_GAP_MS = 30 * 1000; // 相邻快照最小间隔
const TOPUP_EPSILON = 0.05; // 余额上升超过该值视为充值，回归只取充值之后的段

export class History {
  constructor(file) {
    this.file = file;
    // { stationId: [[t, remaining, used], ...] } 按时间升序
    this.data = {};
    this._saveTimer = null;
  }

  async load() {
    try {
      this.data = JSON.parse(await readFile(this.file, "utf8"));
      if (typeof this.data !== "object" || !this.data) this.data = {};
    } catch {
      this.data = {};
    }
    return this;
  }

  // 合并写盘，避免每 60 秒全量写多次；临时文件 + rename 原子替换，
  // 进程在写一半时被杀不会留下损坏的 history.json
  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = this.file + ".tmp";
        await writeFile(tmp, JSON.stringify(this.data), "utf8");
        await rename(tmp, this.file);
      } catch {}
    }, 1500);
  }

  append(stationId, remaining, used) {
    if (!Number.isFinite(remaining)) return;
    const arr = (this.data[stationId] ||= []);
    const now = Date.now();
    const last = arr[arr.length - 1];
    if (last && now - last[0] < MIN_GAP_MS) return;
    arr.push([now, Math.round(remaining * 10000) / 10000, Math.round((used || 0) * 10000) / 10000]);
    // 裁剪
    const cutoff = now - MAX_AGE_MS;
    while (arr.length > MAX_POINTS || (arr.length && arr[0][0] < cutoff)) arr.shift();
    this.scheduleSave();
  }

  remove(stationId) {
    delete this.data[stationId];
    this.scheduleSave();
  }

  /**
   * 自某时刻起的实际消耗：累加相邻快照间的余额下降（上升视为充值，忽略）。
   * 基线取 since 之前的最后一个快照；面板离线期间的消耗会在下一个快照补上。
   */
  usedSince(stationId, sinceTs) {
    const arr = this.data[stationId] || [];
    if (arr.length < 2) return 0;
    let start = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i][0] <= sinceTs) start = i;
    let used = 0;
    for (let i = start + 1; i < arr.length; i++) {
      const drop = arr[i - 1][1] - arr[i][1];
      if (drop > 0) used += drop;
    }
    return Math.round(used * 100) / 100;
  }

  // 站点卡片迷你走势图用：等距抽样到 maxPoints 个点，保留最后一个点
  sparkline(stationId, hours = 48, maxPoints = 40) {
    const pts = this.points(stationId, hours);
    if (pts.length <= maxPoints) return pts.map((p) => [p[0], p[1]]);
    const step = pts.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) {
      const p = pts[Math.floor(i * step)];
      out.push([p[0], p[1]]);
    }
    const last = pts[pts.length - 1];
    if (out[out.length - 1][0] !== last[0]) out.push([last[0], last[1]]);
    return out;
  }

  points(stationId, hours = 72) {
    const arr = this.data[stationId] || [];
    const cutoff = Date.now() - hours * 3600 * 1000;
    return arr.filter((p) => p[0] >= cutoff);
  }

  /**
   * 耗尽预测。
   * 只回归最近一次「充值」之后的数据段（余额显著上升视为充值），
   * 窗口默认取最近 48 小时，至少需要 3 个点且时间跨度 ≥ 10 分钟。
   * 返回 { burnPerDay, etaDays, etaAt, samples, spanHours } 或 null（数据不足/无消耗）。
   */
  predict(stationId, windowHours = 48) {
    const all = this.data[stationId] || [];
    const cutoff = Date.now() - windowHours * 3600 * 1000;
    let pts = all.filter((p) => p[0] >= cutoff);
    if (pts.length < 3) pts = all.slice(-50); // 窗口内不足则退回最近 50 个点
    if (pts.length < 3) return null;

    // 截断到最近一次充值之后
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][1] > pts[i - 1][1] + TOPUP_EPSILON) start = i;
    }
    pts = pts.slice(start);
    if (pts.length < 3) return null;

    const spanMs = pts[pts.length - 1][0] - pts[0][0];
    if (spanMs < 10 * 60 * 1000) return null; // 跨度太短，预测无意义

    // 最小二乘：remaining = a + b * t
    const t0 = pts[0][0];
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    const n = pts.length;
    for (const [t, r] of pts) {
      const x = (t - t0) / 3600000; // 小时
      sx += x; sy += r; sxx += x * x; sxy += x * r;
    }
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) return null;
    const slope = (n * sxy - sx * sy) / denom; // $/小时

    const burnPerDay = slope < 0 ? -slope * 24 : 0;
    const latest = pts[pts.length - 1];
    const remaining = latest[1];

    if (burnPerDay < 0.0001) {
      return { burnPerDay: 0, etaDays: null, etaAt: null, samples: n, spanHours: spanMs / 3600000 };
    }
    const etaDays = remaining / burnPerDay;
    return {
      burnPerDay: Math.round(burnPerDay * 100) / 100,
      etaDays: Math.round(etaDays * 10) / 10,
      etaAt: new Date(latest[0] + etaDays * 86400000).toISOString(),
      samples: n,
      spanHours: Math.round((spanMs / 3600000) * 10) / 10,
    };
  }
}
