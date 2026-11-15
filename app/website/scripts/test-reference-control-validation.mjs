import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(root, 'outputs/reference-control-validation-2026-11-09')
const summary = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'))
const state = JSON.parse(await readFile(resolve(output, 'state.json'), 'utf8'))
const visualReview = JSON.parse(await readFile(resolve(output, 'visual-review.json'), 'utf8'))
const checksum = async path => createHash('sha256').update(await readFile(path)).digest('hex')

assert.equal(summary.completedImages, 72)
assert.equal(summary.completedJobs, 24)
assert.equal(summary.failedAttempts, 0)
assert.equal(summary.humanRatingsCollected, 0)
assert.equal(visualReview.actor, 'assistant')
assert.equal(visualReview.reviewedImageCount, 72)
assert.deepEqual(state.failures, {})
for (const sample of summary.samples) {
  assert.equal(await checksum(resolve(output, sample.image)), sample.sha256)
  assert.equal(await checksum(sample.originalPath), sample.sha256)
  assert.ok(existsSync(resolve(output, sample.detailImage)))
  assert.equal(sample.configuredInferenceSteps, 30)
  assert.equal(sample.observedDenoisingSteps, sample.methodId === 'T' ? null : 16)
}

const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }),
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const errors = []
const failedRequests = []
page.on('pageerror', error => errors.push(error.message))
page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))

try {
  await page.goto(pathToFileURL(resolve(output, 'index.html')).href)
  await page.evaluate(async () => {
    document.querySelectorAll('details').forEach(element => { element.open = true })
    await Promise.all([...document.images].map(async image => {
      image.loading = 'eager'
      await image.decode()
    }))
  })
  assert.equal(await page.locator('img').count(), 78)
  assert.equal(await page.locator('.sheet').count(), 6)
  assert.equal(await page.locator('.details figure img').count(), 72)
  assert.equal(await page.getByRole('link', { name: '打开高清图集' }).count(), 6)
  const body = await page.locator('body').innerText()
  assert.match(body, /四组计划72张，实际完成 72\/72 张/)
  assert.match(body, /I\/F\/R实测16个去噪步，T记录为配置30步/)
  assert.match(body, /真人评价保持空白/)
  assert.match(body, /Q02-R-920203/)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: resolve(output, 'report-desktop.png') })
  const firstTask = page.getByRole('heading', { level: 2, name: /^Q01/ })
  await firstTask.scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(output, 'report-desktop-contact.png') })
  await page.locator('.details').first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(output, 'report-desktop-details.png') })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => scrollTo(0, 0))
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: resolve(output, 'report-mobile.png') })
  await firstTask.scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(output, 'report-mobile-contact.png') })
  await page.locator('.details').first().scrollIntoViewIfNeeded()
  const detailWidths = await page.locator('.details figure img').evaluateAll(images =>
    images.map(image => image.getBoundingClientRect().width))
  assert.ok(detailWidths.every(width => width >= 110))
  await page.screenshot({ path: resolve(output, 'report-mobile-details.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)

  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: '打开高清图集' }).first().click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  const fullResolution = await popup.locator('img').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }))
  assert.deepEqual(fullResolution, { width: 1348, height: 1420 })
  await popup.close()
  assert.deepEqual(errors, [])
  assert.deepEqual(failedRequests, [])
  await writeFile(resolve(output, 'browser-verification.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), allImages: 72, contactSheets: 6, detailCrops: 72,
    loadedHtmlImages: 78, desktop: [1440, 1000], mobile: [390, 844],
    desktopOverflow: false, mobileOverflow: false, minimumMobileDetailWidth: Math.min(...detailWidths),
    fullResolutionPopup: fullResolution, pageErrors: errors, failedRequests,
    originalAndReportImageHashesVerified: 72, humanRatingsCollected: 0,
    manifestSha256: await checksum(resolve(output, 'manifest.json')),
    reportSha256: await checksum(resolve(output, 'index.html')),
    summarySha256: await checksum(resolve(output, 'summary.json')),
    testedFields: ['72 outputs', '24 requests', 'observed16 versus configured30 steps', 'assistant review attribution',
      'all images loaded', '1440px and390px overflow', 'detail crop widths', 'full-resolution contact-sheet navigation'],
  }, null, 2))
  console.log('Reference-control report passed 72-image integrity, all78 HTML images, desktop/mobile and full-resolution-link checks.')
} finally {
  await context.close()
  await browser.close()
}
