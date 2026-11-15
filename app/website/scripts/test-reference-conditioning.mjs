import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const fixtureImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII='
const calls = []
const errors = []
const unexpected = []
const preparations = new Map()
let generationCount = 0
let wrongPreparation = false

// All inference endpoints are intercepted. Fixture outputs validate the UI and
// persistence contract and are never recorded as real generation evidence.
async function newPage(available = true) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  await context.route('**/api/lora/**', async route => {
    const endpoint = new URL(route.request().url()).pathname
    if (endpoint.endsWith('/health')) {
      return route.fulfill({ json: { status: 'ok', model_state: 'cold', runtime_available: true,
        compiler_version: 'dong-semantic-plan-6', language: { available: false, model: 'test' },
        vision: { available: false, model: 'test' }, reference_conditioning: { available } } })
    }
    const payload = route.request().postDataJSON()
    calls.push({ endpoint, payload })
    if (endpoint.endsWith('/prepare-reference')) {
      const referenceId = `CTRL-${(preparations.size + 1).toString(16).padStart(32, '0')}`
      const settings = Object.fromEntries(['crop', 'mask_mode', 'threshold', 'palette_mode', 'foreground_color',
        'background_color', 'layout', 'margin', 'width', 'height', 'texture_mode'].map(key => [key, payload[key]]))
      const source = { kind: payload.pattern_id ? 'pattern' : payload.element_id ? 'element' : 'upload',
        id: payload.pattern_id ?? payload.element_id, name: payload.image_name ?? payload.pattern_id ?? payload.element_id,
        ...(payload.element_id ? { pattern_id: 'DX017' } : {}), width: 512, height: 512, sha256: 'b'.repeat(64) }
      const body = { reference_id: referenceId, reference_sha256: 'a'.repeat(64), source, settings,
        init_image: fixtureImage, control_image: fixtureImage, mask_image: fixtureImage, warnings: [],
        ...(settings.texture_mode === 'stitched' ? { material: { version: 'UI-fixture-material', noise_seed: 17 } } : {}) }
      if (wrongPreparation) body.source.id = 'DX999'
      preparations.set(referenceId, body)
      return route.fulfill({ json: body })
    }
    if (!endpoint.endsWith('/preview') && !endpoint.endsWith('/generate')) {
      unexpected.push(endpoint)
      return route.fulfill({ status: 503, json: { error: 'Inference is disabled in this test.' } })
    }
    const preparation = preparations.get(payload.reference_conditioning?.reference_id)
    const body = { prompt: 'UI fixture prompt', negative_prompt: 'UI fixture negative', semantic_plan: payload.semantic_plan,
      compiler_version: 'dong-semantic-plan-6', generation_profile: payload.generation_profile, warnings: [], plan_checks: [],
      applied_concept_ids: payload.semantic_plan.concepts.filter(item => item.enabled).map(item => item.id), omitted_concept_ids: [],
      reference_conditioning: payload.reference_conditioning, reference_preparation: preparation && {
        reference_id: preparation.reference_id, reference_sha256: preparation.reference_sha256,
        source: preparation.source, settings: preparation.settings, preprocessor: 'UI-fixture-only',
      } }
    if (endpoint.endsWith('/generate')) {
      generationCount += 1
      Object.assign(body, { id: `REFERENCE-UI-FIXTURE-${generationCount}`, created_at: new Date().toISOString(),
        candidates: [0, 1, 2].map(index => ({ image: fixtureImage, seed: 91 + index, denoisingSteps: 16 })), seed: 91,
        lora_scale: payload.lora_scale, model: 'UI-fixture-only', steps: 30, guidance: 7.2,
        conditioning_model: { name: 'UI-fixture-controlnet', revision: 'UI-fixture-revision' }, postprocessing: 'none' })
    }
    return route.fulfill({ json: body })
  })
  await context.route('**/api/sam3/**', route => route.fulfill({ status: 503, json: { error: 'Disabled in test' } }))
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${baseUrl}/create?patterns=DX017`)
  await page.getByText('草稿自动保存', { exact: true }).waitFor().catch(async () => page.getByText('草稿已保存', { exact: true }).waitFor())
  await page.waitForFunction(() => !document.querySelector('.co-generation .button.primary').disabled)
  return page
}

async function waitEnabled(locator, enabled = true) {
  await locator.evaluate((button, expected) => new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      if (button.disabled === !expected) resolve()
      else if (Date.now() - started > 12_000) reject(new Error('Unexpected button availability'))
      else setTimeout(poll, 25)
    }
    poll()
  }), enabled)
}

async function prepare(page) {
  const [response] = await Promise.all([page.waitForResponse(item => item.url().endsWith('/lora/prepare-reference')),
    page.getByRole('button', { name: '准备结构参考', exact: true }).click()])
  assert.equal(response.status(), 200)
  await waitEnabled(page.getByRole('button', { name: '采用此结构与配色', exact: true }))
  return response.json()
}

async function accept(page) {
  await page.getByRole('button', { name: '采用此结构与配色', exact: true }).click()
  await waitEnabled(page.getByRole('button', { name: '生成三张候选', exact: true }))
}

async function modelAction(page, name, endpoint) {
  const [response] = await Promise.all([page.waitForResponse(item => item.url().endsWith(endpoint)), page.getByRole('button', { name, exact: true }).click()])
  assert.equal(response.status(), 200)
  await waitEnabled(page.getByRole('button', { name: '生成三张候选', exact: true }))
  return response.json()
}

async function exportRecord(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出创作记录', exact: true }).click()])
  return JSON.parse(await readFile(await download.path(), 'utf8'))
}

try {
  const page = await newPage()
  const enabled = page.getByLabel('启用结构与配色参考', { exact: true })
  const generate = page.getByRole('button', { name: '生成三张候选', exact: true })
  const preview = page.getByRole('button', { name: '预览实际提示词', exact: true })
  assert.equal(await enabled.isChecked(), false)
  await modelAction(page, '预览实际提示词', '/lora/preview')
  assert.equal(calls.at(-1).payload.reference_conditioning, undefined, 'Default requests preserve text-only behavior')
  await enabled.check()
  assert.equal(await generate.isDisabled(), true)
  assert.equal(await preview.isDisabled(), true)
  assert.equal(await page.getByLabel('重绘强度', { exact: true }).inputValue(), '0.55')
  assert.equal(await page.getByLabel('轮廓约束强度', { exact: true }).inputValue(), '0.8')
  assert.equal(await page.getByLabel('增强针线质感', { exact: true }).isChecked(), true)
  assert.equal(await page.getByLabel('参考材质', { exact: true }).inputValue(), 'stitched')
  wrongPreparation = true
  await Promise.all([page.waitForResponse(item => item.url().endsWith('/lora/prepare-reference')),
    page.getByRole('button', { name: '准备结构参考', exact: true }).click()])
  await page.getByText('返回的结构参考与当前来源或设置不一致，请重新准备。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '采用此结构与配色', exact: true }).isDisabled(), true)
  assert.equal(await generate.isDisabled(), true)
  wrongPreparation = false
  await page.getByLabel('裁切左边界百分比', { exact: true }).fill('10')
  await page.getByLabel('裁切右边界百分比', { exact: true }).fill('90')
  await page.getByLabel('主体配色', { exact: true }).selectOption('solid')
  await page.getByLabel('主体颜色', { exact: true }).fill('#234567')
  await page.getByLabel('参考布局', { exact: true }).selectOption('horizontal-band')
  const first = await prepare(page)
  assert.equal(calls.at(-1).payload.pattern_id, 'DX017')
  assert.equal(calls.at(-1).payload.element_id, undefined)
  assert.deepEqual(calls.at(-1).payload.crop, [0.1, 0, 0.9, 1])
  assert.equal(calls.at(-1).payload.texture_mode, 'stitched')
  assert.equal(await page.locator('.reference-previews img').count(), 3)
  assert.equal(await generate.isDisabled(), true, 'Preparation alone never adopts conditioning')
  await accept(page)
  const immediatelySaved = await page.evaluate(async () => (await import('/src/creationHistory.ts')).loadDraft())
  assert.equal(immediatelySaved.referenceEditor.conditioning.reference_id, first.reference_id)
  assert.equal(immediatelySaved.referenceEditor.preparation.reference_id, first.reference_id)
  await page.reload()
  await waitEnabled(generate)
  assert.equal(await enabled.isChecked(), true, 'Adoption survives immediate reload before any preview or generation')
  assert.equal(await page.getByLabel('主体颜色', { exact: true }).inputValue(), '#234567')
  assert.equal(await page.getByLabel('裁切左边界百分比', { exact: true }).inputValue(), '10')
  assert.equal(await page.getByLabel('参考材质', { exact: true }).inputValue(), 'stitched')
  await modelAction(page, '预览实际提示词', '/lora/preview')
  assert.equal(calls.at(-1).payload.reference_conditioning.reference_id, first.reference_id)
  assert.equal(calls.at(-1).payload.reference_conditioning.embroidery_detail, true)
  assert.equal(calls.at(-1).payload.image_data_url, undefined)
  assert.match(await page.locator('.prompt-preview').innerText(), /对应当前条件/)
  await page.getByLabel('参考材质', { exact: true }).selectOption('source')
  assert.equal(await generate.isDisabled(), true, 'Material changes invalidate the prepared image')
  await page.getByLabel('提取阈值', { exact: true }).fill('121')
  assert.equal(await generate.isDisabled(), true)
  assert.equal(await preview.isDisabled(), true)
  assert.match(await page.locator('.co-reference-conditioning').innerText(), /准备状态已过期/)
  assert.match(await page.locator('.prompt-preview').innerText(), /条件已修改/)
  await page.getByText('草稿已保存', { exact: true }).waitFor()
  await page.reload()
  await page.getByText('已恢复上次草稿', { exact: true }).waitFor().catch(async () => page.getByText('草稿已保存', { exact: true }).waitFor())
  assert.equal(await enabled.isChecked(), true)
  assert.equal(await generate.isDisabled(), true, 'Reload preserves a stale preparation as unadopted')
  const second = await prepare(page)
  await accept(page)
  await modelAction(page, '生成三张候选', '/lora/generate')
  const exported = await exportRecord(page)
  const savedReferenceDraft = await page.evaluate(async () => (await import('/src/creationHistory.ts')).loadDraft())
  assert.equal(exported.referenceConditioning.reference_id, second.reference_id)
  assert.deepEqual(exported.referencePreparation.settings, second.settings)
  assert.equal(exported.referencePreparation.init_image, fixtureImage)
  assert.equal(exported.referencePreparation.control_image, fixtureImage)
  assert.equal(exported.referencePreparation.mask_image, fixtureImage)
  assert.equal(exported.referencePreparation.source.sha256, 'b'.repeat(64))
  assert.equal(exported.referencePreparation.settings.texture_mode, 'source')
  assert.deepEqual(exported.candidates.map(candidate => candidate.denoisingSteps), [16, 16, 16])
  assert.equal(exported.selectedCandidate.denoisingSteps, 16)
  assert.equal(exported.runtime.steps, 30)
  assert.deepEqual(exported.runtime.conditioningModel, { name: 'UI-fixture-controlnet', revision: 'UI-fixture-revision' })
  assert.equal(exported.runtime.postprocessing, 'none')
  const mismatches = await page.evaluate(async () => {
    const { loadDraft } = await import('/src/creationHistory.ts')
    const { isReferenceAccepted } = await import('/src/referenceConditioning.ts')
    const draft = await loadDraft()
    const value = draft.referenceEditor
    const variants = [structuredClone(value), structuredClone(value), structuredClone(value), structuredClone(value)]
    variants[0].preparation.settings.threshold += 1
    variants[1].preparation.source.id = 'DX999'
    variants[2].conditioning.strength = 0.8
    variants[3].preparation.settings.texture_mode = 'stitched'
    return variants.map(state => isReferenceAccepted(state, draft.patternId, draft.element))
  })
  assert.deepEqual(mismatches, [false, false, false, false], 'Stored mismatches cannot be restored as adopted')
  await page.reload()
  await waitEnabled(generate)
  assert.equal(await enabled.isChecked(), true)
  assert.equal(await page.getByLabel('提取阈值', { exact: true }).inputValue(), '121')
  assert.equal(await page.getByLabel('参考材质', { exact: true }).inputValue(), 'source')
  await enabled.uncheck()
  await modelAction(page, '预览实际提示词', '/lora/preview')
  assert.equal(calls.at(-1).payload.reference_conditioning, undefined)
  await page.getByRole('button', { name: '以本轮条件继续', exact: true }).click()
  assert.equal(await enabled.isChecked(), true, 'History restores its explicitly adopted reference')
  await modelAction(page, '预览实际提示词', '/lora/preview')
  assert.equal(calls.at(-1).payload.reference_conditioning.reference_id, second.reference_id)
  const restoredExport = await exportRecord(page)
  assert.deepEqual(restoredExport.candidates.map(candidate => candidate.denoisingSteps), [16, 16, 16])
  assert.deepEqual(restoredExport.runtime.conditioningModel, exported.runtime.conditioningModel)
  assert.equal(restoredExport.runtime.postprocessing, 'none')
  await page.locator('.co-elements > button').first().click()
  assert.equal(await enabled.isChecked(), false, 'Changing the selected element clears the old adoption')
  await enabled.check()
  await page.getByLabel('结构参考来源', { exact: true }).selectOption('element')
  await prepare(page)
  assert.match(calls.at(-1).payload.element_id, /^DXE\d{3}$/)
  assert.equal(calls.at(-1).payload.pattern_id, undefined)
  await accept(page)
  await page.getByLabel('结构参考来源', { exact: true }).selectOption('upload')
  await page.getByLabel('上传结构参考图', { exact: true }).setInputFiles({ name: 'structure-fixture.png', mimeType: 'image/png', buffer: Buffer.from(fixtureImage.split(',')[1], 'base64') })
  await page.getByText('structure-fixture.png', { exact: false }).waitFor()
  await prepare(page)
  assert.ok(calls.at(-1).payload.image_data_url.startsWith('data:image/png;base64,'))
  assert.equal(calls.at(-1).payload.pattern_id, undefined)
  assert.equal(calls.at(-1).payload.element_id, undefined)
  await accept(page)
  await modelAction(page, '生成三张候选', '/lora/generate')
  const uploadedExport = await exportRecord(page)
  assert.equal(uploadedExport.referencePreparation.uploadedImage.image, fixtureImage)
  assert.equal(uploadedExport.referencePreparation.uploadedImage.sha256, 'b'.repeat(64))
  assert.equal(uploadedExport.referencePreparation.settings.texture_mode, 'stitched')
  assert.deepEqual(uploadedExport.referencePreparation.material, { version: 'UI-fixture-material', noise_seed: 17 })
  await page.reload()
  await waitEnabled(generate)
  assert.equal(await page.getByLabel('结构参考来源', { exact: true }).inputValue(), 'upload')
  assert.equal(await page.getByAltText('结构参考原图', { exact: true }).getAttribute('src'), fixtureImage)
  await page.locator('.co-reference-conditioning').screenshot({ path: path.join(tmpdir(), 'xiuwen-reference-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.co-reference-conditioning').scrollIntoViewIfNeeded()
  const widths = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth])
  assert.ok(widths[1] <= widths[0] + 1, `Mobile overflow: ${widths}`)
  await page.locator('.co-reference-conditioning').screenshot({ path: path.join(tmpdir(), 'xiuwen-reference-mobile.png') })
  await page.getByLabel('选择母纹', { exact: true }).selectOption('DX027')
  assert.equal(await enabled.isChecked(), false)
  await enabled.check()
  await page.getByRole('button', { name: '清除结构参考', exact: true }).click()
  assert.equal(await enabled.isChecked(), false)

  const legacy = await newPage()
  await legacy.getByText('草稿已保存', { exact: true }).waitFor()
  const legacyDraft = structuredClone(savedReferenceDraft)
  delete legacyDraft.referenceEditor.settings.texture_mode
  delete legacyDraft.referenceEditor.preparation.settings.texture_mode
  const oldKey = JSON.parse(legacyDraft.referenceEditor.preparedKey)
  delete oldKey.settings.texture_mode
  legacyDraft.referenceEditor.preparedKey = JSON.stringify(oldKey)
  const oldAcceptance = JSON.parse(legacyDraft.referenceEditor.acceptedKey)
  oldAcceptance.preparation = legacyDraft.referenceEditor.preparedKey
  legacyDraft.referenceEditor.acceptedKey = JSON.stringify(oldAcceptance)
  await legacy.evaluate(draft => new Promise((resolve, reject) => {
    const request = indexedDB.open('xiuwen-creations-v1', 2)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('drafts', 'readwrite')
      transaction.objectStore('drafts').put(draft, 'current')
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
    request.onerror = () => reject(request.error)
  }), legacyDraft)
  await legacy.reload()
  await waitEnabled(legacy.getByRole('button', { name: '生成三张候选', exact: true }))
  assert.equal(await legacy.getByLabel('参考材质', { exact: true }).inputValue(), 'source', 'Old saved references retain their original source texture')
  assert.equal(await legacy.getByLabel('启用结构与配色参考', { exact: true }).isChecked(), true)
  assert.match(await legacy.locator('.co-reference-conditioning').innerText(), /已采用结构与配色/)

  const unavailable = await newPage(false)
  await unavailable.getByLabel('启用结构与配色参考', { exact: true }).check()
  assert.equal(await unavailable.getByRole('button', { name: '准备结构参考', exact: true }).isDisabled(), true)
  assert.equal(await unavailable.getByRole('button', { name: '生成三张候选', exact: true }).isDisabled(), true)
  assert.match(await unavailable.locator('.co-reference-conditioning').innerText(), /模型暂不可用/)
  assert.deepEqual(unexpected, [], 'Reference upload never invokes Qwen or any other model endpoint')
  assert.deepEqual(errors, [])
  console.log('Reference conditioning UI passed: opt-in, explicit adoption, stale blocking/reload, canonical sources, direct upload without Qwen, actual payload, immutable images/hash/settings export, history/draft restore, disabled health, mobile layout. All model endpoints intercepted.')
  console.log(`Visual QA screenshots: ${path.join(tmpdir(), 'xiuwen-reference-desktop.png')} and ${path.join(tmpdir(), 'xiuwen-reference-mobile.png')}`)
} finally {
  await browser.close()
}
