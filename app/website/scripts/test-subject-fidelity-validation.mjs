import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(root, 'outputs/subject-fidelity-validation-2026-11-09')
const summary = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'))
const state = JSON.parse(await readFile(resolve(output, 'state.json'), 'utf8'))
assert.equal(summary.completedNewImages, 24)
assert.equal(summary.totalScoredImages, 72)
assert.equal(summary.humanRatingsCollected, 0)
assert.ok(summary.baselineScoreMaximumDrift < 0.00001)
assert.equal(Object.keys(state.failures).length, 0)
for (const job of Object.values(state.jobs).filter(item => item.methodId === 'F')) {
  assert.equal(job.generation.generation_profile, 'subject-fidelity')
  assert.equal(job.generation.generation_policy.version, 'subject-fidelity-1')
  assert.equal(job.generation.lora_scale, 0.35)
  assert.equal(job.generation.omitted_concept_ids.length, 0)
}
for (const sample of summary.samples) assert.ok(existsSync(resolve(output, sample.image)))

const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(pathToFileURL(resolve(output, 'index.html')).href)
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0))
  assert.equal(await page.locator('figure img').count(), 8)
  assert.match(await page.locator('body').innerText(), /已知任务集/)
  assert.match(await page.locator('body').innerText(), /24\/24/)
  await page.screenshot({ path: resolve(output, 'report-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: resolve(output, 'report-mobile.png') })
  assert.deepEqual(errors, [])
  await writeFile(resolve(output, 'browser-verification.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), newImages: 24, allImages: 72, contactSheets: 8,
    desktop: [1440, 1000], mobile: [390, 844], pageErrors: errors,
    testedFields: ['profile', 'policy version', 'LoRA strength', 'no omitted conditions', 'scorer reproducibility', 'image files'],
  }, null, 2))
  console.log('Subject-fidelity report passed 24-new/72-total integrity and desktop/mobile rendering checks.')
} finally {
  await context.close()
  await browser.close()
}
