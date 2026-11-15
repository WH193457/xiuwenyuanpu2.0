import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const requests = []
const errors = []
const unexpectedEndpoints = []
const fixtureImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII='
let generationCount = 0
let legacyResponse = false

// Every model endpoint is intercepted. This checks UI/storage contracts without
// starting model inference or treating the fixture image as a generated result.
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  await context.route('**/api/lora/**', async route => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint.endsWith('/health')) {
      await route.fulfill({ json: { status: 'ok', model_state: 'cold', runtime_available: true,
        compiler_version: 'dong-semantic-plan-6', language: { available: false, model: 'test-fixture' },
        vision: { available: false, model: 'test-fixture' } } })
      return
    }
    if (!endpoint.endsWith('/preview') && !endpoint.endsWith('/generate')) {
      unexpectedEndpoints.push(endpoint)
      await route.fulfill({ status: 503, json: { error: 'Inference is disabled in this UI regression test.' } })
      return
    }
    const payload = route.request().postDataJSON()
    requests.push({ endpoint, payload })
    const profile = payload.generation_profile ?? 'standard'
    const body = {
      prompt: `Fixture prompt for ${profile}`,
      negative_prompt: `Fixture actual negative for ${profile}`,
      semantic_plan: payload.semantic_plan,
      compiler_version: 'dong-semantic-plan-6', warnings: [], plan_checks: [],
      applied_concept_ids: payload.semantic_plan?.concepts.filter(concept => concept.enabled).map(concept => concept.id) ?? [],
      omitted_concept_ids: [], prompt_token_count: 12, token_limit: 75,
      ...(legacyResponse ? {} : { generation_profile: profile,
        generation_policy: { version: 1, fixture: true, profile, nested: { applied: ['test-rule'] } } }),
    }
    if (endpoint.endsWith('/generate')) {
      generationCount += 1
      Object.assign(body, { id: `PROFILE-FIXTURE-${generationCount}`, created_at: new Date().toISOString(),
        candidates: [0, 1, 2].map(index => ({ image: fixtureImage, seed: 123 + index })),
        seed: 123, lora_scale: payload.lora_scale, model: 'UI-test-fixture', steps: 30, guidance: 7.2 })
    }
    await route.fulfill({ json: body })
  })
  await context.route('**/api/sam3/**', route => route.fulfill({ json: {
    service: 'UI-test-fixture', status: 'error', model_state: 'error', patterns: 80, local_only: true,
    message: 'SAM3 inference is disabled in this UI regression test.',
  } }))
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => errors.push(error.message))
  return page
}

async function ready(page) {
  await page.waitForFunction(() => {
    const button = document.querySelector('.co-generation .button.primary')
    return button instanceof HTMLButtonElement && !button.disabled
  })
}

async function callButton(page, name, endpoint) {
  const [response] = await Promise.all([
    page.waitForResponse(item => item.url().endsWith(endpoint)),
    page.getByRole('button', { name, exact: true }).click(),
  ])
  assert.equal(response.status(), 200)
  await ready(page)
  return response.json()
}

async function exportRecord(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: '导出创作记录', exact: true }).click(),
  ])
  return JSON.parse(await readFile(await download.path(), 'utf8'))
}

try {
  const page = await newPage()
  for (const route of ['/', '/patterns', '/patterns/DX017', '/deconstruct', '/create', '/evaluate']) {
    await page.goto(`${baseUrl}${route}`)
    await page.locator('h1').first().waitFor()
    assert.equal(await page.getByText('Unexpected Application Error!', { exact: true }).count(), 0)
  }
  await page.goto(`${baseUrl}/create`)
  await ready(page)
  const profile = page.getByLabel('生成策略', { exact: true })
  assert.equal(await profile.inputValue(), 'subject-fidelity', 'A fresh workspace uses subject fidelity')
  assert.equal(await page.getByLabel('侗绣风格强度', { exact: true }).inputValue(), '0.35')

  const preview = await callButton(page, '预览实际提示词', '/lora/preview')
  assert.equal(requests.at(-1).payload.generation_profile, 'subject-fidelity')
  assert.equal(requests.at(-1).payload.lora_scale, 0.35)
  assert.match(await page.locator('.prompt-preview').innerText(), /对应当前条件/)
  await page.getByText('负向提示词与编排信息', { exact: true }).click()
  assert.ok((await page.locator('.prompt-preview').innerText()).includes(preview.negative_prompt))
  await profile.selectOption('standard')
  assert.match(await page.locator('.prompt-preview').innerText(), /条件已修改，请重新预览/)
  await profile.selectOption('subject-fidelity')
  assert.match(await page.locator('.prompt-preview').innerText(), /对应当前条件/)

  const generated = await callButton(page, '生成三张候选', '/lora/generate')
  await page.reload()
  await ready(page)
  assert.equal(await profile.inputValue(), 'subject-fidelity')
  assert.equal(await page.locator('.co-candidates > button').count(), 3)
  const manifest = await exportRecord(page)
  assert.equal(manifest.runtime.generationProfile, 'subject-fidelity')
  assert.deepEqual(manifest.runtime.generationPolicy, generated.generation_policy)
  assert.equal(manifest.negativePrompt, generated.negative_prompt)
  assert.equal(manifest.runtime.loraScale, 0.35)

  await profile.selectOption('standard')
  await page.getByRole('button', { name: '以本轮条件继续', exact: true }).click()
  assert.equal(await profile.inputValue(), 'subject-fidelity', 'Restoring history restores its own rendering profile')
  await profile.selectOption('standard')
  const standardPreview = await callButton(page, '预览实际提示词', '/lora/preview')
  assert.equal(requests.at(-1).payload.generation_profile, 'standard')
  await page.reload()
  await ready(page)
  assert.equal(await profile.inputValue(), 'standard', 'A preview commits the selected profile before quick reload')
  const standardAgain = await callButton(page, '预览实际提示词', '/lora/preview')
  assert.equal(standardAgain.negative_prompt, standardPreview.negative_prompt)
  await page.locator('.co-history-grid > button').first().click()
  assert.equal(await profile.inputValue(), 'subject-fidelity')

  await page.setViewportSize({ width: 390, height: 844 })
  await profile.scrollIntoViewIfNeeded()
  const widths = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth])
  assert.ok(widths[1] <= widths[0] + 1, `Mobile page overflow: ${widths}`)

  const legacyPage = await newPage()
  await legacyPage.goto(`${baseUrl}/patterns`)
  const legacyRecord = await legacyPage.evaluate(async image => {
    const { patternRepository } = await import('/src/services.ts')
    const { createInitialPlan } = await import('/src/knowledge.ts')
    const { saveDraft, saveCreation } = await import('/src/creationHistory.ts')
    const pattern = await patternRepository.get('DX017')
    const plan = createInitialPlan(pattern)
    const record = { result: { id: 'PROFILE-LEGACY', createdAt: new Date().toISOString(), pattern,
      semanticPlan: plan, composition: '左右对称', palette: '蓝', intention: '', carrier: '装裱画',
      generatedImage: image, candidates: [{ image, seed: 11 }] }, selectedIndex: 0, note: 'Legacy UI test fixture' }
    await saveCreation(record)
    await saveDraft({ version: 1, patternId: pattern.id, plan, carrier: '装裱画', seed: '11', brief: '',
      resultId: record.result.id, updatedAt: new Date().toISOString() })
    return record
  }, fixtureImage)
  await legacyPage.goto(`${baseUrl}/create`)
  await ready(legacyPage)
  assert.equal(await legacyPage.getByLabel('生成策略', { exact: true }).inputValue(), 'standard')
  assert.equal(await legacyPage.getByLabel('侗绣风格强度', { exact: true }).inputValue(), '1')
  await legacyPage.getByLabel('生成策略', { exact: true }).selectOption('subject-fidelity')
  await legacyPage.getByRole('button', { name: '以本轮条件继续', exact: true }).click()
  assert.equal(await legacyPage.getByLabel('生成策略', { exact: true }).inputValue(), 'standard')
  const legacyManifest = await exportRecord(legacyPage)
  assert.equal(legacyManifest.runtime.generationProfile, 'standard')
  assert.equal(legacyManifest.runtime.generationPolicy, undefined)
  legacyResponse = true
  const legacyAdapter = await legacyPage.evaluate(async request => {
    const { HttpLoraGenerationService } = await import('/src/services.ts')
    return new HttpLoraGenerationService().preview(request)
  }, legacyRecord.result)
  assert.equal(requests.at(-1).payload.generation_profile, 'standard', 'Old API callers retain the standard profile')
  assert.equal(legacyAdapter.generationProfile, 'standard', 'Older response metadata is interpreted as standard')
  assert.equal(legacyAdapter.generationPolicy, undefined)
  assert.deepEqual(unexpectedEndpoints, [])
  assert.deepEqual(errors, [])
  console.log('Generation profile passed with intercepted inference: six routes, new default, old draft/history/API compatibility, actual negative display, preview invalidation, three-candidate contract, quick reload, history restoration, nested policy export, mobile layout.')
} finally {
  await browser.close()
}
