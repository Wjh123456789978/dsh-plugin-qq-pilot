# dist/ — 各平台成品包

这里放 `v1.1.1` 三个平台压缩包的仓库内副本，方便「一个仓库拿到全部东西」。
GitHub Releases 是发布清单，内容与这里一致。

| 文件 | 适用平台 | 默认配置 |
|---|---|---|
| `qq-pilot-1.1.1-win-linux.zip` | Windows 10/11、Linux（含 WSL2） | `mobile: false`，桌面布局 |
| `qq-pilot-1.1.1-android.zip` | Android 10–15（64 位） | `mobile: true`，390×844 |
| `qq-pilot-1.1.1-source.zip` | 通用 / 想自己改 | 桌面布局 + `examples/mobile-cordis.yml` |

macOS 不在适配范围。

包内结构：`src/`（入口 + 操作层）、`tools/`、`examples/`、`docs/`（架构与开发记录）、`cordis.yml`、`package.json`、`README.md`、`PLATFORMS.md`、`CHANGELOG.md`、`LICENSE`。
