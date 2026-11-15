# 平台支持

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows 10 / 11 | ✅ 支持 | Chrome 走 `--remote-debugging-port`，DSH 在 Windows 上跑 Node |
| Linux（含 WSL2） | ✅ 支持 | 同上；WSL2 连 Windows 侧 Chrome 需把 `cdpUrl` 指向 `host.docker.internal` 或 Windows 主机 IP |
| Android 10–15（64 位） | ✅ 支持 | Termux 里跑 DSH + 手机 Chrome 开调试接口，或电脑 `adb forward` 接管手机 Chrome |
| macOS | ❌ 不适配 | 本版本不提供 macOS 说明与配置，未做验证，也不承诺可用 |

> 插件本体是 Node 代码 + `playwright-core`，不编译、无原生依赖，所以跨平台成本很低。
> 真正的差异在「浏览器怎么开调试端口」和「默认配置走桌面布局还是手机布局」。

## 各系统怎么起浏览器

### Windows

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:USERPROFILE\qqpilot-profile"
```

### Linux

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/qqpilot-profile"
```

### Android（两种接法）

**A. DSH 跑在电脑上，浏览器在手机上**

```bash
adb forward tcp:9222 localabstract:chrome_devtools_remote
```

插件配 `cdpUrl: http://127.0.0.1:9222`、`mobile: true`。

**B. DSH 直接跑在手机上（Termux）**

```bash
pkg install nodejs-lts git
git clone https://github.com/Wjh123456789978/dsh-plugin-qq-pilot.git
cd dsh-plugin-qq-pilot && npm i
termux-wake-lock   # 防止后台被杀
```

手机 Chrome 需支持远程调试（Chrome DevTools 接口默认只监听 localabstract，Termux 内用 `adb` 或 root 端口转发；部分机型需用支持调试端口的浏览器）。

## 不支持的用法

- 用插件自带浏览器内核去登录（本插件不下载内核，只借你已有的浏览器）
- 在 macOS 上按本文档操作（没验证过，不保证）
