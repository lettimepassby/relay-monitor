// 原生 fetch 的网络层错误只有一句 "fetch failed"，真正原因（DNS 失败 / 连接超时 / 被重置 / 证书…）
// 藏在 err.cause 里。把原因代码拼进消息，界面、告警和日志里一眼能看出是哪类故障。
export function describeFetchError(err) {
  if (!(err instanceof Error) || err.message !== "fetch failed") return err;
  const c = err.cause;
  const code =
    c?.code ||
    (Array.isArray(c?.errors) ? [...new Set(c.errors.map((e) => e?.code).filter(Boolean))].join("/") : "") ||
    (c?.name && c.name !== "Error" ? c.name : "");
  return code ? new Error(`fetch failed (${code})`, { cause: c }) : err;
}
