# 开发记录

这份文档按时间顺序记「为什么这么写」，不是 API 手册。想看用法去 README。

## 起因

需求很具体：让模型替一个 QQ 小号干活——读消息、回消息、整理"可能认识"的人。不想要官方机器人（那是另一个身份），也不想装协议客户端（风控太狠）。

第一版想的是浏览器扩展：装在小号浏览器里，读页面、调模型、点按钮。写完发现方向不对，原因三条：

1. 扩展的权限模型拿不到完整的会话上下文，跨域、跨 frame 都受限；
2. 扩展里调模型要走 background，等于自己又实现一遍 provider；
3. 用户明确说要"装进 DSH 的东西"，扩展和 DSH 是两套体系。

于是整包推倒，改成 DSH 插件。

## DSH 插件的形状

查完官方文档，定下三条：

- 形态：**函数插件**（`export function apply(ctx, config)`），不是对象/类形态。理由是这里不需要对外提供服务，只注册工具。
- 依赖：`inject = ['tools']`。只要工具注册表在，这个插件就能干活；`ctx.llm` 那些用不到，不声明。
- 配置：Schemastery 声明 + 默认值，让 DSH 在加载前就把非法配置挡掉。

第一次照着文档写 `defineTool` 时踩了个小坑：`parameters` 用的是"扁平对象"而不是标准 JSON Schema（`{ name: { type: 'string', required: true } }`），和一般 SDK 的写法不一样，写错不会报错，只会让模型看不到参数。

## 为什么第一版就带限速

需求里有一句"通过可能认识加好友"。这句话如果不设闸门，结果只有一个：模型看到 20 个候选，一激动点 20 次，账号当场进风控名单。

所以从第一版就写死三件事：

- `dailyAddCap`（默认 5，实际建议 3）
- `minActionGapSec`（默认 30）
- `confirm: true` 显式确认，缺了就拒绝

这三条不是"以后再加"，是"没有就不准合并"。宁可功能少，不能把账号玩坏。

## 扫码登录这一段

用户预期的交互是"装好 → 填配置 → 出二维码 → 手机扫"，和市面上那些 QQ 机器人插件一样。

技术上有两条做法：

- **A. 让用户从手机 QQ 里复制 cookie 粘进去**：难、容易错、cookie 还容易过期。
- **B. 直接抓登录页的二维码图片，用户扫完轮询 cookie**：符合用户直觉。

选 B。抓二维码时不敢写死选择器，因为网页 QQ 每次改版 DOM 都变。退而求其次，写了个启发式：

1. 依次尝试 `img[src*="qr"]`、`canvas`、`[class*="qrcode"]`、`[class*="qr"]`、`[id*="qr"]`
2. 在候选里筛"边长 ≥ 80px 且宽高比接近 1"的，取面积最大的
3. 全都不中，退化到"页面上最大的正方形 `<img>`"

这不优雅，但比写死一个 `.qrcode-img` 活得久。

登录判定用 cookie 名而不是页面文案：`uin` / `skey` / `p_skey` / `luin` 里出现 ≥2 个就算登录。理由是页面文案会变、会被 A/B 测试，cookie 名相对稳定。如果哪天 QQ 改了命名，判定会失效——那时它会老老实实返回 `loggedIn: false`，不会假装成功。

## 移动端适配（1.1.0）

用户的原话是"不仅要适配网页版，还要适配手机"。

这里要区分两件事，很多人会混：

- **插件跑在哪**：DSH 在哪儿跑。插件是 Node 代码，跑在 DSH 那台机器上。
- **浏览器在哪**：被操作的那个 Chrome 在哪。可以在同一台，也可以远程（注意 CDP 默认只监听 127.0.0.1，跨机要自己开隧道）。

"适配手机"我按第一种理解落地：**让被操作的浏览器呈现手机版布局**，因为 QQ 在手机版布局下才有完整的入口（比如推荐好友）。

实现方式不是改 UA 字符串那么简单，Playwright 对已连接的 context 改不了 UA，只能走 CDP 底层：

```ts
const cdp = await page.context().newCDPSession(page)
await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua })
await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true })
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
```

顺带把点击也改了：`mobile` 为真时用 `page.touchscreen.tap(x, y)`，否则 `page.mouse.click(x, y)`。手机上用 mouse 事件，有些组件不响应。

Android 侧的实际接法写在 README：用 Chrome 的 `chrome://inspect` 走 `adb forward`，把设备的 devtools socket 映射到本机端口，再让插件连 `http://127.0.0.1:9222`。

## 明确不做的事

- **不代填密码**。插件里没有任何"输入账号密码"的代码路径，扫码是唯一入口。
- **不存 cookie 到磁盘**。`tools/export-cookies.mjs` 是给人手动跑的，产物由用户自己保管，`.gitignore` 里已经把 `qq-cookies.json` 挡住。
- **不自动点确认弹窗**。加好友最后一步永远留给人。这不是技术做不到，是故意的。
- **不做群发**。当前只有"当前会话回复"，没有"遍历好友批量发"。加这个功能等于把工具变成 spam 机器。

## 踩过的坑（按发现顺序）

1. `defineTool` 的参数声明格式和常见 SDK 不一样，写扁平对象不写 JSON Schema。
2. `inject` 写少了，`ctx.tools` 就是 undefined，插件进 PENDING 不出声，日志里只有一行"等待依赖"。
3. 给已连接的浏览器改 UA，`context.setExtraHTTPHeaders` 无效，只能走 CDP session。
4. `page.keyboard.type` 中文没问题，但输入框如果是 contenteditable 且带富文本，要先 `Control+A` + `Backspace` 清空，否则会拼在旧内容后面。
5. 二维码截图用 `clip` 之前必须 `scrollIntoView`，否则元素在视口外时截出来是空白。
6. 状态文件最初写在插件目录，热更新时被清掉；后来改成 `os.tmpdir()`，代价是重启机器计数归零——权衡后接受（宁可少算，不能多算）。

## 下一步想做的

- 按消息节点解析会话（带昵称归属），而不是抓一大段 innerText
- 选择器自愈：`qq_probe` 失败时用文本特征重新定位
- 每个会话独立的人设与记忆
- 把限速状态落进 DSH 的存储服务，而不是临时文件

## 时间线

| 日期 | 事件 |
|---|---|
| 2026-11-15 | 决定走 CDP + DSH 插件方案，弃掉浏览器扩展 |
| 2026-11-15 | 1.0.0：10 个工具跑通，扫码 → 读会话 → 回复链路闭环 |
| 2026-11-15 | 1.1.0：加移动端模拟与触摸点击，补 `qq_set_mobile` |
| 2026-11-15 | 公开仓库，补架构与开发文档 |
