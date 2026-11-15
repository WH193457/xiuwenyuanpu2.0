import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import sharp from 'sharp'

const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.setDefaultTimeout(20_000)
const canvas = page.locator('.dynamic-canvas')
const status = page.locator('.dynamic-playback-status')
const frame = () => canvas.evaluate(element => element.toDataURL('image/png'))
const count = async () => Number((await status.innerText()).match(/([\d,]+)个针脚/u)[1].replaceAll(',', ''))

async function setRange(name, end) {
  await page.getByLabel(name, { exact: true }).press(end)
  await page.waitForTimeout(80)
}

try {
  await page.goto(`${baseUrl}/dynamic?pattern=DX008`)
  await page.getByRole('button', { name: '暂停流动', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.dynamic-actions button')?.disabled)
  assert.equal(await page.getByLabel('流动纹谱纹样').inputValue(), 'DX008')
  assert.ok(await count() > 0)
  const runningBefore = await frame()
  await page.waitForTimeout(200)
  assert.notEqual(await frame(), runningBefore, 'Animation must visibly change its canvas')
  await page.getByRole('button', { name: '暂停流动', exact: true }).click()
  const frozen = await frame()
  await page.waitForTimeout(700)
  assert.equal(await frame(), frozen, 'Pause must preserve the entire frame including stitches')

  await setRange('针脚密度', 'Home')
  const lowDensity = await count()
  const sparse = await frame()
  await setRange('针脚密度', 'End')
  assert.ok(await count() > lowDensity * 3, 'Density must immediately change the active stitches')
  assert.notEqual(await frame(), sparse)
  await setRange('原纹叠加', 'Home')
  const stitchesOnly = await frame()
  await setRange('原纹叠加', 'End')
  assert.notEqual(await frame(), stitchesOnly, 'Reference-image opacity must visibly update while paused')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存当前画面', exact: true }).click()
  const download = await downloadPromise
  assert.equal(download.suggestedFilename(), 'DX008-流动纹谱.png')
  const exportBytes = await readFile(await download.path())
  const exported = await sharp(exportBytes).metadata()
  const canvasSize = await canvas.evaluate(element => ({ width: element.width, height: element.height }))
  assert.equal(exported.format, 'png')
  assert.equal(exported.width, canvasSize.width)
  assert.equal(exported.height, canvasSize.height)
  const frozenData = Buffer.from((await frame()).split(',')[1], 'base64')
  assert.deepEqual(await sharp(exportBytes).raw().toBuffer(), await sharp(frozenData).raw().toBuffer(), 'Export must contain the actual displayed pixels')

  await page.getByRole('button', { name: '重置参数', exact: true }).click()
  assert.equal(await page.getByLabel('针脚密度', { exact: true }).inputValue(), '1')
  assert.equal(await page.getByLabel('原纹叠加', { exact: true }).inputValue(), '0.7')
  await page.getByRole('button', { name: '继续流动', exact: true }).click()
  const resumed = await frame()
  await page.waitForTimeout(200)
  assert.notEqual(await frame(), resumed)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hiddenFrame = await frame()
  await page.waitForTimeout(250)
  assert.equal(await frame(), hiddenFrame, 'A hidden document must not continue drawing')
  await page.evaluate(() => {
    delete document.hidden
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(150)
  assert.notEqual(await frame(), hiddenFrame, 'The visibility handler must resume the animation')

  await page.getByLabel('流动纹谱纹样').selectOption('DX027')
  await page.waitForURL('**/dynamic?pattern=DX027')
  await page.waitForFunction(() => !document.querySelector('.dynamic-actions button')?.disabled)
  assert.equal(await page.getByRole('link', { name: '母纹带入文创贴图' }).getAttribute('href'), '/workshop?pattern=DX027&source=library')
  await page.goBack()
  await page.waitForFunction(() => document.querySelector('.dynamic-panel select')?.value === 'DX008')
  assert.equal(await page.getByLabel('流动纹谱纹样').inputValue(), 'DX008')
  await page.goForward()
  await page.waitForFunction(() => document.querySelector('.dynamic-panel select')?.value === 'DX027')
  assert.equal(await page.getByLabel('流动纹谱纹样').inputValue(), 'DX027')
  await page.getByText('TouchDesigner工程', { exact: true }).click()
  const toeUrl = await page.getByRole('link', { name: '下载纹样图片.8.toe', exact: true }).getAttribute('href')
  assert.equal((await context.request.head(`${baseUrl}${toeUrl}`)).status(), 200)

  await page.getByRole('button', { name: '暂停流动', exact: true }).click()
  const stage = await page.locator('.dynamic-stage').boundingBox()
  assert.ok(stage.height <= 780, 'Desktop canvas must not grow to the height of the full controls panel')
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
  await page.locator('h1').scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/dynamic-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  const stageMobile = await page.locator('.dynamic-stage').boundingBox()
  const panelMobile = await page.locator('.dynamic-panel').boundingBox()
  assert.ok(stageMobile.y < panelMobile.y, 'Mobile preview must precede the controls')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  await page.locator('.dynamic-stage').scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/dynamic-mobile.png' })

  const reducedContext = await browser.newContext({ reducedMotion: 'reduce' })
  const reducedPage = await reducedContext.newPage()
  await reducedPage.goto(`${baseUrl}/dynamic?pattern=DX042`)
  await reducedPage.waitForFunction(() => !document.querySelector('.dynamic-actions button')?.disabled)
  assert.ok(await reducedPage.getByRole('button', { name: '继续流动', exact: true }).isVisible())
  await reducedContext.close()

  const failedContext = await browser.newContext()
  const failedPage = await failedContext.newPage()
  await failedPage.route('**/patterns/detail/DX027.webp', route => route.abort())
  await failedPage.goto(`${baseUrl}/dynamic?pattern=DX027`)
  await failedPage.getByRole('button', { name: '重新加载纹样', exact: true }).waitFor()
  await failedPage.unroute('**/patterns/detail/DX027.webp')
  await failedPage.getByRole('button', { name: '重新加载纹样', exact: true }).click()
  await failedPage.waitForFunction(() => !document.querySelector('.dynamic-actions button')?.disabled)
  await failedContext.close()

  const samplePixels = Buffer.alloc(200 * 200 * 4)
  for (const [startX, startY] of [[20, 20], [160, 20], [20, 160], [160, 160]]) {
    for (let y = startY; y < startY + 20; y += 1) {
      for (let x = startX; x < startX + 20; x += 1) samplePixels[(y * 200 + x) * 4 + 3] = 255
    }
  }
  const transparentSample = await sharp(samplePixels, { raw: { width: 200, height: 200, channels: 4 } }).png().toBuffer()
  const sampleContext = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } })
  const samplePage = await sampleContext.newPage()
  await samplePage.route('**/patterns/detail/DX042.webp', route => route.fulfill({ contentType: 'image/png', body: transparentSample }))
  await samplePage.goto(`${baseUrl}/dynamic?pattern=DX042`)
  await samplePage.waitForFunction(() => !document.querySelector('.dynamic-actions button')?.disabled)
  await samplePage.getByLabel('针脚密度', { exact: true }).press('End')
  const sampleCount = Number((await samplePage.locator('.dynamic-playback-status').innerText()).match(/([\d,]+)个针脚/u)[1].replaceAll(',', ''))
  assert.ok(sampleCount > 300 && sampleCount < 900, 'Transparent background pixels must not become black stitches')
  await samplePage.getByLabel('针脚密度', { exact: true }).press('Home')
  await samplePage.getByLabel('起伏幅度', { exact: true }).press('Home')
  await samplePage.getByLabel('原纹叠加', { exact: true }).press('Home')
  await samplePage.waitForTimeout(100)
  const quadrants = await samplePage.locator('.dynamic-canvas').evaluate(element => {
    const { data } = element.getContext('2d').getImageData(0, 0, element.width, element.height)
    const counts = [0, 0, 0, 0]
    for (let y = 0; y < element.height; y += 1) {
      for (let x = 0; x < element.width; x += 1) {
        if (data[(y * element.width + x) * 4] < 18) counts[(y >= element.height / 2 ? 2 : 0) + (x >= element.width / 2 ? 1 : 0)] += 1
      }
    }
    return counts
  })
  assert.ok(quadrants.every(value => value > 10), 'Low-density monochrome stitches must remain in all four image quadrants')
  await sampleContext.close()
  assert.deepEqual(errors, [])
  console.log('Dynamic page passed: changing frames, exact pause, live density/opacity, PNG pixels, reset, visibility suspension, URL back/forward, toe download, bounded desktop canvas, mobile preview order, reduced motion, failed-image retry, transparent sampling, and spatially complete monochrome sampling.')
} finally {
  await context.close()
  await browser.close()
}
