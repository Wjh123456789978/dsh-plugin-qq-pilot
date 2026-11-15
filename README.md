# dsh-plugin-qq-pilot

给 **DSH（DeepSeek Harness）** 用的插件。不是浏览器扩展，是 Cordis 插件（`export function apply(ctx)`），装进 DSH 后由模型调用工具，去操作**你自己浏览器里已登录的网页版 QQ**。

装好 → 填配置 → 让模型调 `qq_login_qr` 出二维码 → 你拿手机 QQ 小号扫码 → `qq_login_wait` 确认登录 → 之后模型就能读会话、代发消息、整理推荐好友。

---

## 它做什么 / 不做什么

**做：**
- 连本机 Chrome（CDP），定位或打开 `web.qq.com`
- 抓登录二维码成 PNG，等你扫码，并轮询确认登录成功（按 `uin` / `skey` 等 Cookie 判定）
- 可选：从本地 Cookie JSON 注入登录态（凭证只在浏览器上下文，不进模型 prompt）
- 读会话文本摘要，交给模型决策
- 代发消息（受时段 / 演练模式约束）
- 列推荐好友昵称（只读）
- 点「添加好友」——**必须显式 `confirm=true`**，有每日上限 + 最短间隔，默认不替你点确认弹窗

**不做：**
- 不存密码、不接管账号密码、不把 Cookie 塞进模型上下文
- 不自动批量加人（默认上限 5/天，可改，但别调高）
- 不绕过风控、不模拟设备指纹

---

## 前置条件

1. Node `^22.19.0` 或 `>=24`（DSH 的要求）
2. 已经能跑 `npx @deepseek-ai/dsh web`
3. 本机 Chrome 以调试端口启动：

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\qqpilot-profile"

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/qqpilot-profile"

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/qqpilot-profile"
```

> 单独 `user-data-dir` 很重要：不要用你日常主浏览器，避免小号和你主号/小号互相污染登录态。

4. 装依赖（在插件目录）：

```bash
pnpm add playwright-core
# 或 npm i playwright-core
```

> 走 CDP 连接**不需要** `playwright install` 下载浏览器内核，直接借你本机 Chrome。

---

## 安装到 DSH

### 方式 A：源码 patch（最直接，推荐先试）

```bash
# 1) 改 cordis.yml 里的 name 为你的真实绝对路径
# 2) 在 deepseek-harness 仓库根目录
pnpm dsh web --patch /你的绝对路径/dsh-plugin-qq-pilot/cordis.yml
```

启动后终端应出现插件加载日志，Web UI 的工具列表里会出现 `qq_*` 一组工具。

### 方式 B：作为包加进 profile

```bash
dsh plugin --profile web add /你的绝对路径/dsh-plugin-qq-pilot
```

> 这条依赖 `dsh plugin` 对本地路径 spec 的支持程度，不同版本可能不同；失败就用方式 A。

---

## 配置

`cordis.yml` 里的 `config`：

```yaml
cdpUrl: 'http://127.0.0.1:9222'
qqUrl: 'https://web.qq.com/'
activeHours: '12:00-13:00,18:00-19:00'   # 只在这个时段允许发消息/加好友，留空=不限
dailyAddCap: 3                            # 每天最多点几次「添加」
minActionGapSec: 60                       # 两次动作最短间隔
dryRun: true                              # 先演练，别一上来真发
cookiesFile: ''                            # 可选，cookie JSON 绝对路径
selectors:
  chatList: ''            # 会话区域容器
  inputBox: ''            # 输入框
  sendButton: ''          # 发送按钮
  recommendList: ''       # 「可能认识」列表容器
  addButton: ''
  confirmButton: ''
```

---

## 使用流程（照做）

1. **连上浏览器**
   让模型调 `qq_attach` → 返回 `url` / `title`。
   如果 `url` 里带 `login`，说明没登录。

2. **出二维码给你扫**
   调 `qq_login_qr` → 返回 `qrPath`（本地 PNG 路径）。
   打开这张图，用**小号**手机 QQ 扫。
   让模型把这张图直接展示给你（DSH Web UI 里可以用看图/附件方式打开这个路径）。

3. **确认登录**
   调 `qq_login_wait`（默认等 120 秒）。
   - `loggedIn: true` → 成了
   - 超时 → 二维码多半过期，重新 `qq_login_qr`

4. **绑定选择器**（关键，因为网页 QQ 的 DOM 因版本而异）
   调 `qq_probe`，它会列出输入框、可编辑区、带「发送/添加/确定」字样的按钮，并给出 CSS 选择器。
   把结果填进 `selectors`，重启插件生效。

5. **读会话 → 回复**
   `qq_read` 拿到会话摘要，模型判断；`qq_reply` 真正发。建议先 `dryRun: true` 跑一遍。

6. **推荐好友（可选）**
   `qq_candidates` 读昵称 → 模型筛选 → `qq_add_friend` 且 `confirm: true`。
   默认不点确认弹窗，剩下的「确定」由你在页面上点。

---

## Cookie 注入（可选）

不想每次扫码，可以把登录态存成 JSON：

```bash
node tools/export-cookies.mjs http://127.0.0.1:9222 qq-cookies.json
```

然后在配置里填 `cookiesFile: /绝对路径/qq-cookies.json`，用 `qq_inject_cookies` 注入。
**这个文件等于账号凭证，别上传、别进 git、别贴进对话。**

---

## 工具一览

| 工具 | 作用 | 风险 |
|---|---|---|
| `qq_attach` | 连浏览器、定位 QQ 页 | 无 |
| `qq_login_qr` | 抓二维码 PNG | 无 |
| `qq_login_wait` | 等扫码登录 | 无 |
| `qq_probe` | 列可交互元素 + 选择器 | 无 |
| `qq_inject_cookies` | 注入 cookie 并刷新 | 凭证敏感 |
| `qq_read` | 读会话摘要 | 无 |
| `qq_screenshot` | 截图存盘 | 无 |
| `qq_reply` | 发消息 | 外发动作，受时段约束 |
| `qq_candidates` | 读推荐昵称 | 只读 |
| `qq_add_friend` | 点添加 | **需 confirm + 上限 + 间隔** |
| `qq_status` | 看状态 | 无 |

---

## 已知限制（先看这段，别踩坑）

1. **选择器没实测过。** 网页版 QQ 的 DOM 我没法在这台机器上对着真实页面验证，所以 `selectors` 默认是空。必须用 `qq_probe` 绑一次，否则读会话会退化成整页 innerText（能读，但很脏）。
2. **网页版 QQ 功能可能不全。** 新增好友、推荐列表这些入口在网页端不一定都有；如果 `qq_candidates` 一直返回空，说明这个页面根本没有「可能认识」——那这条路走不通，只能换手机端 RPA。
3. **Cookie 生命周期短、异地会掉。** 扫码登录比塞 cookie 稳，优先扫码。
4. **`qq_login_wait` 判定靠 cookie 名**（`uin`/`skey`/`p_skey`/`luin` 至少两个）。如果 QQ 改了 cookie 命名，判定会失效——那就是我的判断逻辑过期了，不是登录失败。
5. **风控。** 自动化操作 QQ 属于非官方路径，只用小号、单独浏览器 profile、单独 IP，别批量加人。
6. **DSH 是 Developer Preview**，破坏性升级可能导致这个插件加载失败，日志里看 Fiber 状态即可。

---

## 移动端（手机版布局）

`mobile: true` 时插件会通过 CDP 覆盖 UA、视口和触摸能力，让网页 QQ 走手机版布局；加好友的点击也会从 `mouse.click` 换成 `touchscreen.tap`。

运行时也能切，不用重启：

```
qq_set_mobile({ mobile: true, width: 390, height: 844 })
```

### 安卓上怎么给插件一个"浏览器"

CDP 默认只听 `127.0.0.1`，手机上最省事的接法是把设备端的 devtools socket 映射到电脑：

```bash
# 手机开 USB 调试，连上电脑后
adb forward tcp:9222 localabstract:chrome_devtools_remote
```

然后插件用 `cdpUrl: http://127.0.0.1:9222` 就能连到手机上的 Chrome。

如果 DSH 就跑在手机上（Termux），把 `cdpUrl` 指到本机对应端口即可；这种跑法要注意 Termux 后台被系统杀掉的问题。

> 注意：上面这句讲的是「插件连哪个浏览器」。插件自身是 Node 代码，跑在 DSH 所在的那台机器上。

---

## 目录

```
dsh-plugin-qq-pilot/
├── package.json
├── cordis.yml                  # 桌面版 --patch 覆盖层（改 name 成绝对路径）
├── examples/
│   └── mobile-cordis.yml       # 手机版布局的配置示例
├── src/
│   ├── index.ts                # 插件入口：Config + 11 个工具
│   └── ops.ts                  # CDP、读页、输入、二维码、移动端模拟、限速状态
├── tools/
│   └── export-cookies.mjs      # 导出 qq.com cookie 为 JSON（可选）
├── docs/
│   ├── ARCHITECTURE.md         # 架构、模块划分、安全边界、架构性弱点
│   └── DEVELOPMENT.md          # 开发记录：为什么这么做、踩了哪些坑
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 为什么用 CDP、模块怎么分、安全边界写死在哪、这套架构的弱点
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — 开发过程与决策记录，含踩坑清单
- [CHANGELOG.md](CHANGELOG.md) — 版本变更

## 路线图

- [ ] 按消息节点解析会话（带发言人归属），替代整段 innerText
- [ ] 选择器自愈：`qq_probe` 失败时按文本特征重新定位
- [ ] 每会话独立人设与记忆
- [ ] 限速状态落进 DSH 存储服务，而不是系统临时目录

## 免责声明

本项目用于**操作自己的账号**，不提供任何绕过平台风控、批量加陌生人、自动化营销的能力。使用非官方路径操作 QQ 存在账号受限风险，请只用小号、独立浏览器配置、独立网络环境。作者不对账号状态、数据丢失或平台处罚承担责任。使用前请自行确认是否符合 QQ 用户协议。

---

MIT License
