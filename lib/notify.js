// 通知渠道发送器：全部用原生 fetch 实现，不引第三方 SDK
import { createHmac } from "node:crypto";
import { sendSmtpMail, splitRecipients } from "./smtp.js";

const num = (v) => (typeof v === "number" ? v : Number(v) || 0);

async function postJson(url, body, headers = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 各渠道实现 -------------------------------------------------------------

async function sendTelegram(cfg, title, body) {
  const base = (cfg.apiBase || "https://api.telegram.org").replace(/\/+$/, "");
  const r = await postJson(`${base}/bot${cfg.botToken}/sendMessage`, {
    chat_id: cfg.chatId,
    text: `${title}\n${body}`,
  });
  if (!r.json?.ok) throw new Error(r.json?.description || `HTTP ${r.status}`);
}

async function sendDingTalk(cfg, title, body) {
  let url = cfg.webhook;
  if (cfg.secret) {
    const timestamp = Date.now();
    const sign = createHmac("sha256", cfg.secret)
      .update(`${timestamp}\n${cfg.secret}`)
      .digest("base64");
    url += `${url.includes("?") ? "&" : "?"}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }
  const r = await postJson(url, {
    msgtype: "text",
    text: { content: `${title}\n${body}` },
  });
  if (r.json?.errcode !== 0) throw new Error(r.json?.errmsg || `HTTP ${r.status}`);
}

async function sendWeCom(cfg, title, body) {
  const r = await postJson(cfg.webhook, {
    msgtype: "text",
    text: { content: `${title}\n${body}` },
  });
  if (r.json?.errcode !== 0) throw new Error(r.json?.errmsg || `HTTP ${r.status}`);
}

async function sendFeishu(cfg, title, body) {
  const payload = { msg_type: "text", content: { text: `${title}\n${body}` } };
  if (cfg.secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    // 飞书签名：以 `${timestamp}\n${secret}` 为 key 对空串做 HMAC-SHA256
    const sign = createHmac("sha256", `${timestamp}\n${cfg.secret}`).update("").digest("base64");
    payload.timestamp = String(timestamp);
    payload.sign = sign;
  }
  const r = await postJson(cfg.webhook, payload);
  const code = r.json?.code ?? r.json?.StatusCode;
  if (code !== 0) throw new Error(r.json?.msg || `HTTP ${r.status}`);
}

async function sendBark(cfg, title, body) {
  const base = (cfg.server || "https://api.day.app").replace(/\/+$/, "");
  const r = await postJson(`${base}/push`, {
    device_key: cfg.deviceKey,
    title,
    body,
    group: "relay-monitor",
  });
  if (r.json?.code !== 200) throw new Error(r.json?.message || `HTTP ${r.status}`);
}

async function sendNtfy(cfg, title, body) {
  const base = (cfg.server || "https://ntfy.sh").replace(/\/+$/, "");
  // JSON 发布模式：中文标题无需处理 header 编码
  const headers = {};
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const r = await postJson(base, { topic: cfg.topic, title, message: body }, headers);
  if (r.status >= 300) throw new Error(r.json?.error || `HTTP ${r.status}`);
}

async function sendServerChan(cfg, title, body) {
  const key = String(cfg.sendKey || "").trim();
  // ServerChan3（sctp{num}t... 开头的 key）走 {num}.push.ft07.com
  const m = key.match(/^sctp(\d+)t/i);
  const url = m
    ? `https://${m[1]}.push.ft07.com/send/${key}.send`
    : `https://sctapi.ftqq.com/${key}.send`;
  const r = await postJson(url, { title, desp: body });
  if (r.json?.code !== 0) {
    throw new Error(r.json?.message || r.json?.error || `HTTP ${r.status}`);
  }
}

async function sendResend(cfg, title, body) {
  const to = splitRecipients(cfg.to);
  if (!to.length) throw new Error("缺少收件人");
  const r = await postJson("https://api.resend.com/emails", {
    from: String(cfg.from || "").trim(),
    to,
    subject: title,
    text: body,
  }, { Authorization: `Bearer ${String(cfg.apiKey || "").trim()}` });
  if (r.status >= 300 || !r.json?.id) {
    throw new Error(r.json?.message || r.json?.error?.message || `HTTP ${r.status}`);
  }
}

async function sendSmtp(cfg, title, body) {
  await sendSmtpMail(cfg, title, body);
}

async function sendWebhook(cfg, title, body, extra) {
  let headers = {};
  if (cfg.headersJson) {
    try { headers = JSON.parse(cfg.headersJson); } catch {}
  }
  const r = await postJson(cfg.url, {
    source: "relay-monitor",
    title,
    body,
    ...extra,
    timestamp: new Date().toISOString(),
  }, headers);
  if (r.status >= 300) throw new Error(`HTTP ${r.status}`);
}

const SENDERS = {
  telegram: sendTelegram,
  dingtalk: sendDingTalk,
  wecom: sendWeCom,
  feishu: sendFeishu,
  bark: sendBark,
  ntfy: sendNtfy,
  serverchan: sendServerChan,
  resend: sendResend,
  smtp: sendSmtp,
  webhook: sendWebhook,
};

// 渠道类型元数据（前端表单据此渲染）
export const CHANNEL_TYPES = [
  { value: "telegram", label: "Telegram 机器人", fields: [
    { key: "botToken", label: "Bot Token", required: true },
    { key: "chatId", label: "Chat ID", required: true },
    { key: "apiBase", label: "API 地址（可选，默认官方）", required: false },
  ]},
  { value: "dingtalk", label: "钉钉群机器人", fields: [
    { key: "webhook", label: "Webhook 地址", required: true },
    { key: "secret", label: "加签密钥（可选）", required: false },
  ]},
  { value: "wecom", label: "企业微信群机器人", fields: [
    { key: "webhook", label: "Webhook 地址", required: true },
  ]},
  { value: "feishu", label: "飞书群机器人", fields: [
    { key: "webhook", label: "Webhook 地址", required: true },
    { key: "secret", label: "签名校验密钥（可选）", required: false },
  ]},
  { value: "bark", label: "Bark（iOS）", fields: [
    { key: "deviceKey", label: "Device Key", required: true },
    { key: "server", label: "服务器（可选，默认 api.day.app）", required: false },
  ]},
  { value: "ntfy", label: "ntfy", fields: [
    { key: "topic", label: "主题 Topic", required: true },
    { key: "server", label: "服务器（可选，默认 ntfy.sh）", required: false },
    { key: "token", label: "访问令牌（可选）", required: false },
  ]},
  { value: "serverchan", label: "Server酱", fields: [
    { key: "sendKey", label: "SendKey", required: true },
  ]},
  { value: "resend", label: "Resend 邮件", fields: [
    { key: "apiKey", label: "API Key（re_ 开头）", required: true },
    { key: "from", label: "发件人（需已验证域名，如 Relay Monitor <alert@yourdomain.com>）", required: true },
    { key: "to", label: "收件人（多个用逗号分隔）", required: true },
  ]},
  { value: "smtp", label: "SMTP 邮件", fields: [
    { key: "host", label: "SMTP 服务器（如 smtp.gmail.com）", required: true },
    { key: "port", label: "端口（465=SSL / 587=STARTTLS，默认 465）", required: false },
    { key: "username", label: "用户名（通常是邮箱）", required: false },
    { key: "password", label: "密码 / 应用专用密码", required: false },
    { key: "from", label: "发件人（如 Relay Monitor <me@example.com>）", required: true },
    { key: "to", label: "收件人（多个用逗号分隔）", required: true },
  ]},
  { value: "webhook", label: "自定义 Webhook", fields: [
    { key: "url", label: "URL", required: true },
    { key: "headersJson", label: "附加请求头 JSON（可选）", required: false },
  ]},
];

// 截断，避开各渠道长度上限（Telegram 4096 字符 / 企微 2048 字节）
function clamp(s, max = 1500) {
  s = String(s ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// 发送到单个渠道；返回 {ok, error?}
export async function sendToChannel(channel, title, body, extra = {}) {
  const sender = SENDERS[channel.type];
  if (!sender) return { ok: false, error: `未知渠道类型：${channel.type}` };
  try {
    await sender(channel.config || {}, clamp(title, 200), clamp(body), extra);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// 群发到所有启用的渠道
export async function broadcast(channels, title, body, extra = {}) {
  const enabled = (channels || []).filter((c) => c.enabled !== false);
  return Promise.all(
    enabled.map(async (c) => ({ id: c.id, name: c.name, ...(await sendToChannel(c, title, body, extra)) }))
  );
}
