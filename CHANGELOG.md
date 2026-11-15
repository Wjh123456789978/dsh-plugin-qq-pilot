# Changelog

## 1.1.0 — 2026-11-15

### Added
- 移动端适配：`mobile` / `mobileWidth` / `mobileHeight` / `userAgent` 配置项
- `qq_set_mobile` 工具，运行时可切换手机版 / 桌面版布局（UA + 视口 + 触摸）
- `emulateMobile()`：通过 `Emulation.setUserAgentOverride` + `Emulation.setDeviceMetricsOverride` + `Emulation.setTouchEmulationEnabled` 实现
- 加好友点击在移动端改用 `touchscreen.tap`，桌面端仍用 `mouse.click`

## 1.0.0 — 2026-11-15

### Added
- 初始版本：Cordis 函数插件，注册 10 个工具
- `qq_attach` / `qq_login_qr` / `qq_login_wait` / `qq_probe` / `qq_read` / `qq_reply`
- `qq_candidates` / `qq_add_friend` / `qq_inject_cookies` / `qq_status`
- 扫码登录：抓二维码为 PNG，轮询 `uin` / `skey` / `p_skey` / `luin` 判定登录态
- 速率限制：每日加好友上限、动作最短间隔、活跃时段窗口
- Cookie 注入与导出脚本（凭证只留在浏览器上下文）
