/**
 * 免装扩展地把登录态导出成 JSON（供 qq_inject_cookies 使用）。
 *
 * 用法：
 *   1. 用带调试端口的 Chrome 打开并登录网页版 QQ（小号）
 *   2. node tools/export-cookies.mjs http://127.0.0.1:9222 > qq-cookies.json
 *
 * 注意：文件名别提交到任何仓库；这是账号凭证。
 */
import { writeFileSync } from 'node:fs'

const cdp = process.argv[2] || 'http://127.0.0.1:9222'
const outFile = process.argv[3] || 'qq-cookies.json'

const pw = await import('playwright-core')
const browser = await pw.chromium.connectOverCDP(cdp)
const ctx = browser.contexts()[0]
if (!ctx) {
  console.error('没有可用的浏览器上下文')
  process.exit(1)
}
const cookies = await ctx.cookies()
const qq = cookies.filter((c) => c.domain.includes('qq.com'))

writeFileSync(outFile, JSON.stringify(qq, null, 2), { mode: 0o600 })
console.log(`已导出 ${qq.length} 条 qq.com Cookie → ${outFile}`)
await browser.close()
