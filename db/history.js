// 余额历史快照 + 耗尽预测：算法与 v1（lib/history.js）逐字一致。
// 持久层从 JSON 文件换成 MySQL history_points 表：内存缓存全量热数据（30 天），
// append 写内存 + 攒批写透 DB；usedSince/burnRate/predict 读内存，语义不变。
// 落表的关系行同时供「经营分析」页做 SQL 聚合（热力图/趋势等）。
const MAX_POINTS = 5000; // 每站上限
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 保留 30 天
const MIN_GAP_MS = 30 * 1000; // 相邻快照最小间隔
const TOPUP_EPSILON = 0.05; // 余额上升超过该值视为充值，回归只取充值之后的段

export class History {
  constructor(pool) {
    this.pool = pool;
    // { stationId: [[t, remaining, used], ...] } 按时间升序
    this.data = {};
    this._saveTimer = null;
    this._pending = []; // 待写透的行 [stationId, t, remaining, used]
    this._removed = new Set(); // 待删除的站点
  }

  async load() {
    // 只载入保留窗口内的点；DB 错误直接抛出中止启动（不静默吞掉）
    const cutoff = Date.now() - MAX_AGE_MS;
    const [rows] = await this.pool.query(
      "SELECT station_id, t, remaining, used FROM history_points WHERE t >= ? ORDER BY station_id, t",
      [cutoff]
    );
    this.data = {};
    for (const r of rows) {
      (this.data[r.station_id] ||= []).push([Number(r.t), r.remaining, r.used]);
    }
    // 内存热态与 v1 语义一致：每站只留最近 MAX_POINTS 个点（端点返回逐点一致）；
    // DB 里保留完整 30 天，供经营分析 SQL 聚合使用
    for (const id of Object.keys(this.data)) {
      const arr = this.data[id];
      if (arr.length > MAX_POINTS) this.data[id] = arr.slice(arr.length - MAX_POINTS);
    }
    return this;
  }

  // 合并写透，避免每 60 秒逐行写多次；失败重试交给下一批（内存仍是权威热态）
  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      const batch = this._pending; this._pending = [];
      const removed = [...this._removed]; this._removed.clear();
      try {
        if (removed.length) {
          await this.pool.query("DELETE FROM history_points WHERE station_id IN (?)", [removed]);
        }
        if (batch.length) {
          await this.pool.query(
            "INSERT IGNORE INTO history_points (station_id, t, remaining, used) VALUES ?",
            [batch]
          );
        }
        // 裁剪窗口外旧数据（与内存裁剪同一口径）
        await this.pool.query("DELETE FROM history_points WHERE t < ?", [Date.now() - MAX_AGE_MS]);
      } catch (err) {
        // 写透失败：把批次放回队列，等下一次 scheduleSave 重试
        this._pending.unshift(...batch);
        for (const id of removed) this._removed.add(id);
        console.error("历史写库失败:", err?.message);
      }
    }, 1500);
  }

  append(stationId, remaining, used) {
    if (!Number.isFinite(remaining)) return;
    const arr = (this.data[stationId] ||= []);
    const now = Date.now();
    const last = arr[arr.length - 1];
    if (last && now - last[0] < MIN_GAP_MS) return;
    const point = [now, Math.round(remaining * 10000) / 10000, Math.round((used || 0) * 10000) / 10000];
    arr.push(point);
    this._pending.push([stationId, point[0], point[1], point[2]]);
    // 裁剪
    const cutoff = now - MAX_AGE_MS;
    while (arr.length > MAX_POINTS || (arr.length && arr[0][0] < cutoff)) arr.shift();
    this.scheduleSave();
  }

  remove(stationId) {
    delete this.data[stationId];
    this._removed.add(stationId);
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

  // 某窗口内的实际消耗速率（$/天）：余额下降求和 ÷ 实际跨度。
  // 上升视为充值自动忽略；跨度不足 minSpanH 或点太少返回 null
  burnRate(stationId, windowHours, minSpanH = 1, minPoints = 5) {
    const arr = this.data[stationId] || [];
    const cutoff = Date.now() - windowHours * 3600 * 1000;
    const seg = arr.filter((p) => p[0] >= cutoff);
    if (seg.length < minPoints) return null;
    const spanH = (seg[seg.length - 1][0] - seg[0][0]) / 3600000;
    if (spanH < minSpanH) return null;
    let drop = 0;
    for (let i = 1; i < seg.length; i++) {
      const d = seg[i - 1][1] - seg[i][1];
      if (d > 0) drop += d;
    }
    return { burnPerDay: (drop / spanH) * 24, samples: seg.length, spanHours: spanH };
  }

  /**
   * 耗尽预测——按「实时速率」分层估计：
   *   1. 近 3 小时实际消耗速率（提速/降速 3 小时内即反映到 ETA）
   *   2. 数据不足退近 12 小时
   *   3. 再不足退回充值截断后的 48 小时最小二乘回归（冷启动兜底）
   * 回测依据：合成提速场景下旧 48h 等权回归把 ¥48/天 稀释成 ¥5.4/天
   *（ETA 偏差 10 倍），近窗实际速率精确命中；真实数据上两者误差相当。
   * 返回 { burnPerDay, etaDays, etaAt, basis, samples, spanHours } 或 null。
   */
  predict(stationId, windowHours = 48) {
    const all = this.data[stationId] || [];
    if (all.length < 3) return null;
    const latest = all[all.length - 1];

    let est = this.burnRate(stationId, 3, 1, 5);
    let basis = "近3小时";
    if (!est) { est = this.burnRate(stationId, 12, 2, 5); basis = "近12小时"; }
    if (!est) {
      // 冷启动兜底：充值截断后的窗口回归
      const cutoff = Date.now() - windowHours * 3600 * 1000;
      let pts = all.filter((p) => p[0] >= cutoff);
      if (pts.length < 3) pts = all.slice(-50);
      let start = 0;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i][1] > pts[i - 1][1] + TOPUP_EPSILON) start = i;
      }
      pts = pts.slice(start);
      if (pts.length < 3) return null;
      const spanMs = pts[pts.length - 1][0] - pts[0][0];
      if (spanMs < 10 * 60 * 1000) return null;
      const t0 = pts[0][0];
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      const n = pts.length;
      for (const [t, r] of pts) {
        const x = (t - t0) / 3600000;
        sx += x; sy += r; sxx += x * x; sxy += x * r;
      }
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) < 1e-9) return null;
      const slope = (n * sxy - sx * sy) / denom;
      est = { burnPerDay: slope < 0 ? -slope * 24 : 0, samples: n, spanHours: spanMs / 3600000 };
      basis = "回归";
    }

    const burnPerDay = est.burnPerDay;
    if (burnPerDay < 0.0001) {
      return { burnPerDay: 0, etaDays: null, etaAt: null, basis, samples: est.samples, spanHours: Math.round(est.spanHours * 10) / 10 };
    }
    const etaDays = latest[1] / burnPerDay;
    return {
      burnPerDay: Math.round(burnPerDay * 100) / 100,
      etaDays: Math.round(etaDays * 10) / 10,
      etaAt: new Date(latest[0] + etaDays * 86400000).toISOString(),
      basis,
      samples: est.samples,
      spanHours: Math.round(est.spanHours * 10) / 10,
    };
  }
}
