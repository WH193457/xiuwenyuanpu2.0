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
const ready = () => page.waitForFunction(() => {
  const button = document.querySelector('.co-generation .button.primary')
  return button instanceof HTMLButtonElement && !button.disabled
})
const supplement = () => page.getByLabel('补充描述（中文 / English）', { exact: true })

async function callButton(name, endpoint) {
  const [response] = await Promise.all([
    page.waitForResponse(item => item.url().endsWith(endpoint), { timeout: 300_000 }),
    page.getByRole('button', { name, exact: true }).click(),
  ])
  const body = await response.json()
  assert.equal(response.status(), 200, JSON.stringify(body))
  await ready()
  return body
}

const concept = (id, dimension, label, promptText, priority, parentId) => ({
  id, dimension, label, promptText, priority, enabled: true, parentId,
  patternIds: [], sourceIds: [], evidence: 'user',
})
// This synthetic editable plan is an integration fixture. Image generation and
// whole-canvas Qwen inference below use the real local services.
const legacyPlan = {
  version: 1,
  concepts: [
    concept('user:test-butterfly', 'subject', '蝴蝶主体', 'single butterfly motif', 3),
    concept('user:test-blue', 'palette', '蓝色翅膀', 'blue wings', 2, 'user:test-butterfly'),
    concept('user:test-symmetry', 'composition', '左右镜像结构', 'bilateral symmetry', 2),
    concept('user:test-stitches', 'technique', '清晰刺绣针脚', 'crisp embroidery stitches', 1),
  ],
  extraPrompt: 'ivory background',
}

try {
  for (const route of ['/', '/patterns', '/patterns/DX017', '/deconstruct', '/create', '/evaluate']) {
    await page.goto(`${baseUrl}${route}`)
    await page.locator('h1').first().waitFor()
    assert.equal(await page.getByText('Unexpected Application Error!', { exact: true }).count(), 0)
  }
  await page.evaluate(async plan => {
    const { saveDraft } = await import('/src/creationHistory.ts')
    await saveDraft({ version: 1, patternId: 'DX017', plan, carrier: '装裱画', seed: '20261120', brief: '',
      loraScale: 0.35, updatedAt: new Date().toISOString() })
  }, legacyPlan)
  await page.goto(`${baseUrl}/create`)
  await page.locator('.co-service-status[data-state="online"]').waitFor()
  await ready()
  assert.equal(await page.locator('.semantic-concept').count(), 4)
  const profile = page.getByLabel('生成策略', { exact: true })
  assert.equal(await profile.inputValue(), 'standard', 'An old draft retains the original generation profile')
  await profile.selectOption('subject-fidelity')
  assert.equal(await page.getByLabel('蓝色翅膀的关联主体', { exact: true }).inputValue(), 'user:test-butterfly')
  const baseline = await callButton('预览实际提示词', '/lora/preview')
  assert.equal(baseline.compiler_version, 'dong-semantic-plan-6')
  assert.equal(baseline.generation_profile, 'subject-fidelity')
  assert.equal(baseline.semantic_plan.promptRealization, undefined)
  assert.match(baseline.prompt, /single butterfly motif with blue wings/)
  await profile.selectOption('standard')
  assert.match(await page.locator('.prompt-preview').innerText(), /条件已修改，请重新预览/)
  await profile.selectOption('subject-fidelity')

  const proposal = await callButton('用本机模型编排整张画布', '/lora/compose')
  await writeFile(`${output}/canvas-composition-proposal.json`, JSON.stringify(proposal, null, 2))
  assert.match(proposal.semantic_plan.promptRealization.sourceFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(proposal.semantic_plan.promptRealization.groups.length, 4)
  assert.equal(proposal.composition_audit.method, 'full-canvas-conditioned-groups-qwen-v2')
  assert.ok(Object.values(proposal.composition_audit.group_attempts).every(attempts => attempts >= 0 && attempts <= 2))
  assert.equal(proposal.composition_audit.completions.filter(completion => completion.route === 'preserved').length, 2)
  assert.equal(proposal.composition_audit.input.canvas.length, 4)
  assert.deepEqual(proposal.semantic_plan.concepts, baseline.semantic_plan.concepts)
  const subjectGroup = proposal.semantic_plan.promptRealization.groups.find(group => group.rootId === 'user:test-butterfly')
  assert.deepEqual(subjectGroup.conceptIds, ['user:test-butterfly', 'user:test-blue'])
  assert.match(subjectGroup.text, /butterfl/i)
  assert.match(subjectGroup.text, /blue/i)
  await page.getByLabel('AI整理建议', { exact: true }).waitFor()
  await page.getByRole('button', { name: '采纳并更新画布', exact: true }).click()
  const preview = await callButton('预览实际提示词', '/lora/preview')
  assert.deepEqual(preview.semantic_plan.promptRealization, proposal.semantic_plan.promptRealization)
  assert.equal(preview.omitted_concept_ids.length, 0)
  assert.equal(preview.generation_profile, 'subject-fidelity')
  assert.ok(preview.prompt_token_count <= preview.token_limit)
  assert.match(await page.locator('.prompt-preview').innerText(), /对应当前条件/)
  await page.locator('.co-generation').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${output}/canvas-composition-desktop.png` })

  await page.reload()
  await ready()
  assert.equal(await profile.inputValue(), 'subject-fidelity')
  assert.equal(await page.getByRole('button', { name: '恢复逐项编排', exact: true }).count(), 1)
  const restoredPreview = await callButton('预览实际提示词', '/lora/preview')
  assert.equal(restoredPreview.prompt, preview.prompt)
  assert.deepEqual(restoredPreview.semantic_plan.promptRealization, proposal.semantic_plan.promptRealization)

  const generated = await callButton('生成三张候选', '/lora/generate')
  assert.equal(generated.candidates.length, 3)
  assert.equal(generated.prompt, preview.prompt)
  assert.equal(generated.negative_prompt, preview.negative_prompt)
  assert.equal(generated.generation_profile, preview.generation_profile)
  assert.deepEqual(generated.generation_policy, preview.generation_policy)
  assert.deepEqual(generated.semantic_plan.promptRealization, proposal.semantic_plan.promptRealization)
  assert.equal(generated.request_context.assistance.kind, 'composition')
  assert.deepEqual(generated.candidates.map(candidate => candidate.seed), [20261120, 20261121, 20261122])
  for (const candidate of generated.candidates) {
    assert.ok(candidate.image.startsWith('data:image/png;base64,'))
    assert.ok(existsSync(candidate.path))
  }
  await page.reload()
  await ready()
  assert.equal(await profile.inputValue(), 'subject-fidelity')
  await page.locator('.co-candidates > button').first().waitFor()
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: '导出创作记录', exact: true }).click(),
  ])
  const manifest = JSON.parse(await readFile(await download.path(), 'utf8'))
  assert.deepEqual(manifest.conditions.semanticPlan.promptRealization, proposal.semantic_plan.promptRealization)
  assert.equal(manifest.assistance.kind, 'composition')
  assert.equal(manifest.prompt, generated.prompt)
  assert.equal(manifest.negativePrompt, generated.negative_prompt)
  assert.equal(manifest.runtime.generationProfile, generated.generation_profile)
  assert.deepEqual(manifest.runtime.generationPolicy, generated.generation_policy)
  await page.locator('.co-results').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${output}/canvas-composition-results.png` })

  await supplement().fill('white background')
  assert.equal(await page.getByRole('button', { name: '恢复逐项编排', exact: true }).count(), 0)
  const edited = await callButton('预览实际提示词', '/lora/preview')
  assert.equal(edited.semantic_plan.promptRealization, undefined)
  assert.match(edited.prompt, /white background/)
  assert.doesNotMatch(edited.prompt, /ivory/)
  const historical = await page.evaluate(async () => (await import('/src/creationHistory.ts')).listCreations())
  assert.deepEqual(historical[0].result.semanticPlan.promptRealization, proposal.semantic_plan.promptRealization)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '用本机模型编排整张画布', exact: true }).scrollIntoViewIfNeeded()
  const widths = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth])
  assert.ok(widths[1] <= widths[0] + 1, JSON.stringify(widths))
  await page.screenshot({ path: `${output}/canvas-composition-mobile.png` })
  assert.deepEqual(errors, [])
  const report = {
    type: 'real-local-composition-integration-check', createdAt: new Date().toISOString(),
    generationId: generated.id, metadataPath: generated.metadata_path,
    compilerVersion: generated.compiler_version, inferenceSeconds: generated.inference_seconds,
    compositionSeconds: proposal.elapsed_seconds, compositionAttempts: proposal.composition_audit.attempts,
    generationProfile: generated.generation_profile, generationPolicy: generated.generation_policy,
    promptBefore: baseline.prompt, promptAfter: generated.prompt,
    semanticPlan: generated.semantic_plan,
    candidates: generated.candidates.map(({ image, ...candidate }) => candidate),
    checks: ['six baseline routes', 'version-1 legacy draft without new fields', 'full-canvas real local Qwen composition',
      'exact group and provenance preservation', 'explicit UI acceptance', 'token-budget preview', 'approved prose draft reload',
      'three real LoRA candidates', 'preview-generation equality', 'history reload and manifest export',
      'generation profile legacy default, switch invalidation and saved metadata',
      'edit invalidates realization', 'historical immutability', 'mobile layout'],
    interpretation: 'A scripted integration check with real inference. No user-study responses or image-quality improvement claims are inferred.',
  }
  await writeFile(`${output}/canvas-composition-verification.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ generationId: report.generationId, compositionSeconds: report.compositionSeconds,
    inferenceSeconds: report.inferenceSeconds, promptBefore: report.promptBefore, promptAfter: report.promptAfter, checks: report.checks }, null, 2))
} catch (error) {
  await page.screenshot({ path: `${output}/canvas-composition-failure.png` })
  await writeFile(`${output}/canvas-composition-failure.json`, JSON.stringify({ error: String(error),
    pageErrors: errors, text: await page.locator('body').innerText().catch(() => '') }, null, 2))
  throw error
} finally {
  await context.close()
  await browser.close()
}
