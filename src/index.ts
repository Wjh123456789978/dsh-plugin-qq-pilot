/**
 * DSH（DeepSeek Harness）插件：QQ Pilot
 *
 * 作用：把「网页版 QQ」当成一个可被模型操作的环境。
 * - 连接用户自己已经登录的 Chrome（CDP），不碰密码、不存 Cookie 到模型上下文
 * - 读会话 → 模型决策 → 回复消息
 * - 推荐好友只做「候选整理」，加好友必须显式 confirm=true，且有每日上限与最短间隔
 *
 * 插件形态：Cordis 函数插件（export apply），工具通过 ctx.tools.register 注册。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  attach,
  detach,
  getSession,
  pageDigest,
  probe,
  typeAndSend,
  listCandidates,
  clickAddFriend,
  readCookieFile,
  loadState,
  saveState,
  tooFast,
  inActiveWindow,
  captureQr,
  waitForLogin,
  emulateMobile,
  type RuntimeConfig,
} from './ops.js'

export const name = 'qq-pilot'
export const inject = ['tools']

export const Config = z.object({
  cdpUrl: z.string().default('http://127.0.0.1:9222').description('本机 Chrome 的 CDP 调试地址'),
  qqUrl: z.string().default('https://web.qq.com/').description('要操作的 QQ 页面'),
  activeHours: z
    .string()
    .default('')
    .description('允许动作的时段，如 "12:00-13:00,18:00-19:00"；留空表示不限'),
  dailyAddCap: z.number().default(5).description('每天最多通过本插件点几次「添加好友」'),
  minActionGapSec: z.number().default(30).description('两次动作之间的最短间隔（秒），防风控'),
  dryRun: z.boolean().default(false).description('演练模式：只分析不真正发送'),
  mobile: z.boolean().default(false).description('按手机版布局操作（覆盖 UA + 视口 + 触摸）'),
  mobileWidth: z.number().default(390).description('移动端视口宽'),
  mobileHeight: z.number().default(844).description('移动端视口高'),
  userAgent: z.string().default('').description('自定义 UA，留空用内置 Android Chrome UA'),
  cookiesFile: z.string().default('').description('可选：Cookie JSON 文件绝对路径，用于注入登录态'),
  selectors: z
    .object({
      chatList: z.string().default(''),
      inputBox: z.string().default(''),
      sendButton: z.string().default(''),
      recommendList: z.string().default(''),
      addButton: z.string().default(''),
      confirmButton: z.string().default(''),
    })
    .default({}),
})

function asConfig(raw: any): RuntimeConfig {
  return {
    cdpUrl: raw?.cdpUrl || 'http://127.0.0.1:9222',
    qqUrl: raw?.qqUrl || 'https://web.qq.com/',
    activeHours: raw?.activeHours || '',
    dailyAddCap: typeof raw?.dailyAddCap === 'number' ? raw.dailyAddCap : 5,
    minActionGapSec: typeof raw?.minActionGapSec === 'number' ? raw.minActionGapSec : 30,
    dryRun: Boolean(raw?.dryRun),
    mobile: Boolean(raw?.mobile),
    mobileWidth: typeof raw?.mobileWidth === 'number' ? raw.mobileWidth : 390,
    mobileHeight: typeof raw?.mobileHeight === 'number' ? raw.mobileHeight : 844,
    userAgent: raw?.userAgent || '',
    selectors: {
      chatList: raw?.selectors?.chatList || '',
      inputBox: raw?.selectors?.inputBox || '',
      sendButton: raw?.selectors?.sendButton || '',
      recommendList: raw?.selectors?.recommendList || '',
      addButton: raw?.selectors?.addButton || '',
      confirmButton: raw?.selectors?.confirmButton || '',
    },
  }
}

const jsonOut = (v: unknown) => [
  {
    type: 'text' as const,
    text: '```json\n' + JSON.stringify(v, null, 2) + '\n```',
  },
]

export function apply(ctx: Context, rawConfig: any) {
  const cfg = asConfig(rawConfig)

  ctx.effect(() => {
    return () => {
      void detach()
    }
  })

  const guard = (): string | null => {
    if (!inActiveWindow(cfg.activeHours)) {
      return `当前不在允许时段（${cfg.activeHours}），已拒绝动作。`
    }
    return null
  }

  // 1) 连接浏览器 ---------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'qq_attach',
      description:
        '连接本机已登录的 Chrome（CDP），定位或打开网页版 QQ 页面。第一次使用必须先调这个。',
      parameters: {},
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute() {
        const s = await attach(cfg)
        const url = s.page.url()
        const title = await s.page.title().catch(() => '')
        return { ok: true, url, title, hint: url.includes('login') ? '看起来未登录，请先在浏览器里登录' : '已连接' }
      },
    }),
  )

  // 2) 探测页面元素 -------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'qq_probe',
      description:
        '扫描当前 QQ 页面，列出可交互元素及其 CSS 选择器（输入框/按钮等）。用于把结果填进 selectors 配置。',
      parameters: {
        limit: { type: 'number', required: false, description: '最多返回多少条，默认 40' },
      },
      output: { schema: { type: 'array' }, render: (_a, v) => jsonOut(v) },
      async execute(args: any) {
        const s = getSession() ?? (await attach(cfg))
        const items = await probe(s.page, args?.limit ?? 40)
        return { count: items.length, items }
      },
    }),
  )

  // 3) 注入 Cookie --------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'qq_inject_cookies',
      description:
        '把本地 Cookie JSON 注入当前浏览器上下文（仅 .qq.com 域），然后刷新页面。Cookie 不会出现在模型上下文里。',
      parameters: {
        cookiesFile: { type: 'string', required: false, description: 'Cookie JSON 绝对路径；缺省用配置里的 cookiesFile' },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute(args: any) {
        const file = args?.cookiesFile || cfg.cookiesFile
        const cookies = readCookieFile(file)
        const s = getSession() ?? (await attach(cfg))
        const context = s.page.context()
        await context.addCookies(cookies)
        await s.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
        const url = s.page.url()
        return { ok: true, injected: cookies.length, url, loggedIn: !url.includes('login') }
      },
    }),
  )

  // 4) 读取会话 -----------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'qq_read',
      description:
        '读取当前 QQ 页面的会话文本（末尾 N 字），供模型判断要不要回、怎么回。建议先 qq_probe 绑定 selectors.chatList 更准。',
      parameters: {
        maxChars: { type: 'number', required: false, description: '最多取末尾多少字符，默认 4000' },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute(args: any) {
        const s = getSession() ?? (await attach(cfg))
        const text = await pageDigest(s.page, cfg.selectors, args?.maxChars ?? 4000)
        return { chars: text.length, text }
      },
    }),
  )

  // 5) 截图 ---------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'qq_screenshot',
      description: '对当前 QQ 页面截图并保存到临时目录，返回文件路径，便于用视觉模型查看。',
      parameters: {},
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute() {
        const s = getSession() ?? (await attach(cfg))
        const file = path.join(os.tmpdir(), `qq-shot-${Date.now()}.png`)
        await s.page.screenshot({ path: file, fullPage: false })
        return { ok: true, path: file, bytes: fs.statSync(file).size }
      },
    }),
  )

  // 6) 发送消息 -----------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'qq_reply',
      description:
        '在当前会话的输入框里输入文字并发送。受 activeHours 与 dryRun 约束。发送前请先用 qq_read 看清上下文。',
      parameters: {
        text: { type: 'string', required: true, description: '要发送的文本' },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute(args: any) {
        const deny = guard()
        if (deny) return { ok: false, reason: deny }
        const s = getSession() ?? (await attach(cfg))
        const r = await typeAndSend(s.page, cfg.selectors, String(args.text), cfg.dryRun)
        const st = loadState()
        st.lastActionAt = Date.now()
        saveState(st)
        return { ok: r.ok, how: r.how }
      },
    }),
  )

  // 7) 推荐好友候选 -------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'qq_candidates',
      description:
        '读取「可能认识/推荐好友」列表里的昵称。只读，不会添加。需要先绑定 selectors.recommendList。',
      parameters: {},
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute() {
        const s = getSession() ?? (await attach(cfg))
        const names = await listCandidates(s.page, cfg.selectors)
        return {
          count: names.length,
          names,
          hint: names.length === 0 ? '没读到候选，先用 qq_probe 找 recommendList 的选择器' : '仅供筛选，添加需 qq_add_friend 且 confirm=true',
        }
      },
    }),
  )

  // 8) 加好友（高危） -----------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'qq_add_friend',
      description:
        '对推荐列表里的某个昵称点「添加」。必须 confirm=true 才会执行；受每日上限与最短间隔限制。默认不自动点确认弹窗，需要人工在页面上点「确定」。',
      parameters: {
        nickname: { type: 'string', required: true, description: '推荐列表里出现的昵称（精确匹配）' },
        confirm: { type: 'boolean', required: true, description: '必须显式传 true，表示你确认要添加这个人' },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute(args: any) {
        const deny = guard()
        if (deny) return { ok: false, reason: deny }
        if (args?.confirm !== true) {
          return { ok: false, reason: '缺少 confirm=true。加好友属于外发动作，需要显式确认。' }
        }

        const st = loadState()
        if (st.addedCount >= cfg.dailyAddCap) {
          return { ok: false, reason: `今日已达上限 ${cfg.dailyAddCap} 次，明天再来。` }
        }
        const wait = tooFast(st, cfg.minActionGapSec)
        if (wait > 0) {
          return { ok: false, reason: `动作太快，请等 ${wait} 秒。` }
        }

        const s = getSession() ?? (await attach(cfg))
        const r = await clickAddFriend(s.page, cfg.selectors, String(args.nickname), cfg.dryRun, cfg.mobile)
        if (r.clicked) {
          st.addedCount += 1
          st.lastActionAt = Date.now()
          saveState(st)
        }
        return { ok: r.clicked, note: r.note, todayAdded: st.addedCount, cap: cfg.dailyAddCap }
      },
    }),
  )

  // 9) 扫码登录 -----------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'qq_login_qr',
      description:
        '打开网页版 QQ 登录页并抓取二维码，保存成 PNG，返回文件路径。用户拿手机 QQ 扫码后，再调 qq_login_wait 确认是否登录成功。',
      parameters: {
        forceOpen: {
          type: 'boolean',
          required: false,
          description: '即使已登录也强制打开登录页重新出码，默认 false',
        },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute(args: any) {
        const s = await attach(cfg)
        if (args?.forceOpen) {
          await s.page.goto(cfg.qqUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        }
        const already = !String(s.page.url()).includes('login')
        const out = path.join(os.tmpdir(), `qq-qr-${Date.now()}.png`)
        const r = await captureQr(s.page, out)
        const ctxCookies = await s.page.context().cookies('https://qq.com')
        const loggedIn = ctxCookies.some((c: any) => /^(uin|skey)$/i.test(c.name))
        return {
          ok: true,
          qrPath: r.path,
          box: r.box,
          pageUrl: s.page.url(),
          alreadyLoggedIn: loggedIn || (!already && false),
          hint: '把 qrPath 指向的图片给用户扫；扫完调用 qq_login_wait 等待登录态。',
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'qq_login_wait',
      description:
        '轮询等待扫码登录完成（以 qq.com 的关键 Cookie 出现为准）。超时返回 loggedIn=false，不会假装成功。',
      parameters: {
        timeoutSec: { type: 'number', required: false, description: '最长等待秒数，默认 120' },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute(args: any) {
        const s = getSession() ?? (await attach(cfg))
        const r = await waitForLogin(s.page, args?.timeoutSec ?? 120)
        return {
          ...r,
          hint: r.loggedIn ? '登录成功，可以继续 qq_read / qq_reply' : '还没登成功；二维码可能失效，重新 qq_login_qr',
        }
      },
    }),
  )

  // 10) 切换移动端 / 桌面端 ------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'qq_set_mobile',
      description:
        '运行时切换手机版或桌面版布局（覆盖 UA、视口、触摸）。手机上跑就开 true，桌面浏览器就开 false。切换后建议 reload 一次。',
      parameters: {
        mobile: { type: 'boolean', required: true, description: 'true=手机版布局，false=桌面版' },
        width: { type: 'number', required: false, description: '移动端视口宽，默认 390' },
        height: { type: 'number', required: false, description: '移动端视口高，默认 844' },
        reload: { type: 'boolean', required: false, description: '切换后是否刷新页面，默认 true' },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute(args: any) {
        const s = getSession() ?? (await attach(cfg))
        cfg.mobile = Boolean(args?.mobile)
        if (typeof args?.width === 'number') cfg.mobileWidth = args.width
        if (typeof args?.height === 'number') cfg.mobileHeight = args.height
        if (cfg.mobile) {
          const applied = await emulateMobile(s.page, cfg)
          if (args?.reload !== false) {
            await s.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
          }
          return { ok: true, mode: 'mobile', applied, url: s.page.url() }
        }
        return { ok: true, mode: 'desktop', note: 'UA 覆盖需要重新连接浏览器才会完全恢复' }
      },
    }),
  )

  // 11) 状态 ---------------------------------------------------------------


  ctx.tools.register(
    defineTool({
      name: 'qq_status',
      description: '查看插件状态：是否已连接、当前页面、时段、今日加好友计数、配置摘要。',
      parameters: {},
      output: { schema: { type: 'object' }, render: (_a, v) => jsonOut(v) },
      async execute() {
        const s = getSession()
        const st = loadState()
        return {
          attached: Boolean(s),
          url: s ? s.page.url() : null,
          inWindow: inActiveWindow(cfg.activeHours),
          activeHours: cfg.activeHours || '不限',
          todayAdded: st.addedCount,
          dailyAddCap: cfg.dailyAddCap,
          minActionGapSec: cfg.minActionGapSec,
          dryRun: cfg.dryRun,
          selectors: cfg.selectors,
        }
      },
    }),
  )
}
