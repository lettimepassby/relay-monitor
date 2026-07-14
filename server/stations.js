// 站点响应拼装助手（v1 server.js redact 的平移版，改为显式接收 rt）。
// 隐藏敏感凭证，仅返回是否已配置
export function redact(rt, s) {
  const { accessToken, apiKey, password, s2Tokens, ...rest } = s;
  // 今日消耗：sub2api 直接用站点仪表盘接口的值；拿不到就按余额历史推算（前端标 ≈）
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const fromSite = s.balance?.todayUsed;
  return {
    ...rest,
    hasAccessToken: !!accessToken,
    hasApiKey: !!apiKey,
    hasPassword: !!password,
    tokenInfo: s2Tokens
      ? { expiresAt: s2Tokens.expiresAt || null, lastLoginAt: s2Tokens.lastLoginAt || null }
      : null,
    prediction: rt.history.predict(s.id),
    spark: rt.history.sparkline(s.id, 48),
    todayUsed: fromSite ?? rt.history.usedSince(s.id, midnight.getTime()),
    todayIsEstimate: fromSite == null,
    todayTokens: s.balance?.todayTokens ?? null,
    todayRequests: s.balance?.todayRequests ?? null,
  };
}
