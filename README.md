# Logbook

基于 Cloudflare Workers + D1 的带密码保护的日志系统。查看、新增、修改、删除全部需要登录。

## 技术栈

| 分类 | 选型 | 说明 |
|---|---|---|
| 运行时 | Cloudflare Workers | 边缘无服务器运行时，全球分布式部署 |
| 开发语言 | TypeScript `^7.0.2` | 严格模式（`strict: true`），`noEmit` 仅做类型检查 |
| Web 框架 | Hono `^4.13.5` | 轻量、边缘友好的路由框架，使用 `app.get/post/put/delete/use` |
| 数据库 | Cloudflare D1（SQLite） | 通过 `DB` binding 访问；建表脚本见 `migrations/0001_init.sql` |
| 构建 / CLI | Wrangler `^4.128.0` | 本地开发、D1 迁移、Secret 管理、部署 |
| 静态资源 | Workers Assets | `./assets` 目录直接托管单页 UI，无需额外 CDN |
| 类型定义 | `@cloudflare/workers-types` `^5.20260902.1` | 提供 `Env` 等 Workers 平台类型 |
| 认证 | HMAC-SHA256 会话 Cookie | 管理密码存 Worker Secret；会话 12h 过期、签名防篡改 |
| 前端 | 原生 HTML / CSS / JS | 单文件 `assets/index.html`，无前端框架、无打包步骤 |
| 持续部署 | GitHub Actions | push 主分支自动 `tsc` 校验 + D1 迁移 + `wrangler deploy` |

**关联配置（wrangler.jsonc）**
- `name: logbook`，入口 `src/index.ts`
- `compatibility_date: 2026-09-01`，`compatibility_flags: ["nodejs_compat"]`
- `observability` 日志采样已开启（`head_sampling_rate: 1`）
- D1 binding 名为 `DB`（代码中通过 `env.DB` 访问，不是 `logbook`）

**核心设计**
- **Service 层模式**：所有 D1 读写封装在 `src/services/`，API 层（`src/index.ts`）只处理 HTTP 请求/响应，不写 SQL。
- **单一管理密码 + 签名会话**：密码存 Cloudflare Secret（`ADMIN_PASSWORD`），会话用 `SESSION_SECRET` 做 HMAC-SHA256 签名；不设 `SESSION_SECRET` 时从密码派生。
- **安全基线**：全部 `prepare().bind()` 参数化查询（防 SQL 注入）；前端统一 `textContent`（防 XSS）；密码恒定时间比较（防时序攻击）；CSV 导出前置单引号（防公式注入）；所有 API 响应 `Cache-Control: no-store`。
- **登录限流**：同一 `CF-Connecting-IP` 连续失败 5 次锁定 15 分钟，登录成功即清零。

## 架构

```
src/
├── index.ts              # HTTP 路由层，只处理请求与响应
├── lib/
│   ├── auth.ts           # 密码校验、会话签发与校验
│   ├── crypto.ts         # HMAC / SHA-256 / base64url / 恒定时间比较
│   ├── format.ts         # CSV / Markdown 导出与公式注入防护
│   └── parseImport.ts    # CSV / Markdown 导入解析
└── services/
    ├── logService.ts     # 日志的 D1 数据访问（含 importLogs 批量写入）
    └── loginGuard.ts     # 登录失败频率限制
assets/index.html         # 单页 UI
migrations/0001_init.sql  # 建表
```

DB 操作全部封装在 service 层，API 层不直接写 SQL。

## 部署步骤

```bash
npm install

# 1. 创建 D1 数据库，把输出的 database_id 填进 wrangler.jsonc
npm run db:create

# 2. 建表（先本地，再生产）
npm run db:migrate:local
npm run db:migrate:remote

# 3. 设置管理密码（必填）
npm run secret:password

# 4. 设置会话签名密钥（选填，不设则从管理密码派生）
npm run secret:session

# 5. 本地验证
npm run dev

# 6. 部署
npm run deploy
```

> 本地开发时把密码写进 `.dev.vars`（该文件已在 `.gitignore` 中，不会提交），可参考 `.dev.vars.example`：
> ```
> ADMIN_PASSWORD=你的本地测试密码
> ```
> 生产环境一律用 `wrangler secret put`，密钥加密存储，不进代码库。

## 部署前准备（只需一次）

```bash
# 1. 登录 Cloudflare（浏览器授权，会写入 ~/.cloudflare/）
npx wrangler login

# 2. 拿到 Account ID（输出在 [Account] 一行）
npx wrangler whoami

# 3. 创建 D1 数据库，把输出的 database_id 填进 wrangler.jsonc 的 database_id
npm run db:create

# 4. 建表（生产库）
npm run db:migrate:remote

# 5. 设置管理密码（必填，加密存储）
npm run secret:password        # 交互式输入，等价于 wrangler secret put ADMIN_PASSWORD

# 6. 部署
npm run deploy
```

### 可选：GitHub Actions 自动部署

仓库已包含 `.github/workflows/deploy.yml`，push 到 `master`（也兼容 `main`）即自动 `tsc` 校验 + D1 迁移 + `wrangler deploy`。
只需在仓库 **Settings → Secrets and variables → Actions** 中添加两个密钥：

| Secret | 说明 |
|---|---|
| `CF_API_TOKEN` | 具有 `Workers Scripts Edit` 与 `D1 Edit` 权限的 API Token |
| `CF_ACCOUNT_ID` | `wrangler whoami` 输出的 Account ID |

> Token 创建地址：Cloudflare 控制台 → My Profile → API Tokens → Create Token → 选 "Edit Cloudflare Workers" 模板，并手动加 `Account → D1 → Edit` 权限。

## 冒烟测试

本地 `npm run dev` 起来后执行，覆盖鉴权、增删改查、参数校验与暴力破解锁定：

```bash
bash smoke-test.sh
```

## 安全设计

| 措施 | 实现 |
|---|---|
| 密码存储 | 存在 Worker Secret 中，不进代码库、不进 Git |
| 密码校验 | 先 SHA-256 再恒定时间比较，防御时序攻击 |
| 会话令牌 | HMAC-SHA256 签名，含过期时间（默认 12 小时） |
| Cookie | `HttpOnly` + `SameSite=Strict` + 生产环境 `Secure` |
| SQL 注入 | 全部 `prepare().bind()`，无字符串拼接 |
| XSS | 前端一律 `textContent` 渲染，不使用 `innerHTML` |
| 暴力破解 | 同一 IP 连续失败 5 次锁定 15 分钟，登录成功即清零 |
| 缓存 | 所有 API 响应 `Cache-Control: no-store` |

> 注意：IP 取自 `CF-Connecting-IP`。若前面还套了其他代理，需要自行确认该头可信。

## API

所有 `/api/logs*` 接口需携带有效会话 Cookie，否则返回 401。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 提交 `{"password": "..."}` 登录 |
| POST | `/api/logout` | 退出，清除 Cookie |
| GET | `/api/session` | 检查登录状态 |
| GET | `/api/logs` | 列表，支持 `limit` `offset` `level` `category` `keyword` |
| GET | `/api/logs/:id` | 单条详情 |
| POST | `/api/logs` | 新增 |
| PUT | `/api/logs/:id` | 修改 |
| DELETE | `/api/logs/:id` | 删除 |
| GET | `/api/categories` | 所有分类 |
| GET | `/api/export` | 导出，需登录。参数：`format=csv\|md`，可选 `level` `category` `keyword` `from` `to`（`YYYY-MM-DD` 或毫秒时间戳） |
| POST | `/api/import` | 导入，需登录。请求体 `{"text": "...", "filename": "x.csv\|x.md"}`，从本系统导出的 CSV / Markdown 还原为新增记录 |

### 导出说明

- **CSV**：带 UTF-8 BOM，Excel 直接双击打开中文不乱码；单元格以 `= + - @` 等开头时自动前置单引号，防御 CSV 公式注入（Excel / Sheets 会把这类内容当公式执行）
- **Markdown**：按创建时间正序排列，适合归档与阅读
- 导出沿用列表的筛选条件，**看到什么就导出什么**；单次最多 2000 条（`MAX_EXPORT_ROWS`），超出会在响应头 `X-Export-Truncated: true` 标记
- 前端在筛选栏点「导出」会弹出对话框，可选格式与日期范围，自动套用当前级别 / 分类 / 关键词筛选

### 导入说明

- **入口**：筛选栏「导入」按钮 → 选文件（`.csv` / `.md` / `.markdown`），或用 `curl -F` / `fetch` 调用 `/api/import`
- **格式识别**：优先按文件扩展名，无扩展名时以 `# ` 开头的按 Markdown 处理，否则按 CSV
- **导入即新增**：解析出的每条都作为新记录插入，原有数据不会被覆盖或更新；时间统一取导入时刻
- **校验与跳过**：每条先经 `normalizeInput` 校验（非空内容、合法级别、长度上限），非法行计入 `skipped` 并提示，合法行写入 `imported`
- **公式注入还原**：导出时加的前置单引号在导入时会去掉，数据可往返（export → import 后内容一致）
- **批量写入**：用 `DB.batch` 一次事务提交，避免逐条 INSERT 的多次往返

## 免费层消耗估算

| 资源 | 单次操作 | 免费额度 |
|---|---|---|
| 列表查询（20 条） | 约 2 次查询，走索引扫 20 行左右 | 500 万行读 / 天 |
| 新增 / 修改 / 删除 | 1 次写 | 10 万行写 / 天 |
| 登录失败 | 1 次写 | 同上 |

个人使用量级下远不会触顶。**唯一的例外是关键词搜索**——`LIKE '%xxx%'` 无法走索引，会扫描全表，靠 `LIMIT` 控制代价，不建议在数据量很大时频繁使用。

## 已知限制

- 单页 UI 的静态资源公开可访问，但这不构成风险，数据全部由 API 层把关，未登录拿不到任何日志内容
- 登录失败计数按 IP 记录，共用出口 IP 的网络下会互相影响
- 无多用户概念，所有人共用同一密码
