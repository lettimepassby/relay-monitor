# 中转站余额监控 · Relay Monitor v2

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

监控 **sub2api** 与 **new-api** 类中转站余额的自托管面板。
**v2 技术栈**：Next.js 16 全栈（App Router + Route Handlers）+ Ant Design Pro（antd 6 + pro-components）+ MySQL 持久化，浅色 / 深色双主题。

后端逻辑（站点适配、告警引擎、消费预测、日报）与 v1 同源平移——行为与 v1 完全一致；存储从 JSON 文件升级为 MySQL（余额历史落表，供经营分析 SQL 聚合）。

## 功能

- **总览面板**：总剩余余额、**今日总消耗**、日均消耗（估算）、低余额 / 耗尽、查询异常统计；**总余额趋势图**（全站合计、24 小时～30 天切换）与**今日消耗对比图**（当日实际扣费）；每站余额、今日消耗、**近 48 小时余额迷你走势图**、状态标签、查询延迟
- **经营分析页（v2 新增）**：收支利润趋势（成本 = 上游消耗 × 汇率 + 固定摊销；收入 = 下游 / 转售 Key 消费）、**消耗时段热力图**（星期 × 小时找高峰）、站点成本占比、**余额跑道图**（各站预计可用天数，红黄绿分档）、固定成本 vs 用量成本、累计消耗曲线；7 / 14 / 30 天切换
- **今日消耗与站点一致**：Sub2API 站点直接读取站点用户仪表盘同款接口（`today_actual_cost`，即今日实际扣费），与站点页面显示的数值完全一致；其他类型按余额历史推算并以 ≈ 标注
- **用量统计页**：分站点、分模型、分时段的 Token 消耗——今天 / 近 24 小时 / 近 7 天 / 近 30 天，含消耗趋势图、分模型排行与明细表
- **Sub2API 账号密码模式**：只填邮箱 + 密码，面板自动登录换取令牌；令牌过期自动刷新（支持轮换），刷新失败自动重新登录——**全程无需人工干预**
- **余额预测**：余额历史（30 天）+ 实时速率分层估计（近 3 小时优先）预计耗尽时间；点击站点查看趋势图（历史折线 + 耗尽投影）
- **通知告警**：余额偏低 / 耗尽 / 查询失败（**可配连续失败阈值与失败快速重试**）/ 恢复正常 / 预计即将耗尽（阈值可按天或小时），状态迁移触发、自动去重、可配重复提醒；支持 10 种渠道：Telegram、钉钉（加签）、企业微信、飞书（签名）、Bark、ntfy、Server酱、Resend 邮件、SMTP 邮件（零依赖客户端）、自定义 Webhook，每渠道可单独测试
- **我的站点（下游分析）**：自营 new-api 站点的分时段 / 分模型 / **分用户**用量与消费，**未来 7 天消费预测**（组合模型 + conformal 区间，历史满两周自动启用周末模式识别）
- **利润分析**：下游收入（普通用户消费 × 售价汇率）− 上游期内成本（用量 × 充值汇率；固定成本按天摊销）；**管理员 / root 转售 Key 可标记计入收入**；未匹配渠道单独列出
- **每日日报**：每天定时（默认北京时间，可用 `REPORT_TIME_ZONE` 覆盖）汇总昨日经营——消费环比、收入/成本/利润、Top 模型与用户、上游余额与耗尽预警、未来 7 天预测——推送到通知渠道（邮件全文，IM 截断）；支持预览与立即发送
- **人民币折算**：每站可配充值汇率（站点 $1 折合 ¥ 多少）；金额主显人民币，站点原始余额次要展示；余额告警阈值仍按站点余额判断
- **PWA**：可添加到手机主屏幕独立运行（品牌图标 + 离线壳缓存；静态资源网络优先，API 不缓存）
- **面板登录**：scrypt 哈希 + HMAC 签名会话 Cookie（7 天，登录失败限流）；默认 `admin / admin123`，登录后请在「设置」中修改
- **内置演示**：空库首次启动自动创建演示中转站（内置 mock，含完整登录→过期→自动续期链路），可直接删除

## 支持的中转站类型

| 类型 | 查询方式 | 需要填写 |
|------|----------|----------|
| **New API（访问令牌）** | `GET /api/user/self`，头 `Authorization` + `New-Api-User` | 站点地址、系统访问令牌、用户 ID |
| **New API（sk 密钥）** | OpenAI 兼容 `/dashboard/billing/subscription` + `/usage` | 站点地址、`sk-` 密钥 |
| **Sub2API（登录令牌）** | `GET /api/v1/auth/me`，`Bearer JWT` | 站点地址、登录 JWT（过期需手动更换） |
| **Sub2API（账号密码）** | 自动 `POST /api/v1/auth/login` / `refresh` / `me` | 站点地址、登录邮箱、密码（开启 2FA 的账号不支持） |
| **固定成本（不访问）** | 不访问任何接口 | 每次付费金额（¥）+ 覆盖天数；日均摊销计入利润成本 |

## 运行

需要一个 **MySQL 8+** 实例（自备，不随面板捆绑）。

```bash
cp .env.example .env.local        # 填入 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
npm install
npm run db:migrate                # 建表；若配置了 V1_DATA_DIR 且库为空，一次性导入 v1 数据
npm run build && npm start        # 打开 http://127.0.0.1:3000，账号 admin / admin123
```

开发模式：`npm run dev`。对外暴露前请务必修改默认密码，并建议置于 HTTPS 反代之后。

## 从 v1 迁移

v1 的 `data/` 目录（stations.json / history.json / secret.key）可一次性导入：

1. 设环境变量 `V1_DATA_DIR` 指向 v1 的 data 目录（Docker 场景把目录只读挂载进容器）
2. 启动（或 `npm run db:migrate`）：**库为空才导入**，幂等、绝不覆盖已有数据；会话密钥一并沿用，已登录设备不掉线
3. 导入完成后可移除 `V1_DATA_DIR` 配置

## Docker 部署（含 Watchtower 自动更新）

镜像随 main 分支推送自动构建：`ghcr.io/lettimepassby/relay-monitor:latest`。

```bash
mkdir -p ~/relay-monitor && cd ~/relay-monitor
# 下载 deploy/docker-compose.yml，填好 DB_* 环境变量（连接你自有的 MySQL），然后：
docker compose up -d
```

- **relay-monitor**：面板本体（启动顺序：迁移脚本 → Next standalone 服务）；数据全部在 MySQL，容器无状态、升级不丢数据
- **watchtower**：自动拉取新镜像并重启面板；页面「设置 → 关于」可查看运行版本与构建 commit

## 通知渠道速查

| 渠道 | 需要 |
|------|------|
| Telegram | Bot Token + Chat ID |
| 钉钉 | 群机器人 Webhook（安全设置选「加签」则再填密钥） |
| 企业微信 | 群机器人 Webhook |
| 飞书 | 群机器人 Webhook（可选签名密钥） |
| Bark | Device Key（可自建服务器） |
| ntfy | Topic（可自建服务器 / 访问令牌） |
| Server酱 | SendKey（自动识别 sctp 新版 key） |
| Resend | API Key + 已验证域名的发件人 + 收件人（逗号分隔多个） |
| SMTP | 服务器地址 + 端口（465 SSL / 587 STARTTLS）+ 账号密码 + 发件人 / 收件人 |
| Webhook | 任意 URL，POST JSON `{title, body, event, station, ...}` |

## 目录结构

```
relay-monitor/
├── app/                  Next.js App Router
│   ├── (dashboard)/      面板页面：总览 / 中转站 / 我的站点 / 用量 / 经营分析 / 通知 / 设置
│   ├── api/              26 个 REST 端点（Route Handlers，行为与 v1 一致）
│   ├── mock/             内置演示站 mock（Sub2API / New API 完整链路）
│   └── login/            登录页
├── server/               后台常驻逻辑：refresh.js 刷新循环 / report.js 日报 / demo.js 演示站
├── lib/                  与 v1 同源：providers / alerts / notify / smtp / forecast / auth + runtime 单例
├── db/                   MySQL 层：pool / store（写透缓存）/ history / migrate（v1 导入）
├── instrumentation.ts    服务启动钩子：初始化 + 定时刷新 + 日报调度
└── public/               PWA manifest / 图标 / service worker
```

## 安全说明

- 面板密码以 scrypt 哈希存储；会话为 HMAC-SHA256 签名的 HttpOnly Cookie
- 中转站凭证保存于你自有的 MySQL（`stations` 表）——这是查询上游所必需的；请妥善保护数据库访问权限
- API 响应中不回传任何令牌 / 密钥 / 密码原文
- 构建产物经文件追踪排除，凭证目录绝不进入镜像

## 开源协议

[MIT](LICENSE) © lettimepassby
