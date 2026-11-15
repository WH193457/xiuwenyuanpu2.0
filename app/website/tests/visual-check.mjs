import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const out = resolve('test-results')
const base = 'http://127.0.0.1:4173'
await mkdir(out, { recursive: true })

const browserCandidates = [
  process.env.BROWSER_PATH,
  process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  chromium.executablePath(),
].filter(Boolean)
const browserPath = browserCandidates.find((candidate) => existsSync(candidate))
if (!browserPath) throw new Error('未找到Playwright Chromium、Edge或Chrome；也可通过BROWSER_PATH指定浏览器。')
const browser = await chromium.launch({ executablePath: browserPath, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
let allowSam3ConnectionFailure = false
await page.addInitScript(() => sessionStorage.clear())
page.on('console', (message) => {
  if (message.type() !== 'error') return
  if (allowSam3ConnectionFailure && message.text().includes('net::ERR_CONNECTION_REFUSED')) return
  errors.push(`console:${message.text()}`)
})
page.on('pageerror', (error) => errors.push(`pageerror:${error.message}`))

async function open(target, path) {
  await target.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  await target.locator('header.site-header').waitFor()
}

await open(page, '/')
if (await page.locator('h1').filter({ hasText: '绣纹元谱' }).count() !== 1) throw new Error('首页主标题缺失')
if (await page.locator('.album').count() !== 6) throw new Error('六类纹样册页数量错误')
if (await page.locator('.flow-traditional .flow-card').count() !== 48) throw new Error('持续纹样轨道未按24件双份构建')
const movingRow = page.locator('.flow-traditional .flow-row-a')
const motionAt0 = await movingRow.evaluate(element => getComputedStyle(element).transform)
await page.screenshot({ path: resolve(out, 'home-motion-0.png') })
await page.waitForTimeout(10000)
const motionAt10 = await movingRow.evaluate(element => getComputedStyle(element).transform)
if (motionAt0 === motionAt10) throw new Error('纹样轨道在10秒内没有持续移动')
await page.screenshot({ path: resolve(out, 'home-motion-10.png') })
await page.waitForTimeout(20000)
const motionAt30 = await movingRow.evaluate(element => getComputedStyle(element).transform)
if (motionAt10 === motionAt30) throw new Error('纹样轨道在30秒内没有持续移动')
await page.screenshot({ path: resolve(out, 'home-motion-30.png') })

await page.getByRole('button', { name: '暂停纹样流动' }).click()
await page.mouse.move(2, 2)
await page.waitForTimeout(200)
const pausedAt0 = await movingRow.evaluate(element => getComputedStyle(element).transform)
await page.waitForTimeout(700)
const pausedAt1 = await movingRow.evaluate(element => getComputedStyle(element).transform)
if (pausedAt0 !== pausedAt1) throw new Error('手动暂停未能停止纹样轨道')
await page.getByRole('button', { name: '继续纹样流动' }).click()
await page.mouse.move(2, 2)
await page.waitForTimeout(700)
if (pausedAt1 === await movingRow.evaluate(element => getComputedStyle(element).transform)) throw new Error('继续按钮未能恢复纹样轨道')

const firstFlowCard = page.locator('.flow-traditional .flow-card').first()
await page.locator('.flow-hero').hover({ position: { x: 40, y: 150 } })
await page.waitForTimeout(200)
const hoverAt0 = await movingRow.evaluate(element => getComputedStyle(element).transform)
await page.waitForTimeout(700)
if (hoverAt0 !== await movingRow.evaluate(element => getComputedStyle(element).transform)) throw new Error('悬停时纹样轨道未暂停')
await firstFlowCard.evaluate(element => element.focus())
const focusAt0 = await movingRow.evaluate(element => getComputedStyle(element).transform)
await page.waitForTimeout(700)
if (focusAt0 !== await movingRow.evaluate(element => getComputedStyle(element).transform)) throw new Error('键盘聚焦时纹样轨道未暂停')
await page.locator('body').click({ position: { x: 4, y: 4 } })

const fonts = await page.evaluate(() => ({
  body: getComputedStyle(document.body).fontFamily,
  eyebrow: getComputedStyle(document.querySelector('.eyebrow')).fontFamily,
  title: getComputedStyle(document.querySelector('.home-intro h1')).fontFamily,
}))
if (!fonts.body.includes('Source Serif 4') || !fonts.body.includes('Noto Serif SC')) throw new Error('正文没有使用Wényàng同系字体栈')
if (!fonts.eyebrow.includes('EB Garamond')) throw new Error('英文题注没有使用EB Garamond')
if (!fonts.title.includes('Noto Serif SC')) throw new Error('中文大标题没有使用Noto Serif SC')
await page.screenshot({ path: resolve(out, 'home-1440.png'), fullPage: true })

const routeThemes = [['/', 'jiangnan'], ['/patterns', 'catalogue'], ['/patterns/DX017', 'plate'], ['/create', 'atelier'], ['/evaluate', 'review']]
const themeColors = []
for (const [path, theme] of routeThemes) {
  await open(page, path)
  if (await page.locator('.site-shell').getAttribute('data-theme') !== theme) throw new Error(`${path} 页面主题映射错误`)
  themeColors.push(await page.locator('.site-shell').evaluate(element => getComputedStyle(element).backgroundColor))
}
if (new Set(themeColors).size !== routeThemes.length) throw new Error('五个页面没有形成独立背景主题')

await open(page, '/patterns')
await page.locator('.pattern-card').first().waitFor()
if (await page.locator('.pattern-card').count() !== 80) throw new Error('纹样库未加载80条数据')
await page.locator('.search-field input').fill('踩歌堂')
await page.waitForTimeout(350)
if (await page.locator('.pattern-card').count() < 1) throw new Error('搜索筛选失败')
await page.screenshot({ path: resolve(out, 'patterns-filtered-1440.png'), fullPage: true })

await open(page, '/patterns/DX017')
if (await page.getByText('资料支持', { exact: true }).count() !== 1) throw new Error('证据层级未显示')
if (await page.getByText('踩歌堂耶罗纹·三人连臂式', { exact: true }).count() < 1) throw new Error('DX017详情未加载')

allowSam3ConnectionFailure = true
await open(page, '/deconstruct')
await page.getByText('服务未连接', { exact: true }).waitFor({ timeout: 8000 })
if (!await page.getByRole('button', { name: '开始智能拆解' }).isDisabled()) throw new Error('SAM3未配置时拆解按钮仍可点击')
if (await page.locator('.analysis-toolbar select option').count() !== 80) throw new Error('析纹台未加载80件母纹')
await page.screenshot({ path: resolve(out, 'deconstruct-without-sam3-1440.png'), fullPage: true })
allowSam3ConnectionFailure = false

await open(page, '/create?patterns=DX060')
await page.getByRole('button', { name: '生成应用提案' }).click()
await page.locator('.mockup-grid').waitFor({ timeout: 5000 })
if (await page.locator('.mockup').count() !== 3) throw new Error('创生结果数量错误')
await page.screenshot({ path: resolve(out, 'create-result-1440.png'), fullPage: true })

await open(page, '/evaluate')
await page.getByRole('button', { name: '保存本次评阅' }).click()
await page.locator('.save-stamp').waitFor()
if (await page.getByText('已录', { exact: true }).count() !== 1) throw new Error('落印反馈失败')

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })
await open(mobile, '/')
await mobile.screenshot({ path: resolve(out, 'home-390.png'), fullPage: true })
if (!await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)) throw new Error('首页移动端横向溢出')
await open(mobile, '/patterns')
await mobile.locator('.pattern-card').first().waitFor()
await mobile.screenshot({ path: resolve(out, 'patterns-390.png'), fullPage: true })
if (!await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)) throw new Error('纹样库移动端横向溢出')

const tablet = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 })
await open(tablet, '/patterns/DX017')
await tablet.screenshot({ path: resolve(out, 'detail-1024.png'), fullPage: true })
if (!await tablet.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)) throw new Error('详情页平板端横向溢出')

const reduced = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 })
await reduced.emulateMedia({ reducedMotion: 'reduce' })
await open(reduced, '/')
const reducedState = await reduced.locator('.flow-hero').evaluate(element => ({
  reducedClass: element.classList.contains('is-reduced'),
  animation: getComputedStyle(element.querySelector('.flow-row-a')).animationName,
  viewportOverflow: getComputedStyle(element.querySelector('.flow-viewport')).overflowX,
}))
if (!reducedState.reducedClass || reducedState.animation !== 'none' || !['auto', 'scroll'].includes(reducedState.viewportOverflow)) throw new Error('减少动态模式没有降级为手动横向浏览')

if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`)
console.log('PASS: 6 routes, no-SAM3 fallback, demo interactions, 3 responsive viewports, no browser errors')
await browser.close()
