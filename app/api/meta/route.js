// GET /api/meta —— 元信息：站点/通知渠道类型、设置、规则、应用版本（v1 中位于登录中间件之后，需已登录）
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withAuth, json } from "../../../lib/api.js";
import { STATION_TYPES } from "../../../lib/providers.js";
import { CHANNEL_TYPES } from "../../../lib/notify.js";

// 版本信息：版本号来自 package.json，commit 由 Docker 构建时注入（APP_COMMIT）
let appInfo = null;
async function getAppInfo() {
  if (!appInfo) {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    appInfo = {
      version: pkg.version,
      commit: (process.env.APP_COMMIT || "").slice(0, 7) || null,
    };
  }
  return appInfo;
}

export const GET = withAuth(async (request, rt) => {
  return json({
    types: STATION_TYPES,
    channelTypes: CHANNEL_TYPES,
    settings: rt.store.settings,
    rules: rt.store.rules,
    app: await getAppInfo(),
  });
});
