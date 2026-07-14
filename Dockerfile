# 中转站余额监控面板 v2（Next.js standalone + MySQL）
# ---- 构建阶段 ----------------------------------------------------------------
FROM node:24-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# 构建期不连库（运行时才初始化 MySQL）；占位值避免构建意外读到真实环境
ENV DB_HOST=build-placeholder
RUN npx next build

# ---- 运行阶段 ----------------------------------------------------------------
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=8787

# 支持 TZ 环境变量（「今日」统计边界按此时区计算）
RUN apk add --no-cache tzdata

# standalone 产物：自带裁剪后的 node_modules 与 server.js
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# 迁移脚本独立于 Next 构建图（防止真实凭证被文件追踪拷进产物），
# 启动时链式执行：库为空且配置了 V1_DATA_DIR 才导入，幂等
COPY --from=builder /app/db ./db

# 构建时注入 git commit，页面「关于」显示
ARG GIT_SHA=dev
ENV APP_COMMIT=$GIT_SHA

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -q --spider http://127.0.0.1:8787/api/meta || exit 1

CMD ["sh", "-c", "node db/migrate.js && exec node server.js"]
