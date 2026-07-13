# 中转站余额监控 · Relay Monitor

监控 **sub2api** 与 **new-api** 类中转站余额的自托管网页面板。左导航 + 右内容的桌面工具风界面，
基于 [app-shell-ui](https://github.com/yg2224/app-shell-ui) 设计语言构建，浅色 / 深色双主题。

后端负责向各中转站查询余额（凭证只留本机、无跨域问题），前端为纯 HTML/CSS/JS，除 Express 外零依赖。

## 功能

- **总览面板**：总剩余余额、**今日总消耗**、日均消耗（估算）、低余额 / 耗尽、查询异常统计；**总余额趋势图**（全站合计、24 小时～30 天切换、悬停查看分站明细）与**日均消耗对比图**；每站余额、今日消耗、用量进度条、状态标签、查询延迟
- **今日消耗与站点一致**：Sub2API 站点直接读取站点用户仪表盘同款接口（`/api/v1/usage/dashboard/stats` 的 `today_actual_cost`，即今日实际扣费），与站点页面显示的数值完全一致；其他类型按余额历史推算并以 ≈ 标注
- **Sub2API 账号密码模式**：只填邮箱 + 密码，面板自动登录换取令牌；令牌过期时自动用 refresh_token 刷新（支持轮换），刷新失败自动用密码重新登录——**全程无需人工干预**
- **余额预测**：记录余额历史（30 天），线性回归估算日均消耗与预计耗尽时间；点击任意站点查看趋势图（历史折线 + 虚线耗尽投影 + 悬停查看）；识别充值，只按最近一段消耗回归
- **通知告警**：余额偏低 / 耗尽 / 查询失败 / 恢复正常 / 预计即将耗尽（**阈值可按天或小时设置**），状态迁移触发、自动去重、可配重复提醒间隔；支持 10 种渠道：
  Telegram、钉钉（含加签）、企业微信、飞书（含签名）、Bark、ntfy、Server酱（含 sctp 新版）、Resend 邮件、SMTP 邮件（内置零依赖客户端，465 SSL / 587 STARTTLS）、自定义 Webhook，每个渠道可单独测试
- **面板登录**：网页需要账号密码登录（scrypt 哈希 + HMAC 签名会话 Cookie，7 天有效；登录失败限流）；默认账号 `admin / admin123`，登录后请在「设置」中修改
- **内置演示**：首次启动自动创建演示中转站（数据来自内置 mock，含完整的登录→过期→自动续期链路演示），可直接删除

## 支持的中转站类型

| 类型 | 查询方式 | 需要填写 |
|------|----------|----------|
| **New API（访问令牌）** | `GET /api/user/self`，头 `Authorization` + `New-Api-User` | 站点地址、系统访问令牌、用户 ID |
| **New API（sk 密钥）** | OpenAI 兼容 `/dashboard/billing/subscription` + `/usage` | 站点地址、`sk-` 密钥 |
| **Sub2API（登录令牌）** | `GET /api/v1/auth/me`，`Bearer JWT` | 站点地址、登录 JWT（过期需手动更换） |
| **Sub2API（账号密码）** | 自动 `POST /api/v1/auth/login` / `refresh` / `me` | 站点地址、登录邮箱、密码（开启 2FA 的账号不支持） |

> new-api / one-api 的额度按 500000 = $1 换算；sk 密钥模式 `total_usage` 单位为美分。
> Sub2API 契约提取自 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) 服务端源码：登录字段为 `email`（须是邮箱格式）+ `password`，
> 响应 `{code:0, data:{access_token, refresh_token, expires_in}}`，刷新会轮换 refresh_token，过期返回 401 `TOKEN_EXPIRED`。

## 运行

```bash
npm install
npm start          # 打开 http://127.0.0.1:8787，账号 admin / admin123
```

自定义端口 / 监听地址：`PORT=9000 HOST=0.0.0.0 npm start`。
对外暴露前请务必修改默认密码，并建议置于 HTTPS 反代之后。

## 添加真实中转站

右上角「添加中转站」→ 选类型 → 填站点根地址（如 `https://your-relay.com`，不带 `/v1`）→ 按上表填凭证。
Sub2API 推荐用「账号密码」模式，一劳永逸；令牌模式的 JWT 通常 24 小时过期。

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
├── server.js            Express：静态资源 + REST API + 会话认证 + mock 演示站 + 定时刷新
├── lib/
│   ├── providers.js     各类中转站适配器（含 Sub2API 登录/刷新/自动恢复阶梯）
│   ├── auth.js          面板认证：scrypt 哈希 + HMAC 会话 Cookie + 登录限流
│   ├── history.js       余额历史 + 线性回归耗尽预测（识别充值截断）
│   ├── alerts.js        告警引擎：状态迁移触发 + 去重 + 重复提醒
│   ├── notify.js        10 种通知渠道发送器（纯 fetch，无 SDK）
│   ├── smtp.js          极简 SMTP 客户端（隐式 TLS / STARTTLS / AUTH，零依赖）
│   └── store.js         JSON 文件持久化（原子写、串行化）
├── public/              前端（app-shell-ui 风格，无框架）
└── data/                运行时生成：stations.json / history.json / secret.key（已 gitignore）
```

## 安全说明

- 面板密码以 scrypt 哈希存储；会话为 HMAC-SHA256 签名的 HttpOnly Cookie
- 中转站凭证明文保存于本机 `data/stations.json`（0600 权限，不入库）——这是查询上游所必需的
- API 响应中不回传任何令牌 / 密钥 / 密码原文
- 默认仅监听 `127.0.0.1`
