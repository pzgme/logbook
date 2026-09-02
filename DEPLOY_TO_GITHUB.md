# 推送到 GitHub（公开库）+ 配置 Actions 自动部署

> ⚠️ 以下步骤需在你的**本机终端**（PowerShell 或 Git Bash）执行，因为需要浏览器授权登录 GitHub，沙箱环境无法完成。

## 前置条件

1. 已安装 [GitHub CLI](https://cli.github.com/)（`gh`）：`gh --version` 验证
2. 已安装 Node 22+：`node --version`
3. 已有一个 Cloudflare API Token，具备 `Workers Scripts Edit` + `D1 Edit` 权限
   - 创建地址：Cloudflare 控制台 → My Profile → API Tokens → Create Token → 选 "Edit Cloudflare Workers" 模板，并手动追加 `Account → D1 → Edit`

## 步骤

### 1. 登录 GitHub（浏览器授权）

```powershell
gh auth login
```

按提示选择 GitHub.com → HTTPS → 浏览器授权。

### 2. 创建公开仓库并关联远程

```powershell
cd "D:\code\logbook"   # 进入你的项目目录（本例为 D:\code\logbook，请按实际路径替换）

# 创建公开仓库（仓库名 logbook，自动添加为 origin 远程）
gh repo create logbook --public --source=. --remote=origin

# 推送 master 分支
git push -u origin master
```

> 如果你已有现成仓库想用，跳过上一步，改为：
> ```powershell
> git remote add origin <你的仓库URL>
> git push -u origin master
> ```

### 3. 在 GitHub 配置两个 Secrets

进入 **仓库 → Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret 名 | 值 |
|---|---|
| `CF_API_TOKEN` | 第 1 步前置条件里创建的 Cloudflare API Token |
| `CF_ACCOUNT_ID` | `wrangler whoami` 输出的 Account ID |

### 4. 验证自动部署

推送后 GitHub Actions 会自动触发：`tsc 类型检查 → D1 迁移 → wrangler deploy`。
在 **仓库 → Actions** 标签查看运行日志，看到绿色对勾即成功。

部署地址形如 `https://<worker-name>.<你的Cloudflare账号子域>.workers.dev`（本例 worker 名为 `logbook`，子域即你 Cloudflare 账号的默认子域）。

## 重要说明

- **管理密码已存在 Cloudflare Secret 中**：之前 `npm run secret:password` 已把 `ADMIN_PASSWORD` 设到生产环境，Actions 部署不会覆盖它，所以无需在 GitHub 再配密码。
- **迁移幂等**：`wrangler d1 migrations apply logbook --remote` 已建表会跳过，不会重复建表或丢数据。
- **`.dev.vars` 不会进库**：里面只有本地测试密码，已被 gitignore 排除。本地调试用 `npm run dev` 读取它。
- **公开库注意**：`database_id`（`5002d9cb-...`）会出现在公开代码中。该值 Cloudflare 不视为密钥，无 Token 无法操作数据库，可放心公开。若日后想完全解耦，可将其替换为占位符并改用本地部署。

## 后续改动

以后只需 `git push`，GitHub Actions 自动部署，无需再手动 `wrangler deploy`。
