// 简单的 JSON 文件持久化（无需数据库）
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { hashPassword } from "./auth.js";
import { DEFAULT_RULES } from "./alerts.js";

const DEFAULT_SETTINGS = {
  refreshIntervalSec: 60, // 后台自动刷新间隔
  lowBalanceUsd: 5, // 全局低余额告警阈值（美元）
};

function uid(prefix = "st") {
  return prefix + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

// 阈值等可选数值：空/非数字一律归 null（NaN 会让告警判断永远为 false）
function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = {
      stations: [],
      settings: { ...DEFAULT_SETTINGS },
      auth: null, // { username, hash, salt }
      notifications: { channels: [], rules: { ...DEFAULT_RULES } },
    };
  }

  async load() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        stations: Array.isArray(parsed.stations) ? parsed.stations : [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        auth: parsed.auth || null,
        notifications: {
          channels: Array.isArray(parsed.notifications?.channels) ? parsed.notifications.channels : [],
          rules: { ...DEFAULT_RULES, ...(parsed.notifications?.rules || {}) },
        },
      };
    } catch {
      // 文件不存在或损坏：使用默认值并写入
    }
    // 初始化面板账号（默认 admin / admin123，登录后请在设置里修改）
    if (!this.data.auth) {
      const { salt, hash } = hashPassword("admin123");
      this.data.auth = { username: "admin", salt, hash, isDefault: true };
      console.log("  已创建默认面板账号：admin / admin123（请登录后在「设置」中修改密码）");
    }
    await this.save();
    return this;
  }

  // 串行化写盘（并行刷新会同时触发 save），临时文件 + rename 保证原子性
  save() {
    this._saveChain = (this._saveChain || Promise.resolve())
      .then(() => this._writeNow())
      .catch((err) => console.error("保存失败:", err?.message));
    return this._saveChain;
  }

  async _writeNow() {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  // ---- 设置 ------------------------------------------------------------------
  get settings() {
    return this.data.settings;
  }

  async updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    await this.save();
    return this.data.settings;
  }

  // ---- 面板账号 --------------------------------------------------------------
  get auth() {
    return this.data.auth;
  }

  async setPassword(username, password) {
    const { salt, hash } = hashPassword(password);
    this.data.auth = { username: username || this.data.auth.username, salt, hash, isDefault: false };
    await this.save();
  }

  // ---- 通知 ------------------------------------------------------------------
  get channels() {
    return this.data.notifications.channels;
  }

  get rules() {
    return this.data.notifications.rules;
  }

  async addChannel(input) {
    const ch = {
      id: uid("ch"),
      type: String(input.type || ""),
      name: String(input.name || "未命名渠道").trim(),
      enabled: input.enabled !== false,
      config: typeof input.config === "object" && input.config ? input.config : {},
      createdAt: new Date().toISOString(),
    };
    this.data.notifications.channels.push(ch);
    await this.save();
    return ch;
  }

  async updateChannel(id, patch) {
    const ch = this.data.notifications.channels.find((c) => c.id === id);
    if (!ch) return null;
    if ("name" in patch) ch.name = String(patch.name ?? "").trim();
    if ("enabled" in patch) ch.enabled = !!patch.enabled;
    if ("config" in patch && typeof patch.config === "object" && patch.config) {
      // 空值表示保留原值（前端编辑时不回显密钥）
      for (const [k, v] of Object.entries(patch.config)) {
        if (v !== "" && v != null) ch.config[k] = String(v);
        else if (v === "" && !(k in ch.config)) ch.config[k] = "";
      }
    }
    await this.save();
    return ch;
  }

  async removeChannel(id) {
    const n = this.data.notifications.channels.length;
    this.data.notifications.channels = this.data.notifications.channels.filter((c) => c.id !== id);
    await this.save();
    return this.data.notifications.channels.length < n;
  }

  async updateRules(patch) {
    const r = this.data.notifications.rules;
    for (const k of ["onLow", "onExhaust", "onError", "onRecover", "onEta"]) {
      if (k in patch) r[k] = !!patch[k];
    }
    if ("etaDays" in patch) r.etaDays = Math.max(0.5, Number(patch.etaDays) || 3);
    if ("renotifyHours" in patch) r.renotifyHours = Math.max(0, Number(patch.renotifyHours) || 0);
    await this.save();
    return r;
  }

  // ---- 中转站 ----------------------------------------------------------------
  list() {
    return this.data.stations;
  }

  get(id) {
    return this.data.stations.find((s) => s.id === id);
  }

  async add(input) {
    const station = {
      id: uid("st"),
      name: String(input.name || "未命名中转站").trim(),
      type: input.type,
      baseUrl: String(input.baseUrl || "").trim(),
      accessToken: input.accessToken ? String(input.accessToken).trim() : "",
      userId: input.userId ? String(input.userId).trim() : "",
      apiKey: input.apiKey ? String(input.apiKey).trim() : "",
      email: input.email ? String(input.email).trim() : "",
      password: input.password ? String(input.password) : "",
      lowBalanceUsd: numOrNull(input.lowBalanceUsd),
      demo: !!input.demo,
      createdAt: new Date().toISOString(),
      s2Tokens: null, // Sub2API 密码模式的令牌缓存 {accessToken, refreshToken, expiresAt}
      alertState: null, // 告警去重状态 {state, notifiedAt, etaNotifiedAt}
      balance: null, // 最近一次查询结果
    };
    this.data.stations.push(station);
    await this.save();
    return station;
  }

  async update(id, patch) {
    const s = this.get(id);
    if (!s) return null;
    const before = {
      type: s.type, baseUrl: s.baseUrl, email: s.email,
      accessToken: s.accessToken, password: s.password,
    };
    const fields = ["name", "type", "baseUrl", "accessToken", "userId", "apiKey", "email"];
    for (const f of fields) if (f in patch) s[f] = String(patch[f] ?? "").trim();
    if ("password" in patch) s.password = String(patch.password ?? "");
    if ("lowBalanceUsd" in patch) s.lowBalanceUsd = numOrNull(patch.lowBalanceUsd);
    // 凭证或站点实际变化才作废令牌缓存（前端编辑总会带上 type/email 原值，
    // 无脑作废会导致每次改名都触发一次完整重登录）
    const credsChanged =
      before.type !== s.type || before.baseUrl !== s.baseUrl || before.email !== s.email ||
      ("accessToken" in patch && s.accessToken !== before.accessToken) ||
      ("password" in patch && s.password !== before.password);
    if (credsChanged) s.s2Tokens = null;
    await this.save();
    return s;
  }

  async remove(id) {
    const n = this.data.stations.length;
    this.data.stations = this.data.stations.filter((s) => s.id !== id);
    await this.save();
    return this.data.stations.length < n;
  }

  async setBalance(id, balance) {
    const s = this.get(id);
    if (!s) return;
    s.balance = balance;
    await this.save();
  }
}
