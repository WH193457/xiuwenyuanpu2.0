import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const output = fileURLToPath(new URL('../test-results/', import.meta.url))
await mkdir(output, { recursive: true })
const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const errors = []
page.on('pageerror', error => errors.push(error.message))
const field = page.getByLabel('补充描述（中文 / English）', { exact: true })
const ready = () => page.waitForFunction(() => {
  const button = document.querySelector('.co-generation .button.primary')
  return button instanceof HTMLButtonElement && !button.disabled
})
async function request(name, endpoint) {
  const [response] = await Promise.all([page.waitForResponse(item => item.url().endsWith(endpoint), { timeout: 300_000 }),
    page.getByRole('button', { name, exact: true }).click()])
  assert.equal(response.status(), 200, await response.text())
  await ready()
  return response.json()
}
const preview = () => request('预览实际提示词', '/lora/preview')
try {
  for (const route of ['/', '/patterns', '/patterns/DX017', '/deconstruct', '/create', '/evaluate']) {
    await page.goto(`${baseUrl}${route}`)
    await page.locator('h1').first().waitFor()
    assert.equal(await page.getByText('Unexpected Application Error!', { exact: true }).count(), 0)
  }
  await page.goto(`${baseUrl}/create?patterns=DX001`)
  await page.locator('.co-service-status[data-state="online"]').waitFor()
  await ready()
  assert.equal(await page.getByLabel('生成策略', { exact: true }).inputValue(), 'subject-fidelity')
  const boxes = page.locator('.semantic-concept input[type="checkbox"]')
  for (let index = 0; index < await boxes.count(); index++) await boxes.nth(index).uncheck()
  await page.getByRole('checkbox', { name: '清晰针脚', exact: true }).check()
  await field.fill('ivory background')
  const english = await preview()
  assert.equal(english.compiler_version, 'dong-semantic-plan-6')
  assert.equal(english.generation_profile, 'subject-fidelity')
  assert.match(english.prompt, /ivory background/)
  assert.equal(english.semantic_plan.extraPromptTranslation, undefined)

  const chineseText = '米白色背景，红色蝴蝶'
  await field.fill(chineseText)
  const chinese = await preview()
  assert.equal(chinese.semantic_plan.extraPrompt, chineseText)
  assert.match(chinese.semantic_plan.extraPromptTranslation.text, /ivory/i)
  assert.match(chinese.semantic_plan.extraPromptTranslation.text, /red/i)
  assert.match(chinese.semantic_plan.extraPromptTranslation.text, /butterfl/i)
  assert.ok(chinese.applied_concept_ids.includes('extraPrompt'))
  assert.equal(await field.inputValue(), chineseText, 'Original Chinese text must stay editable')
  assert.match(await page.locator('.prompt-preview').innerText(), /对应当前条件/)

  const mixedText = '蓝色背景，保留 red butterfly'
  await field.fill(mixedText)
  const mixed = await preview()
  assert.equal(mixed.semantic_plan.extraPromptTranslation.sourceText, mixedText)
  assert.notEqual(mixed.semantic_plan.extraPromptTranslation.text, chinese.semantic_plan.extraPromptTranslation.text)
  assert.match(mixed.prompt, /blue/i)
  assert.match(mixed.prompt, /red butterfly/i)
  assert.ok(mixed.applied_concept_ids.includes('extraPrompt'))
  assert.deepEqual(mixed.semantic_plan.concepts, chinese.semantic_plan.concepts, 'Supplement translation must not rewrite the canvas')
  await page.getByText('查看补充描述原文与译文', { exact: true }).click()
  await page.locator('.prompt-preview').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${output}/bilingual-supplement-preview.png` })
  await page.getByLabel('随机种子', { exact: true }).fill('20261109')
  const generated = await request('生成三张候选', '/lora/generate')
  assert.equal(generated.candidates.length, 3)
  assert.equal(generated.prompt, mixed.prompt)
  assert.equal(generated.negative_prompt, mixed.negative_prompt)
  assert.equal(generated.generation_profile, mixed.generation_profile)
  assert.deepEqual(generated.generation_policy, mixed.generation_policy)
  for (const candidate of generated.candidates) {
    assert.ok(candidate.image.startsWith('data:image/png;base64,'))
    const image = await readFile(candidate.path)
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(image.readUInt32BE(16), 512)
    assert.equal(image.readUInt32BE(20), 512)
  }
  assert.deepEqual(generated.semantic_plan.extraPromptTranslation, mixed.semantic_plan.extraPromptTranslation)
  assert.equal(generated.semantic_plan.extraPrompt, mixedText)
  assert.equal(await field.inputValue(), mixedText)
  await page.reload()
  await ready()
  assert.equal(await page.getByLabel('生成策略', { exact: true }).inputValue(), 'subject-fidelity')
  await page.locator('.co-candidates > button').first().waitFor()
  assert.equal(await field.inputValue(), mixedText)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出创作记录', exact: true }).click()])
  const manifest = JSON.parse(await readFile(await download.path(), 'utf8'))
  assert.deepEqual(manifest.conditions.semanticPlan.extraPromptTranslation, mixed.semantic_plan.extraPromptTranslation)
  assert.equal(manifest.conditions.semanticPlan.extraPrompt, mixedText)
  assert.equal(manifest.runtime.generationProfile, generated.generation_profile)
  assert.deepEqual(manifest.runtime.generationPolicy, generated.generation_policy)
  assert.equal(manifest.negativePrompt, generated.negative_prompt)
  await field.fill('blue background')
  const edited = await preview()
  assert.equal(edited.semantic_plan.extraPromptTranslation, undefined)
  assert.match(edited.prompt, /blue background/)
  assert.doesNotMatch(edited.prompt, /red butterfly/i)
  await page.setViewportSize({ width: 390, height: 844 })
  await field.scrollIntoViewIfNeeded()
  const widths = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth])
  assert.ok(widths[1] <= widths[0] + 1)
  assert.deepEqual(errors, [])
  const report = { createdAt: new Date().toISOString(), generationId: generated.id, inferenceSeconds: generated.inference_seconds,
    chinese: chinese.semantic_plan.extraPromptTranslation, mixed: mixed.semantic_plan.extraPromptTranslation,
    actualPrompt: generated.prompt, metadataPath: generated.metadata_path,
    actualNegativePrompt: generated.negative_prompt, generationProfile: generated.generation_profile,
    generationPolicy: generated.generation_policy,
    checks: ['6 routes', 'English pass-through', 'local Chinese translation', 'mixed input translation', 'original text preserved',
      'canvas unchanged', 'real generation uses preview translation', 'three actual 512x512 PNG files',
      'profile, negative prompt and policy match preview', 'reload/export', 'edit invalidates translation', 'mobile layout'] }
  await writeFile(`${output}/bilingual-supplement-verification.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { await context.close(); await browser.close() }
