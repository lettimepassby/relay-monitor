// 面板登录认证：scrypt 密码哈希 + HMAC 签名会话 Cookie
import {
  randomBytes,
  scryptSync,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const COOKIE_NAME = "rm_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(String(password), salt, 32).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  try {
    const got = scryptSync(String(password), salt, 32);
    const want = Buffer.from(hash, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

export class SessionManager {
  constructor(secretFile) {
    this.secretFile = secretFile;
    this.secret = null;
    // 登录失败限流：ip -> { count, lockedUntil }
    this.failures = new Map();
  }

  async init() {
    try {
      this.secret = (await readFile(this.secretFile, "utf8")).trim();
      if (!this.secret) throw new Error("empty");
    } catch {
      this.secret = randomBytes(32).toString("hex");
      await mkdir(dirname(this.secretFile), { recursive: true });
      await writeFile(this.secretFile, this.secret, { mode: 0o600 });
    }
    return this;
  }

  sign(payloadB64) {
    return createHmac("sha256", this.secret).update(payloadB64).digest("base64url");
  }

  issue(username) {
    const payload = b64url(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS }));
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token) {
    if (!token || typeof token !== "string") return null;
    const dot = token.lastIndexOf(".");
    if (dot < 1) return null;
    const payloadB64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const want = this.sign(payloadB64);
    const a = Buffer.from(sig);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      if (!payload.exp || payload.exp < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  cookieHeader(token) {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  }

  clearCookieHeader() {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }

  tokenFromRequest(req) {
    const raw = req.headers.cookie || "";
    for (const part of raw.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === COOKIE_NAME) return rest.join("=");
    }
    return null;
  }

  // ---- 登录失败限流 --------------------------------------------------------
  isLocked(ip) {
    const f = this.failures.get(ip);
    return !!(f && f.lockedUntil && f.lockedUntil > Date.now());
  }

  recordFailure(ip) {
    const f = this.failures.get(ip) || { count: 0, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= 10) {
      f.lockedUntil = Date.now() + 5 * 60 * 1000; // 锁 5 分钟
      f.count = 0;
    }
    this.failures.set(ip, f);
  }

  recordSuccess(ip) {
    this.failures.delete(ip);
  }

  // Express 中间件：保护 /api/*（放行登录接口）
  middleware() {
    return (req, res, next) => {
      const payload = this.verify(this.tokenFromRequest(req));
      if (!payload) return res.status(401).json({ error: "未登录", code: "UNAUTHORIZED" });
      req.session = payload;
      next();
    };
  }
}
