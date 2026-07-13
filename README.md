# 中转站余额监控 · Relay Monitor

监控 **sub2api** 与 **new-api** 类中转站余额的自托管网页面板。左导航 + 右内容的桌面工具风界面，
基于 [app-shell-ui](https://github.com/yg2224/app-shell-ui) 设计语言构建，浅色 / 深色双主题。

后端负责向各中转站查询余额（凭证只留本机、无跨域问题），前端为纯 HTML/CSS/JS，除 Express 外零依赖。

## 功能

- **总览面板**：总剩余余额、**今日总消耗**、日均消耗（估算）、低余额 / 耗尽、查询异常统计；**总余额趋势图**（全站合计、24 小时～30 天切换、悬停查看分站明细）与**日均消耗对比图**；每站余额、今日消耗、**近 48 小时余额迷你走势图**、状态标签、查询延迟
- **今日消耗与站点一致**：Sub2API 站点直接读取站点用户仪表盘同款接口（`/api/v1/usage/dashboard/stats` 的 `today_actual_cost`，即今日实际扣费），与站点页面显示的数值完全一致；其他类型按余额历史推算并以 ≈ 标注
- **用量统计页**：分站点、分模型、分时段的 Token 消耗——今天（按小时）/ 近 24 小时（滚动窗口）/
  近 7 天 / 近 30 天，含消耗趋势柱状图、分模型条形图与明细表（请求数 / 输入输出 / 总 Tokens / 实际消耗，
  金额精确到 4 位小数）。「今天」的合计直接取站点仪表盘同款数字，与站点页面逐字一致；
  小时趋势通过「最后一桶＝当前小时」推断站点时区，跨部署统一到浏览器时区展示。
  数据源：Sub2API 用 `/usage/dashboard/snapshot-v2`（老版本自动回退 trend + models 接口），
  New API 用 `/api/data/self`（需站点开启数据看板）；sk 密钥模式无用量明细接口
- **Sub2API 账号密码模式**：只填邮箱 + 密码，面板自动登录换取令牌；令牌过期时自动用 refresh_token 刷新（支持轮换），刷新失败自动用密码重新登录——**全程无需人工干预**
- **余额预测**：记录余额历史（30 天），线性回归估算日均消耗与预计耗尽时间；点击任意站点查看趋势图（历史折线 + 虚线耗尽投影 + 悬停查看）；识别充值，只按最近一段消耗回归
- **通知告警**：余额偏低 / 耗尽 / 查询失败 / 恢复正常 / 预计即将耗尽（**阈值可按天或小时设置**），状态迁移触发、自动去重、可配重复提醒间隔；支持 10 种渠道：
  Telegram、钉钉（含加签）、企业微信、飞书（含签名）、Bark、ntfy、Server酱（含 sctp 新版）、Resend 邮件、SMTP 邮件（内置零依赖客户端，465 SSL / 587 STARTTLS）、自定义 Webhook，每个渠道可单独测试
- **我的站点（下游分析）**：自己经营 new-api 中转站时，勾选「这是我自己的中转站」
  （需管理员 root 账号的系统访问令牌），即可获得专属分析页——分时段 / 分模型 / **分用户**
  的用量与消费（数据来自 new-api 管理员接口 `/api/data/` 与 `/api/data/users`），
  以及**未来 7 天消费预测**（加权线性趋势 + 星期因子，附 80% 置信区间；历史满两周自动
  启用周末/工作日模式识别）
- **利润分析**：读取自有站的渠道列表，按 base_url 与监控中的上游站点匹配（忽略协议 /
  末尾斜杠 / `/api` 后缀，同 URL 渠道合并）——利润 = 下游收入（**普通用户**消费 ×
  你的售价汇率，管理员/root 自用计成本不计收入）−
  各匹配上游的期内成本（按用量 × 充值汇率；「固定成本」渠道按天摊销：
  每次付费金额 ÷ 覆盖天数 × 窗口天数，且无论是否匹配到渠道都计入；
  用量接口不可用时退回余额下降推算）。未匹配的渠道单独列出，加入监控即可参与计算
- **每日日报**：可设定每天固定时间（服务器时区）自动汇总昨日经营情况——消费环比、
  收入/成本/利润、Top 模型与用户、成本明细、上游余额与耗尽预警、用户余额预收、
  今日与未来 7 天预测——通过通知渠道推送（邮件渠道发全文，IM 渠道自动截断）；
  支持预览与立即发送
- **人民币折算**：每个站点可配置充值汇率（站点 $1 折合 ¥ 多少，如 1:2 充值）；
  余额、消耗、图表等金额主显人民币（未配置按 1:1），站点原始余额作为次要信息展示；
  **余额告警阈值仍按站点余额判断**，不受汇率影响
- **PWA**：支持添加到手机主屏幕以独立窗口运行（含品牌图标与离线壳缓存）。
  iOS Safari「添加到主屏幕」任何环境可用；Android Chrome 的安装提示要求 HTTPS 访问。
  静态资源网络优先（Watchtower 自动更新不受缓存影响），API 不缓存
- **面板登录**：网页需要账号密码登录（scrypt 哈希 + HMAC 签名会话 Cookie，7 天有效；登录失败限流）；默认账号 `admin / admin123`，登录后请在「设置」中修改
- **内置演示**：首次启动自动创建演示中转站（数据来自内置 mock，含完整的登录→过期→自动续期链路演示），可直接删除

## 支持的中转站类型

| 类型 | 查询方式 | 需要填写 |
|------|----------|----------|
| **New API（访问令牌）** | `GET /api/user/self`，头 `Authorization` + `New-Api-User` | 站点地址、系统访问令牌、用户 ID |
| **New API（sk 密钥）** | OpenAI 兼容 `/dashboard/billing/subscription` + `/usage` | 站点地址、`sk-` 密钥 |
| **Sub2API（登录令牌）** | `GET /api/v1/auth/me`，`Bearer JWT` | 站点地址、登录 JWT（过期需手动更换） |
| **Sub2API（账号密码）** | 自动 `POST /api/v1/auth/login` / `refresh` / `me` | 站点地址、登录邮箱、密码（开启 2FA 的账号不支持） |
| **固定成本（不访问）** | 不访问任何接口 | 每次付费金额（¥）+ 覆盖天数；日均摊销计入利润成本，地址可选（用于渠道匹配） |

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

## Docker 部署（含 Watchtower 自动更新）

镜像随 main 分支推送自动构建：`ghcr.io/lettimepassby/relay-monitor:latest`（另有 commit SHA 标签可回滚）。

```bash
mkdir -p ~/relay-monitor && cd ~/relay-monitor
# 下载 deploy/docker-compose.yml 放到这里，然后：
docker compose up -d
```

compose 里包含两个服务：

- **relay-monitor**：面板本体，数据持久化在 `./data`（站点凭证 / 历史 / 会话密钥），升级不丢数据
- **watchtower**：每 5 分钟检查一次镜像更新，发现新版本自动拉取并重启面板、清理旧镜像。
  推送代码 → Actions 构建镜像 → 服务器几分钟内自动更新，页面「设置 → 关于」和侧栏可查看当前运行的版本与构建 commit

> Watchtower 匿名拉取要求 GHCR 镜像包为 public：首次构建后到
> `https://github.com/users/lettimepassby/packages/container/relay-monitor/settings`
> 把 Danger Zone 里的可见性改为 Public（一次即可）；或者在服务器 `docker login ghcr.io` 使用带
> `read:packages` 权限的 PAT。

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
