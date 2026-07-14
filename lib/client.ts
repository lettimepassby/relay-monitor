// 前端 API 客户端与展示工具函数（从 v1 app.js 平移，行为逐字对齐）

// ---- API（401 自动跳登录）---------------------------------------------------
// 同源 fetch + JSON；未登录（401）时跳转登录页（登录接口本身的 401 是密码错误，不跳转）
export async function api(path: string, opts: { method?: string; body?: any } = {}): Promise<any> {
  const res = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    method: opts.method || (opts.body ? "POST" : "GET"),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/api/auth/login")) {
    window.location.href = "/login";
    throw new Error("未登录");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- 工具（与 v1 app.js 完全一致）-------------------------------------------
export const usd = (n: any) => "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const cny = (n: any) => "¥" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const cny4 = (n: any) => "¥" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

// 充值折算汇率：站点 $1 折合人民币；未配置按 1:1
export const rateOf = (s: any) => (s && s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1);

export const fmtTokens = (n: any) => {
  n = Number(n) || 0;
  if (n >= 1e9) return +(n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return +(n / 1e3).toFixed(1) + "K";
  return String(n);
};

// v1 的 fmtEtaText：预计耗尽时间的人话表达
export function fmtEta(days: number): string {
  return days >= 1 ? `${days} 天` : `${Math.max(1, Math.round(days * 24))} 小时`;
}

// 站点低余额阈值：站点自身配置优先，否则用全局设置
// （v1 从全局 state.settings 取，这里改为调用方传入 settings，默认值与 v1 初始 state 一致）
export function threshold(s: any, settings: any = { lowBalanceUsd: 5 }): number {
  return s.lowBalanceUsd != null && s.lowBalanceUsd !== "" ? Number(s.lowBalanceUsd) : Number(settings.lowBalanceUsd);
}

export function statusOf(s: any, settings?: any): "pending" | "error" | "danger" | "warn" | "ok" {
  const b = s.balance;
  if (!b) return "pending";
  if (!b.ok) return "error";
  if (b.remaining <= 0) return "danger";
  if (b.remaining < threshold(s, settings)) return "warn";
  return "ok";
}
