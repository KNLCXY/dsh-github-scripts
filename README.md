# dsh-github-scripts

三个**互相独立、零依赖**的小脚本，用来处理 GitHub 上那些「网页能做、API 不能做」和「看不到页面就不知道哪里坏了」的活。只用 Node 内置模块（`child_process` / `node:fs` / 内置 `WebSocket`），不需要 `npm install`。

> 这些脚本是 [dsh-github](https://github.com/KNLCXY/dsh-github) 插件里那一份的镜像，单独发一个仓库是为了**不装插件也能用**。
> **仓库里不含任何 token / 密钥**：脚本要么用你浏览器里已登录的会话，要么把拿到的 token 写到你自己的临时文件。

| 脚本 | 什么时候用 | 需要什么 |
|---|---|---|
| `gh-web-commit.mjs` | **没有 token** 也要往仓库提交单个文件（走网页编辑器） | 一个已登录 GitHub 的 Chrome/Chromium profile |
| `gh-device-login.mjs` | 想要一个能写仓库的 token，但不想手动点 OAuth 授权页 | 同上；脚本会自动走「设备码 → 授权」 |
| `chrome-probe.mjs` | 页面在自动化下打不开/不渲染，想换启动参数对比 | 任意 Chrome/Chromium |

## 前置

- **Node 22+**（内置 `WebSocket`、`fetch`）。没装 Node 也能用 DSH 自带的那个：
  ```bash
  ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness 目录>/DeepSeek Harness.exe" scripts/chrome-probe.mjs https://example.com
  ```
- **一份 Chromium 系内核**（Chrome / Edge / Brave / 应用内置的都行），能跑 `--remote-debugging-port`

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_CHROME` | 内核可执行文件路径 | 脚本里写的一个 Windows 路径（换机器必改） |
| `DSH_GH_PROFILE` | 浏览器 profile 目录（登录态存在这里） | `%TEMP%/dsh-github-profile` |

两个脚本都认 `--chrome <path>` / `--profile <dir>` 参数，优先于环境变量。

---

## `gh-web-commit.mjs`：不用 token 提交文件

```bash
node scripts/gh-web-commit.mjs <owner/repo> <仓库内路径> <本地文件> [--dry]
```

- 打开 GitHub 的「新建文件」页面，填入内容和路径，点两次「Commit changes」
- `--dry` 只填内容并截住提交请求，**不真提交**（用来确认接口形状）

**为什么需要它**：建/改 token、授权 OAuth 都受 sudo 保护（要邮箱验证码），但网页提交文件不需要。

**踩过的坑**（脚本已内置修复）：GitHub 的文件编辑器在 `navigator.webdriver === true` 时**整块不渲染**，页面只剩 `Files main` 骨架；启动参数加 `--disable-blink-features=AutomationControlled` 才正常。

---

## `gh-device-login.mjs`：走 OAuth 设备流换 token

```bash
node scripts/gh-device-login.mjs [--scope "repo read:org"] [--port 9444] [--visible]
```

流程：申请设备码 → 在浏览器里输入码 → 点授权 → 轮询拿到 `gho_` token。

- token **不打印到 stdout**，写进 `%TEMP%/gh-device-token.txt`（`.gitignore` 已排除），自己保管或删掉
- 用的是 gh CLI 的公开 `client_id`（设备流不需要 `client_secret`），授权记录会出现在你 GitHub 的「授权应用」里，可随时撤销
- 为什么不能交给浏览器工具做：设备流的「输码 → 授权」发生在一次真实表单提交之后，必须保持同一个页面上下文才能点「Authorize」

---

## `chrome-probe.mjs`：换启动参数排查渲染问题

```bash
node scripts/chrome-probe.mjs <url> [--js "表达式"] [--wait 6000] [--flag "--foo"] [--visible]
```

打印页面在指定参数下的执行结果。典型用法 —— 验证自动化特征是否被识别：

```bash
node scripts/chrome-probe.mjs "https://github.com/<you>/<repo>/new/main" \
  --js "JSON.stringify({wd:navigator.webdriver, editors:document.querySelectorAll('.cm-content').length})" \
  --flag "--disable-blink-features=AutomationControlled"
```

---

## 安全边界

| 事项 | 做法 |
|---|---|
| 仓库里有 token 吗 | **没有**。全仓库搜不到任何 token 形状的字符串 |
| 脚本会存 token 吗 | `gh-device-login` 会把结果写到 `%TEMP%`（本机临时目录），不进仓库、不进对话 |
| `gh-web-commit` 用什么身份 | 你浏览器 profile 里已登录的会话，脚本**不读密码** |
| 会碰你的仓库吗 | 只在显式传了 `<owner/repo>` 时操作；`--dry` 可先空跑 |

## 许可

[MIT](LICENSE)。与 GitHub、Google、DeepSeek 均无隶属关系。
