import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(root, process.argv[2] ?? 'outputs/reproduction-2026-11-09-v2')
const summary = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'))
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(pathToFileURL(resolve(output, 'index.html')).href)
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0))
  assert.equal(await page.locator('figure img').count(), 8)
  assert.match(await page.locator('body').innerText(), new RegExp(`${summary.scoredImages} / ${summary.plannedImages}`))
  assert.match(await page.locator('body').innerText(), /非随机缺失/)
  assert.match(await page.locator('.failures').innerText(), /T07-D/)
  await page.screenshot({ path: resolve(output, 'report-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Report must fit a phone viewport')
  await page.screenshot({ path: resolve(output, 'report-mobile.png') })
  await page.goto(pathToFileURL(resolve(output, 'blind-review/index.html')).href)
  await page.waitForFunction(() => document.querySelector('#image').complete && document.querySelector('#image').naturalWidth > 0)
  assert.match(await page.locator('#progress').innerText(), new RegExp(`1 / ${summary.scoredImages}`))
  assert.equal(await page.locator('#participant').inputValue(), '')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Blind-review form must fit a phone viewport')
  await page.screenshot({ path: resolve(output, 'blind-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: resolve(output, 'blind-desktop.png') })
  assert.deepEqual(errors, [])
  await writeFile(resolve(output, 'report-browser-verification.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), reportedImages: summary.scoredImages,
    contactSheets: 8, desktop: [1440, 1000], mobile: [390, 844], pageErrors: errors,
    initialHumanRatings: 'All form controls empty, no human observations created by this test',
  }, null, 2))
  console.log('Experiment report and blind form passed desktop/mobile rendering and local image checks.')
} finally {
  await context.close()
  await browser.close()
}
