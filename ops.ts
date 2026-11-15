/**
 * 网页版 QQ 的底层操作helper。
 *
 * 设计原则：
 * 1) 只通过 CDP 连「用户自己已经登录好的浏览器」，插件本身不登录、不保存密码。
 * 2) Cookie 只在浏览器上下文里使用，绝不进入模型上下文。
 * 3) 所有"高危动作"（加好友）都要显式确认参数 + 每日上限 + 最短间隔。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface SelectorConfig {
  /** 会话区域容器（读消息用） */
  chatList: string
  /** 输入框 */
  inputBox: string
  /** 发送按钮 */
  sendButton: string
  /** "可能认识/推荐好友"列表容器 */
  recommendList: string
  /** 推荐项里的"添加"按钮（留空则脚本自己去页面找） */
  addButton: string
  /** 添加后的确认弹窗按钮 */
  confirmButton: string
}

export interface RuntimeConfig {
  cdpUrl: string
  qqUrl: string
  /** 是否按移动端（手机版布局）操作 */
  mobile: boolean
  /** 模拟的视口尺寸（移动端生效） */
  mobileWidth: number
  mobileHeight: number
  /** 自定义 UA；留空用内置 Android Chrome UA */
  userAgent: string
  selectors: SelectorConfig
  activeHours: string
  dailyAddCap: number
  minActionGapSec: number
  dryRun: boolean
}

/** 进程内缓存的浏览器 / 页面句柄，插件卸载时清理。 */
export interface Session {
  browser: any
  page: any
}

let session: Session | null = null

export function getSession(): Session | null {
  return session
}

export async function attach(cfg: RuntimeConfig): Promise<Session> {
  if (session) return session
  let pw: any
  try {
    pw = await import('playwright-core')
  } catch {
    throw new Error(
      '缺少 playwright-core 依赖。请在 DSH 所在目录执行：pnpm add playwright-core（或 npm i playwright-core --save）。' +
        '如果你不想装浏览器内核，请用系统 Chrome 启动 --remote-debugging-port=9222 后再调用本工具。',
    )
  }
  const browser = await pw.chromium.connectOverCDP(cfg.cdpUrl)
  let page: any = null
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (String(p.url()).includes('qq.com')) {
        page = p
        break
      }
    }
    if (page) break
  }
  if (!page) {
    const ctx = browser.contexts()[0] ?? (await browser.newContext())
    page = await ctx.newPage()
    await page.goto(cfg.qqUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  }
  if (cfg.mobile) {
    await emulateMobile(page, cfg)
  }
  session = { browser, page }
  return session
}

/** 通过 CDP 覆盖 UA 与设备指标，让网页 QQ 走手机版布局。 */
export async function emulateMobile(page: any, cfg: RuntimeConfig): Promise<{ ua: string; width: number; height: number }> {
  const ua =
    cfg.userAgent ||
    'Mozilla/5.0 (Linux; Android 15; ANN-AN00 Build/AP3A.240905.015) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  const width = cfg.mobileWidth || 390
  const height = cfg.mobileHeight || 844
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua })
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 3,
    mobile: true,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  try {
    await cdp.detach()
  } catch {
    /* 忽略 */
  }
  return { ua, width, height }
}

export async function detach(): Promise<void> {
  if (!session) return
  try {
    // 只断开连接，不关闭用户的浏览器
    await session.browser?.close?.()
  } catch {
    /* 忽略 */
  }
  session = null
}

/** 判断是否在允许的时段内；activeHours 为空表示不限。 */
export function inActiveWindow(activeHours: string, now = new Date()): boolean {
  if (!activeHours.trim()) return true
  const hm = now.getHours() * 60 + now.getMinutes()
  for (const part of activeHours.split(',')) {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
    if (!m) continue
    const start = Number(m[1]) * 60 + Number(m[2])
    const end = Number(m[3]) * 60 + Number(m[4])
    if (start <= end && hm >= start && hm <= end) return true
    if (start > end && (hm >= start || hm <= end)) return true // 跨零点
  }
  return false
}

// ---- 状态（每日加好友计数） ------------------------------------------------

function stateFile(): string {
  return path.join(os.tmpdir(), 'dsh-qq-pilot-state.json')
}

interface PilotState {
  day: string
  addedCount: number
  lastActionAt: number
}

export function loadState(): PilotState {
  const today = new Date().toISOString().slice(0, 10)
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as PilotState
    if (s.day === today) return s
  } catch {
    /* 首次 */
  }
  return { day: today, addedCount: 0, lastActionAt: 0 }
}

export function saveState(s: PilotState): void {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2))
  } catch {
    /* 忽略 */
  }
}

export function tooFast(s: PilotState, minGapSec: number): number {
  const gap = (Date.now() - (s.lastActionAt || 0)) / 1000
  return gap < minGapSec ? Math.ceil(minGapSec - gap) : 0
}

// ---- Cookie ---------------------------------------------------------------

export interface CookieSeed {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  expirationDate?: number
}

/** 从 JSON 文件读取 cookie；支持 Chrome 扩展导出的数组，或 {cookies:[...]}。 */
export function readCookieFile(file: string): CookieSeed[] {
  if (!file) throw new Error('没有提供 cookiesFile')
  const abs = path.isAbsolute(file) ? file : path.resolve(file)
  if (!fs.existsSync(abs)) throw new Error(`cookie 文件不存在：${abs}`)
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'))
  const arr = Array.isArray(raw) ? raw : (raw.cookies ?? [])
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('cookie 文件里没有可用条目')
  return arr.map((c: any) => ({
    name: String(c.name),
    value: String(c.value),
    domain: c.domain || '.qq.com',
    path: c.path || '/',
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite || 'Lax'),
    expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined,
  }))
}

// ---- 页面读取 -------------------------------------------------------------

export async function pageDigest(page: any, selectors: SelectorConfig, maxChars = 4000): Promise<string> {
  const text = await page.evaluate(
    ({ sel, limit }: { sel: string; limit: number }) => {
      let node: Element | null = null
      if (sel) {
        try {
          node = document.querySelector(sel)
        } catch {
          node = null
        }
      }
      const src = node ?? document.body
      return (src as HTMLElement).innerText.replace(/\n{3,}/g, '\n\n').slice(-limit)
    },
    { sel: selectors.chatList, limit: maxChars },
  )
  return String(text ?? '').trim()
}

/** 探测页面上可交互的元素，返回可用于绑定选择器的候选。 */
export async function probe(page: any, limit = 40) {
  return await page.evaluate((lim: number) => {
    function cssPath(el: Element): string {
      const parts: string[] = []
      let cur: Element | null = el
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        let part = cur.tagName.toLowerCase()
        const id = cur.getAttribute('id')
        if (id) {
          part += `#${CSS.escape(id)}`
          parts.unshift(part)
          break
        }
        const cls = (cur.getAttribute('class') || '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
        if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.')
        const parent: Element | null = cur.parentElement
        if (parent) {
          const idx = Array.from(parent.children).indexOf(cur) + 1
          part += `:nth-child(${idx})`
        }
        parts.unshift(part)
        cur = parent
      }
      return parts.join(' > ')
    }
    const out: any[] = []
    const seen = new Set<Element>()
    const push = (el: Element, kind: string) => {
      if (seen.has(el)) return
      seen.add(el)
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      out.push({
        kind,
        tag: el.tagName.toLowerCase(),
        text: ((el as HTMLElement).innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '')
          .trim()
          .slice(0, 40),
        selector: cssPath(el),
      })
    }
    for (const el of document.querySelectorAll('textarea, input[type=text], input:not([type])')) push(el, 'input')
    for (const el of document.querySelectorAll('[contenteditable=true]')) push(el, 'editable')
    for (const el of document.querySelectorAll('button, [role=button], a')) {
      const t = ((el as HTMLElement).innerText || '').trim()
      if (/发送|添加|确定|好友|可能认识|推荐/.test(t)) push(el, 'button')
    }
    return out.slice(0, lim)
  }, limit)
}

// ---- 动作 -----------------------------------------------------------------

export async function typeAndSend(
  page: any,
  selectors: SelectorConfig,
  text: string,
  dryRun: boolean,
): Promise<{ ok: boolean; how: string }> {
  if (dryRun) return { ok: true, how: 'dryRun（未真正发送）' }

  const inputSel = selectors.inputBox
  const target = await page.evaluate((sel: string) => {
    let el: Element | null = null
    if (sel) {
      try {
        el = document.querySelector(sel)
      } catch {
        el = null
      }
    }
    if (!el) el = document.querySelector('[contenteditable=true]') || document.querySelector('textarea')
    if (!el) return null
    const rect = (el as HTMLElement).getBoundingClientRect()
    ;(el as HTMLElement).scrollIntoView({ block: 'center' })
    return { sel: el.tagName.toLowerCase(), editable: (el as HTMLElement).isContentEditable, ok: rect.width > 0 }
  }, inputSel)

  if (!target || !target.ok) throw new Error('找不到输入框，请先用 qq_probe 绑定 selectors.inputBox')

  const box = selectors.inputBox
    ? await page.$(selectors.inputBox)
    : await page.$('[contenteditable=true]')
  if (!box) throw new Error('输入框定位失败')
  await box.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text, { delay: 8 })

  let sent = false
  if (selectors.sendButton) {
    try {
      await page.click(selectors.sendButton, { timeout: 3000 })
      sent = true
    } catch {
      sent = false
    }
  }
  if (!sent) {
    await page.keyboard.press('Enter')
  }
  return { ok: true, how: selectors.sendButton && sent ? '点击发送按钮' : '回车发送' }
}

export async function listCandidates(page: any, selectors: SelectorConfig): Promise<string[]> {
  const sel = selectors.recommendList
  if (!sel) return []
  return await page.evaluate((s: string) => {
    let root: Element | null = null
    try {
      root = document.querySelector(s)
    } catch {
      root = null
    }
    if (!root) return []
    const names: string[] = []
    for (const el of root.querySelectorAll('*')) {
      const t = (el as HTMLElement).innerText?.trim() || ''
      if (!t || t.length > 20) continue
      if (el.children.length > 2) continue
      if (!names.includes(t)) names.push(t)
    }
    return names.slice(0, 30)
  }, sel)
}

export async function clickAddFriend(
  page: any,
  selectors: SelectorConfig,
  nickname: string,
  dryRun: boolean,
  mobile = false,
): Promise<{ clicked: boolean; note: string }> {
  const hit = await page.evaluate(
    ({ rootSel, name }: { rootSel: string; name: string }) => {
      let root: Element | null = null
      try {
        root = document.querySelector(rootSel)
      } catch {
        root = null
      }
      const scope: Element = root ?? document.body
      const items = Array.from(scope.querySelectorAll('*')).filter(
        (el) => ((el as HTMLElement).innerText || '').trim() === name,
      )
      const target = items[items.length - 1]
      if (!target) return null
      // 在附近找按钮
      let p: Element | null = target
      for (let i = 0; i < 5 && p; i++) {
        const btns = Array.from(p.querySelectorAll('button, [role=button], a')).filter((b) =>
          /添加|加好友/.test(((b as HTMLElement).innerText || '').trim()),
        )
        if (btns.length) {
          const b = btns[0] as HTMLElement
          const r = b.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        }
        p = p.parentElement
      }
      const r = (target as HTMLElement).getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    },
    { rootSel: selectors.recommendList, name: nickname },
  )

  if (!hit) throw new Error(`推荐列表里没找到「${nickname}」`)
  if (dryRun) return { clicked: false, note: 'dryRun，未点击' }

  if (mobile) {
    await page.touchscreen.tap(hit.x, hit.y)
  } else {
    await page.mouse.click(hit.x, hit.y)
  }
  return {
    clicked: true,
    note: '已点击；若是弹窗确认，需要你在页面上点「确定」或配置 selectors.confirmButton',
    mode: mobile ? 'tap' : 'mouse',
  }
}

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

// ---- 扫码登录 -------------------------------------------------------------

/**
 * 抓取页面上的登录二维码。
 * 不依赖固定选择器：先按常见特征找，再退化成「页面上最大的正方形图片/画布」。
 */
export async function captureQr(page: any, outFile: string): Promise<{ path: string; box: any }> {
  const box = await page.evaluate(() => {
    const cands: Element[] = []
    const push = (e: Element | null) => {
      if (e) cands.push(e)
    }
    for (const sel of ['img[src*="qr"]', 'canvas', '[class*="qrcode"]', '[class*="qr"]', '[id*="qr"]']) {
      try {
        document.querySelectorAll(sel).forEach(push)
      } catch {
        /* 忽略非法选择器 */
      }
    }
    let best: { el: Element; area: number } | null = null
    for (const el of cands) {
      const r = el.getBoundingClientRect()
      if (r.width < 80 || r.height < 80) continue
      const ratio = r.width / r.height
      if (ratio < 0.8 || ratio > 1.25) continue
      const area = r.width * r.height
      if (!best || area > best.area) best = { el, area }
    }
    if (!best) {
      for (const el of Array.from(document.querySelectorAll('img')) as Element[]) {
        const r = el.getBoundingClientRect()
        const ratio = r.width / (r.height || 1)
        if (r.width < 100 || ratio < 0.8 || ratio > 1.25) continue
        const area = r.width * r.height
        if (!best || area > best.area) best = { el, area }
      }
    }
    if (!best) return null
    const r = best.el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })

  if (!box) throw new Error('页面上没找到二维码元素。请确认窗口处于登录页，或手动截图。')
  await page.screenshot({ path: outFile, clip: box })
  return { path: outFile, box }
}

/** 轮询等待扫码成功：以 qq.com 的关键 Cookie 出现为准。 */
export async function waitForLogin(
  page: any,
  timeoutSec: number,
  onTick?: (elapsed: number) => void,
): Promise<{ loggedIn: boolean; elapsed: number; cookies: string[] }> {
  const start = Date.now()
  const deadline = start + timeoutSec * 1000
  while (Date.now() < deadline) {
    const cookies = await page.context().cookies('https://qq.com')
    const names = cookies.map((c: any) => c.name)
    const hit = names.filter((n: string) => /^(uin|skey|p_skey|luin)$/i.test(n))
    if (hit.length >= 2) {
      return { loggedIn: true, elapsed: Math.round((Date.now() - start) / 1000), cookies: hit }
    }
    onTick?.(Math.round((Date.now() - start) / 1000))
    await new Promise((r) => setTimeout(r, 3000))
  }
  const cookies = await page.context().cookies('https://qq.com')
  return {
    loggedIn: false,
    elapsed: Math.round((Date.now() - start) / 1000),
    cookies: cookies.map((c: any) => c.name),
  }
}
