# 中转站余额监控面板
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# 构建时注入 git commit，页面「关于」与侧栏显示
ARG GIT_SHA=dev
ENV APP_COMMIT=$GIT_SHA

# 运行时数据（站点凭证 / 历史 / 会话密钥）挂载到宿主机持久化
VOLUME /app/data

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://127.0.0.1:8787/ || exit 1

CMD ["node", "server.js"]
