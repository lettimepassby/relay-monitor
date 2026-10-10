import capWasm from "@cap.js/wasm";

const MAX_CHALLENGES = 256;
const MAX_POW_INPUT_LENGTH = 256;
const MAX_ESTIMATED_HASHES = 50_000_000;

function seededHex(seed, length) {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24);
  }
  state >>>= 0;

  let out = "";
  while (out.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out += (state >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

function validatePowInput(salt, target) {
  if (typeof salt !== "string" || typeof target !== "string" ||
      !salt || !/^[0-9a-f]+$/i.test(target) ||
      salt.length > MAX_POW_INPUT_LENGTH || target.length > MAX_POW_INPUT_LENGTH) {
    throw new Error("Cap challenge 格式无效");
  }
}

function solvePow(salt, target) {
  validatePowInput(salt, target);
  return Number(capWasm.solve_pow(salt, target));
}

function oldFormatChallenges(body) {
  if (Array.isArray(body.challenge)) return body.challenge;
  const spec = body.challenge;
  const count = Number(spec?.c);
  const saltLength = Number(spec?.s);
  const difficulty = Number(spec?.d);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CHALLENGES ||
      !Number.isInteger(saltLength) || saltLength < 1 || saltLength > MAX_POW_INPUT_LENGTH ||
      !Number.isInteger(difficulty) || difficulty < 1 || difficulty > 16) {
    throw new Error("Cap challenge 参数无效");
  }

  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return [
      seededHex(`${body.token}${n}`, saltLength),
      seededHex(`${body.token}${n}d`, difficulty),
    ];
  });
}

function solveChallenge(body) {
  if (!body?.token) throw new Error("Cap challenge 缺少 token");

  if (body.format === 2 && Array.isArray(body.challenges)) {
    if (body.challenges.length < 1 || body.challenges.length > MAX_CHALLENGES) {
      throw new Error("Cap challenge 数量无效");
    }
    const pow = body.challenges.map((challenge) => {
      if (challenge?.protocol !== "sha256-pow") {
        throw new Error(`Cap challenge 需要 sha256-pow，收到：${challenge?.protocol || "unknown"}`);
      }
      validatePowInput(challenge.payload?.salt, challenge.payload?.target);
      return challenge.payload;
    });
    const estimatedHashes = pow.reduce((sum, item) => sum + 16 ** item.target.length, 0);
    if (!Number.isFinite(estimatedHashes) || estimatedHashes > MAX_ESTIMATED_HASHES) {
      throw new Error("Cap challenge 工作量超出单次登录限制");
    }
    return pow.map((item) => ({ nonce: solvePow(item.salt, item.target) }));
  }

  const challenges = oldFormatChallenges(body);
  if (challenges.length < 1 || challenges.length > MAX_CHALLENGES) {
    throw new Error("Cap challenge 数量无效");
  }
  const estimatedHashes = challenges.reduce((sum, [, target]) => sum + 16 ** target.length, 0);
  if (!Number.isFinite(estimatedHashes) || estimatedHashes > MAX_ESTIMATED_HASHES) {
    throw new Error("Cap challenge 工作量超出单次登录限制");
  }
  return challenges.map(([salt, target]) => solvePow(salt, target));
}

function capEndpoint(stationBase, apiEndpoint, siteKey) {
  const origin = new URL(stationBase).origin;
  const rawEndpoint = String(apiEndpoint || "").trim();
  const key = String(siteKey || "").trim().replace(/^\/+|\/+$/g, "");
  if (!rawEndpoint || !key) throw new Error("Cap 验证码配置不完整");
  const path = new URL(rawEndpoint, `${origin}/`).pathname.replace(/\/+$/, "");
  if (!path) throw new Error("Cap 验证码配置不完整");
  return `${origin}${path}/${encodeURIComponent(key)}/`;
}

// Sub2API 把验证码配置放在公开设置里。只有启用 Cap 时才生成令牌，
// 未开启验证码或使用其他 provider 的站点继续走原有登录流程。
export async function capTokenForLogin(stationBase, request) {
  let settingsResponse;
  try {
    settingsResponse = await request(`${stationBase}/api/v1/settings/public`);
  } catch {
    return null;
  }
  if (settingsResponse.status >= 300) return null;

  const settings = settingsResponse.body?.data ?? settingsResponse.body ?? {};
  if (settings.captcha_provider !== "cap" || settings.turnstile_enabled === false) return null;

  const endpoint = capEndpoint(stationBase, settings.cap_api_endpoint, settings.cap_site_key);
  return solveCapEndpoint(endpoint, request);
}

// 在指定 Cap 端点（以 / 结尾，challenge/redeem 拼在其后）完成一次工作量证明，返回验证令牌
export async function solveCapEndpoint(endpoint, request) {
  const challengeResponse = await request(`${endpoint}challenge`, { method: "POST", timeoutMs: 15000 });
  if (challengeResponse.status >= 300) {
    throw new Error(`Cap challenge 获取失败：HTTP ${challengeResponse.status}`);
  }
  const challenge = challengeResponse.body || {};
  if (challenge.error) throw new Error(`Cap challenge 获取失败：${challenge.error}`);

  const solutions = solveChallenge(challenge);
  const redeemResponse = await request(`${endpoint}redeem`, {
    method: "POST",
    json: { token: challenge.token, solutions },
    timeoutMs: 15000,
  });
  const redeemed = redeemResponse.body || {};
  if (redeemResponse.status >= 300 || !redeemed.success || !redeemed.token) {
    throw new Error(`Cap challenge 验证失败：${redeemed.error || `HTTP ${redeemResponse.status}`}`);
  }
  return redeemed.token;
}
