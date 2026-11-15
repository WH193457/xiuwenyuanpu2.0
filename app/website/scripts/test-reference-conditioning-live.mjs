import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// GPU generation is deliberately opt-in so normal UI regression runs cannot
// interrupt a separately scheduled local-model experiment.
const runGeneration = process.argv.includes('--run-live-generation')
if (!runGeneration && !process.argv.includes('--prepare-only')) {
  console.log('Choose --prepare-only for CPU reference preparation or --run-live-generation during an assigned GPU window.')
  process.exit(0)
}

const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const seed = Number(process.env.XIUWEN_LIVE_SEED ?? 910101)
const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = path.join(projectRoot, 'outputs', `reference-conditioning-ui-live-${timestamp}`)
await mkdir(output, { recursive: true })
const report = { mode: runGeneration ? 'actual-ui-generation' : 'actual-ui-cpu-preparation',
  startedAt: new Date().toISOString(), baseUrl, patternId: 'DX027', seed,
  modelEndpointsIntercepted: false, routes: [], requests: [], errors: [], files: [], imageSha256: {}, generatedPngVerification: [] }
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(30_000)
page.on('pageerror', error => report.errors.push(error.message))
page.on('request', request => {
  if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/lora/')) {
    report.requests.push({ url: request.url(), payload: request.postDataJSON() })
  }
})

async function waitEnabled(name) {
  await page.getByRole('button', { name, exact: true }).evaluate(button => new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      if (!button.disabled) resolve()
      else if (Date.now() - started > 60_000) reject(new Error('Button remained unavailable'))
      else setTimeout(poll, 50)
    }
    poll()
  }))
}

async function action(name, endpoint, timeout = 60_000) {
  const started = Date.now()
  const [response] = await Promise.all([
    page.waitForResponse(item => item.url().endsWith(endpoint), { timeout }),
    page.getByRole('button', { name, exact: true }).click(),
  ])
  const body = await response.json()
  assert.equal(response.status(), 200, JSON.stringify(body))
  return { body, seconds: (Date.now() - started) / 1000 }
}

async function saveImage(name, dataUrl) {
  assert.match(dataUrl, /^data:image\/png;base64,/)
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64')
  await writeFile(path.join(output, name), bytes)
  report.imageSha256[name] = createHash('sha256').update(bytes).digest('hex')
  report.files.push(name)
}

try {
  for (const route of ['/', '/patterns', '/patterns/DX027', '/deconstruct?pattern=DX027', '/evaluate', '/create?patterns=DX027']) {
    await page.goto(`${baseUrl}${route}`)
    await page.locator('h1').first().waitFor()
    assert.equal(await page.getByText('Unexpected Application Error!', { exact: true }).count(), 0)
    report.routes.push({ route, heading: await page.locator('h1').first().innerText() })
  }
  await waitEnabled('生成三张候选')
  const enabled = page.getByLabel('启用结构与配色参考', { exact: true })
  assert.equal(await enabled.isChecked(), false)
  await page.getByLabel('生成策略', { exact: true }).selectOption('subject-fidelity')
  await page.getByLabel('侗绣风格强度', { exact: true }).fill('0.35')
  await page.getByLabel('随机种子', { exact: true }).fill(String(seed))
  // Edit the actual canvas through its controls, keeping the reference colors
  // and semantic instructions consistent with the formal Q01 task.
  for (const checkbox of await page.locator('.semantic-concept .concept-toggle input').all()) await checkbox.uncheck()
  const butterfly = page.locator('.semantic-concept').filter({ has: page.getByRole('checkbox', { name: '蝴蝶', exact: true }) })
  await butterfly.getByRole('checkbox', { name: '蝴蝶', exact: true }).check()
  await butterfly.getByLabel('蝴蝶的关联主体', { exact: true }).selectOption('')
  await butterfly.getByLabel('蝴蝶的优先级', { exact: true }).selectOption('3')
  await butterfly.locator('details.concept-details').first().locator('summary').first().click()
  await butterfly.getByLabel('蝴蝶的英文生成描述', { exact: true }).fill('a single red butterfly')
  await page.locator('.semantic-custom > summary').click()
  const custom = page.locator('.semantic-custom form')
  for (const [dimension, label, english] of [
    ['palette', '蓝色织物背景', 'plain blue fabric background'],
    ['composition', '居中对称与留白', 'centered composition, bilateral symmetry, empty margins'],
    ['technique', '针线与织物细节', 'close-up embroidery photograph, raised parallel silk stitches, individual thread fibers, woven cotton fabric'],
  ]) {
    await custom.locator('.custom-concept-row select').selectOption(dimension)
    await custom.getByLabel('概念名称', { exact: true }).fill(label)
    await custom.getByLabel('英文生成描述', { exact: true }).fill(english)
    await custom.getByRole('button', { name: '加入画布', exact: true }).click()
  }
  await page.getByLabel('居中对称与留白的优先级', { exact: true }).selectOption('3')
  await enabled.check()
  await page.getByLabel('主体提取方式', { exact: true }).selectOption('dark')
  await page.getByLabel('提取阈值', { exact: true }).fill('190')
  await page.getByLabel('主体配色', { exact: true }).selectOption('solid')
  await page.getByLabel('主体颜色', { exact: true }).fill('#D12D3E')
  await page.getByLabel('背景颜色', { exact: true }).fill('#25549A')
  await page.getByLabel('参考材质', { exact: true }).selectOption('stitched')
  assert.equal(await page.getByRole('button', { name: '生成三张候选', exact: true }).isDisabled(), true)
  const prepared = await action('准备结构参考', '/lora/prepare-reference')
  report.preparationSeconds = prepared.seconds
  report.preparation = prepared.body
  assert.equal(prepared.body.source.id, 'DX027')
  assert.equal(prepared.body.settings.texture_mode, 'stitched')
  assert.equal(prepared.body.settings.width, 512)
  assert.equal(prepared.body.settings.height, 512)
  assert.equal(prepared.body.settings.mask_mode, 'dark')
  assert.equal(prepared.body.settings.threshold, 190)
  assert.equal(prepared.body.settings.palette_mode, 'solid')
  assert.equal(prepared.body.settings.foreground_color, '#D12D3E')
  assert.equal(prepared.body.settings.background_color, '#25549A')
  assert.equal(prepared.body.settings.layout, 'centered')
  assert.equal(prepared.body.settings.margin, 0.12)
  assert.deepEqual(prepared.body.settings.crop, [0, 0, 1, 1])
  assert.ok(prepared.body.material?.version)
  await saveImage('prepared-init.png', prepared.body.init_image)
  await saveImage('prepared-control.png', prepared.body.control_image)
  await saveImage('prepared-mask.png', prepared.body.mask_image)
  await waitEnabled('采用此结构与配色')
  assert.equal(await page.getByRole('button', { name: '生成三张候选', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '采用此结构与配色', exact: true }).click()
  await waitEnabled('生成三张候选')
  await page.reload()
  await waitEnabled('生成三张候选')
  assert.equal(await enabled.isChecked(), true)
  assert.equal(await page.getByLabel('主体颜色', { exact: true }).inputValue(), '#d12d3e')
  const preview = await action('预览实际提示词', '/lora/preview')
  report.previewSeconds = preview.seconds
  report.preview = preview.body
  assert.equal(preview.body.reference_conditioning.reference_id, prepared.body.reference_id)
  assert.equal(preview.body.reference_conditioning.reference_sha256, prepared.body.reference_sha256)
  assert.equal(preview.body.reference_preparation.settings.texture_mode, 'stitched')
  for (const kind of ['init', 'control', 'mask']) {
    assert.equal(report.imageSha256[`prepared-${kind}.png`], preview.body.reference_preparation.files[kind].sha256)
  }
  assert.deepEqual(preview.body.semantic_plan.concepts.filter(item => item.enabled).map(item => item.promptText), [
    'a single red butterfly', 'plain blue fabric background', 'centered composition, bilateral symmetry, empty margins',
    'close-up embroidery photograph, raised parallel silk stitches, individual thread fibers, woven cotton fabric',
  ])
  await waitEnabled('生成三张候选')
  assert.match(await page.locator('.prompt-preview').innerText(), /对应当前条件/)
  await page.locator('.co-reference-conditioning').screenshot({ path: path.join(output, 'reference-desktop.png') })
  report.files.push('reference-desktop.png')

  if (runGeneration) {
    const generated = await action('生成三张候选', '/lora/generate', 360_000)
    report.generationSeconds = generated.seconds
    report.generation = generated.body
    assert.equal(generated.body.candidates.length, 3)
    assert.equal(generated.body.reference_conditioning.reference_id, prepared.body.reference_id)
    assert.equal(generated.body.reference_conditioning.reference_sha256, prepared.body.reference_sha256)
    assert.deepEqual(generated.body.reference_conditioning, preview.body.reference_conditioning)
    assert.deepEqual(generated.body.reference_preparation, preview.body.reference_preparation)
    assert.equal(generated.body.prompt, preview.body.prompt)
    assert.equal(generated.body.negative_prompt, preview.body.negative_prompt)
    assert.equal(generated.body.lora_scale, 0.35)
    assert.equal(generated.body.width, 512)
    assert.equal(generated.body.height, 512)
    assert.deepEqual(generated.body.conditioning_model, { name: 'lllyasviel/control_v11p_sd15_canny', revision: '115a470d547982438f70198e353a921996e2e819' })
    assert.equal(generated.body.postprocessing, 'none')
    for (const [index, candidate] of generated.body.candidates.entries()) {
      assert.equal(candidate.seed, seed + index)
      assert.equal(candidate.denoisingSteps, 16)
      assert.ok(path.resolve(candidate.path).startsWith(path.join(projectRoot, 'outputs', 'lora') + path.sep))
      const savedBytes = await readFile(candidate.path)
      assert.deepEqual(savedBytes, Buffer.from(candidate.image.split(',')[1], 'base64'), 'Served PNG matches the actual saved generation')
      await saveImage(`candidate-${index + 1}.png`, candidate.image)
      const savedSha256 = createHash('sha256').update(savedBytes).digest('hex')
      assert.equal(savedSha256, report.imageSha256[`candidate-${index + 1}.png`])
      report.generatedPngVerification.push({ seed: candidate.seed, path: candidate.path, sha256: savedSha256, responseMatchesSavedPng: true })
    }
    await waitEnabled('生成三张候选')
    await page.getByRole('region', { name: '本轮创作结果' }).screenshot({ path: path.join(output, 'results-desktop.png') })
    report.files.push('results-desktop.png')
    await page.reload()
    await waitEnabled('生成三张候选')
    assert.equal(await enabled.isChecked(), true)
    assert.equal(await page.getByLabel('参考材质', { exact: true }).inputValue(), 'stitched')
    assert.equal(await page.locator('.co-candidates > button').count(), 3)
    for (const [index, candidate] of generated.body.candidates.entries()) {
      assert.equal(await page.locator('.co-candidates > button img').nth(index).getAttribute('src'), candidate.image)
    }
    await enabled.uncheck()
    await page.locator('.co-history-grid > button').first().click()
    assert.equal(await enabled.isChecked(), true)
    const [download] = await Promise.all([
      page.waitForEvent('download'), page.getByRole('button', { name: '导出创作记录', exact: true }).click(),
    ])
    const downloadPath = await download.path()
    const manifest = JSON.parse(await readFile(downloadPath, 'utf8'))
    assert.equal(manifest.id, generated.body.id)
    assert.equal(manifest.referenceConditioning.reference_id, prepared.body.reference_id)
    assert.equal(manifest.referencePreparation.reference_sha256, prepared.body.reference_sha256)
    assert.equal(manifest.referencePreparation.init_image, prepared.body.init_image)
    assert.equal(manifest.referencePreparation.control_image, prepared.body.control_image)
    assert.equal(manifest.referencePreparation.mask_image, prepared.body.mask_image)
    assert.equal(manifest.referencePreparation.settings.texture_mode, 'stitched')
    assert.deepEqual(manifest.referencePreparation.material, prepared.body.material)
    assert.deepEqual(manifest.candidates.map(candidate => candidate.denoisingSteps), [16, 16, 16])
    assert.equal(manifest.selectedCandidate.denoisingSteps, 16)
    assert.deepEqual(manifest.runtime.conditioningModel, generated.body.conditioning_model)
    assert.equal(manifest.runtime.postprocessing, 'none')
    assert.equal(manifest.runtime.steps, 30)
    await copyFile(downloadPath, path.join(output, 'exported-creation.json'))
    report.files.push('exported-creation.json')
    const [imageDownload] = await Promise.all([
      page.waitForEvent('download'), page.getByRole('link', { name: '下载当前纹样', exact: true }).click(),
    ])
    const imageDownloadPath = await imageDownload.path()
    assert.deepEqual(await readFile(imageDownloadPath), Buffer.from(generated.body.candidates[0].image.split(',')[1], 'base64'))
    await copyFile(imageDownloadPath, path.join(output, 'selected-download.png'))
    report.imageSha256['selected-download.png'] = createHash('sha256').update(await readFile(imageDownloadPath)).digest('hex')
    report.files.push('selected-download.png')
    const draft = await page.evaluate(async () => (await import('/src/creationHistory.ts')).loadDraft())
    assert.deepEqual(draft.referenceEditor.conditioning, generated.body.reference_conditioning)
    assert.equal(draft.referenceEditor.preparation.reference_sha256, prepared.body.reference_sha256)
    report.restoredAndExported = true
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.co-reference-conditioning').scrollIntoViewIfNeeded()
  const widths = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth])
  assert.ok(widths[1] <= widths[0] + 1, `Mobile overflow ${widths}`)
  report.mobileWidths = widths
  await page.locator('.co-reference-conditioning').screenshot({ path: path.join(output, 'reference-mobile.png') })
  report.files.push('reference-mobile.png')
  assert.deepEqual(report.errors, [])
  assert.equal(report.requests.filter(item => item.url.endsWith('/lora/generate')).length, runGeneration ? 1 : 0)
  assert.equal(report.requests.filter(item => item.url.endsWith('/lora/analyze-reference') || item.url.endsWith('/lora/compose') || item.url.endsWith('/lora/refine')).length, 0)
  report.status = 'passed'
  console.log(`${report.mode} passed. Actual service responses and UI evidence saved to ${output}`)
} catch (error) {
  report.status = 'failed'
  report.failure = String(error?.stack ?? error)
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined)
  throw error
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
