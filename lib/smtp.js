// 极简 SMTP 客户端：只为发送纯文本告警邮件，延续项目零第三方依赖的原则
// 465 端口走隐式 TLS；其他端口先明文连接，服务器支持 STARTTLS 就升级；
// 认证支持 AUTH PLAIN / AUTH LOGIN。正文用 base64 编码传输，天然规避
// dot-stuffing 与行长限制。
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const CRLF = "\r\n";
const TIMEOUT_MS = 15000;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// "Name <a@b.c>" → a@b.c
function addrOf(s) {
  const m = String(s || "").match(/<([^>]+)>/);
  return (m ? m[1] : String(s || "")).trim();
}

// 非 ASCII 头部按 RFC 2047 编码
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
}

// 地址的显示名部分单独编码，角括号地址保持原样
function encodeAddress(s) {
  const m = String(s || "").match(/^(.*)<([^>]+)>\s*$/);
  if (!m) return String(s || "").trim();
  const name = m[1].trim().replace(/^"|"$/g, "");
  return name ? `${encodeHeader(name)} <${m[2].trim()}>` : `<${m[2].trim()}>`;
}

function buildMessage(from, toList, subject, text) {
  const body = b64(text).replace(/(.{76})/g, `$1${CRLF}`);
  return [
    `From: ${encodeAddress(from)}`,
    `To: ${toList.map(encodeAddress).join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@relay-monitor>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset=utf-8',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join(CRLF);
}

export function splitRecipients(s) {
  return String(s || "").split(/[,;，；]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 发送一封纯文本邮件。
 * cfg: { host, port?, username?, password?, from, to }
 */
export async function sendSmtpMail(cfg, subject, text) {
  const host = String(cfg.host || "").trim();
  if (!host) throw new Error("缺少 SMTP 服务器地址");
  const port = Number(cfg.port) || 465;
  const from = String(cfg.from || "").trim();
  const toList = splitRecipients(cfg.to);
  if (!from) throw new Error("缺少发件人");
  if (!toList.length) throw new Error("缺少收件人");

  let sock = await new Promise((resolve, reject) => {
    const s = port === 465
      ? tlsConnect({ host, port, servername: host }, () => resolve(s))
      : netConnect({ host, port }, () => resolve(s));
    s.once("error", reject);
    s.setTimeout(TIMEOUT_MS, () => { s.destroy(); reject(new Error("SMTP 连接超时")); });
  });

  let buf = "";
  let sockErr = null;
  const attach = (s) => {
    s.setEncoding("utf8");
    s.setTimeout(0);
    s.on("data", (d) => { buf += d; });
    s.on("error", (e) => { sockErr = e; });
  };
  attach(sock);

  // 取出一条完整响应（多行响应 250-a / 250-b / 250 c 到最终行为止）
  const extract = () => {
    const m = /^(\d{3})(?: [^\n]*)?\r?\n/m.exec(buf);
    if (!m) return null;
    const end = m.index + m[0].length;
    const text = buf.slice(0, end).trim();
    buf = buf.slice(end);
    return { code: Number(m[1]), text };
  };

  const readResp = () => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (sockErr) return reject(sockErr);
      const r = extract();
      if (r) return resolve(r);
      if (sock.destroyed) return reject(new Error("SMTP 连接被关闭"));
      if (Date.now() - started > TIMEOUT_MS) { sock.destroy(); return reject(new Error("SMTP 响应超时")); }
      setTimeout(poll, 25);
    };
    poll();
  });

  const cmd = async (line, okCodes, label) => {
    sock.write(line + CRLF);
    const r = await readResp();
    if (!okCodes.includes(r.code)) {
      throw new Error(`${label || line.split(" ")[0]} 失败：${r.text.slice(0, 200)}`);
    }
    return r;
  };

  try {
    const greet = await readResp();
    if (greet.code !== 220) throw new Error(`服务器拒绝连接：${greet.text.slice(0, 200)}`);

    let caps = (await cmd("EHLO relay-monitor", [250])).text.toUpperCase();

    if (port !== 465 && caps.includes("STARTTLS")) {
      await cmd("STARTTLS", [220]);
      const plain = sock;
      plain.removeAllListeners("data");
      plain.removeAllListeners("error");
      buf = "";
      sock = await new Promise((resolve, reject) => {
        const t = tlsConnect({ socket: plain, servername: host }, () => resolve(t));
        t.once("error", reject);
      });
      attach(sock);
      caps = (await cmd("EHLO relay-monitor", [250])).text.toUpperCase();
    }

    const user = String(cfg.username || "").trim();
    const pass = String(cfg.password || "");
    if (user && pass) {
      if (/AUTH[ =][^\n]*PLAIN/.test(caps)) {
        await cmd("AUTH PLAIN " + b64(`\u0000${user}\u0000${pass}`), [235], "AUTH");
      } else {
        await cmd("AUTH LOGIN", [334], "AUTH");
        await cmd(b64(user), [334], "AUTH");
        await cmd(b64(pass), [235], "AUTH");
      }
    }

    await cmd(`MAIL FROM:<${addrOf(from)}>`, [250]);
    for (const t of toList) await cmd(`RCPT TO:<${addrOf(t)}>`, [250, 251], "RCPT");
    await cmd("DATA", [354]);
    await cmd(buildMessage(from, toList, subject, text) + CRLF + ".", [250], "发送");
    sock.write("QUIT" + CRLF);
  } finally {
    sock.destroy();
  }
}
