import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const testVision = process.argv.includes('--vision')
const screenshotDirectory = fileURLToPath(new URL('../test-results', import.meta.url))
mkdirSync(screenshotDirectory, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }),
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
const checks = []

async function preview() {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/lora/preview'), { timeout: 60_000 }),
    page.getByRole('button', { name: '预览实际提示词', exact: true }).click(),
  ])
  assert.equal(response.status(), 200, await response.text())
  const result = await response.json()
  await page.waitForFunction(() => !document.querySelector('.co-generation .button.secondary')?.disabled)
  return { result, request: response.request().postDataJSON() }
}

async function generate() {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/lora/generate'), { timeout: 300_000 }),
    page.getByRole('button', { name: '生成三张候选', exact: true }).click(),
  ])
  assert.equal(response.status(), 200, await response.text())
  const result = await response.json()
  await page.getByRole('button', { name: '生成三张候选', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.co-generation .button.primary')?.disabled)
  assert.equal(result.mode, 'lora')
  assert.equal(result.candidates.length, 3)
  assert.ok(result.candidates.every(candidate => candidate.image.startsWith('data:image/png;base64,')))
  return result
}

async function refine() {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/lora/refine'), { timeout: 300_000 }),
    page.getByRole('button', { name: '用本机模型整理意图', exact: true }).click(),
  ])
  assert.equal(response.status(), 200, await response.text())
  await page.getByRole('region', { name: 'AI整理建议', exact: true }).waitFor()
  return response.json()
}

async function addConcept(label, dimension, english = '') {
  if (!await page.locator('.semantic-custom form').isVisible()) {
    await page.getByText('添加自定义概念', { exact: true }).click()
  }
  await page.locator('.custom-concept-row select').selectOption(dimension)
  await page.getByLabel('概念名称', { exact: true }).fill(label)
  await page.getByLabel('英文生成描述', { exact: true }).fill(english)
  await page.locator('.semantic-custom').getByRole('button', { name: '加入画布', exact: true }).click()
  assert.equal(await page.getByRole('checkbox', { name: label, exact: true }).isChecked(), true)
}

async function waitForDraft(matches, description) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const draft = await page.evaluate(async () => {
      const { loadDraft } = await import('/src/creationHistory.ts')
      return loadDraft()
    })
    if (draft && matches(draft)) return draft
    await page.waitForTimeout(100)
  }
  throw new Error(`Draft was not persisted: ${description}`)
}

try {
  await page.goto(`${baseUrl}/create?patterns=DX001`)
  await page.getByRole('heading', { name: '语义画布', exact: true }).waitFor()
  await page.locator('.co-service-status[data-state="online"]').waitFor()
  assert.match(await page.locator('.co-service-status').innerText(), /语言整理可用/)

  await page.getByLabel('检索相关概念', { exact: true }).fill('不存在的测试纹样xyz987')
  assert.equal(await page.locator('.knowledge-recommendation').count(), 0)
  assert.match(await page.locator('.knowledge-recommendations').innerText(), /暂无匹配/)
  await page.getByLabel('检索相关概念', { exact: true }).fill('banyan tree')
  assert.ok(await page.locator('.knowledge-recommendation').count() > 0)
  assert.match(await page.locator('.recommendation-reason').first().innerText(), /匹配|检索命中/)
  await page.getByLabel('检索相关概念', { exact: true }).fill('')
  await page.getByLabel('选择母纹', { exact: true }).selectOption('DX005')
  await page.locator('.co-source-evidence > summary').click()
  await page.locator('.co-source-evidence .concept-source-catalogue details > summary').first().click()
  assert.match(await page.locator('.co-source-evidence').getByRole('link', { name: '打开资料原文 ↗', exact: true }).first().getAttribute('href'), /^https?:\/\//)
  await page.getByLabel('选择母纹', { exact: true }).selectOption('DX001')
  checks.push('unknown and English queries', 'actual source title and link')

  const existingConcepts = page.locator('.semantic-concept input[type="checkbox"]')
  for (let index = 0; index < await existingConcepts.count(); index += 1) await existingConcepts.nth(index).uncheck()
  const subject = '飞翔的仙鹤'
  const attribute = '钴蓝色羽毛'
  await addConcept(subject, 'subject', 'flying crane')
  await addConcept(attribute, 'palette', 'cobalt blue feathers')
  await page.getByLabel(`${attribute}的关联主体`, { exact: true }).selectOption({ label: subject })
  const bound = await preview()
  const subjectConcept = bound.request.semantic_plan.concepts.find(concept => concept.label === subject)
  const attributeConcept = bound.request.semantic_plan.concepts.find(concept => concept.label === attribute)
  assert.equal(attributeConcept.parentId, subjectConcept.id)
  assert.match(bound.result.prompt, /flying crane with cobalt blue feathers/)
  assert.ok(bound.result.applied_concept_ids.includes(attributeConcept.id))
  assert.equal(bound.result.semantic_plan.concepts.find(concept => concept.id === attributeConcept.id).evidence, 'user')

  await page.getByRole('checkbox', { name: subject, exact: true }).uncheck()
  const disabledParent = await preview()
  assert.equal(disabledParent.result.prompt.includes('cobalt blue feathers'), false)
  assert.equal(disabledParent.result.applied_concept_ids.includes(attributeConcept.id), false)
  assert.match(disabledParent.result.concept_dispositions.find(item => item.id === attributeConcept.id).reason, /主体.*停用/)
  await page.getByRole('checkbox', { name: subject, exact: true }).check()
  checks.push('subject binding reaches actual compiler', 'disabled parent omits children')

  const chineseConcept = '银色五角星'
  const brief = '白色背景，保持清晰轮廓'
  await addConcept(chineseConcept, 'subject')
  await page.getByLabel('用中文描述创作意图', { exact: true }).fill(brief)
  const beforeRefinement = await preview()
  const chineseId = beforeRefinement.request.semantic_plan.concepts.find(concept => concept.label === chineseConcept).id
  assert.ok(beforeRefinement.result.omitted_concept_ids.includes(chineseId))
  const previousRefinement = await refine()
  await page.getByLabel('用中文描述创作意图', { exact: true }).fill(`${brief}，上下留白`)
  await page.getByRole('region', { name: 'AI整理建议', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await page.getByLabel(`${chineseConcept}的英文生成描述`, { exact: true }).inputValue(), '')
  await page.getByLabel('用中文描述创作意图', { exact: true }).fill(brief)
  const refinement = await refine()
  assert.match(refinement.model, /Qwen/i)
  const translated = refinement.semantic_plan.concepts.find(concept => concept.id === chineseId)
  assert.match(translated.promptText, /star|pentagram/i)
  assert.match(translated.promptText, /silver|metallic/i)
  assert.equal(refinement.semantic_plan.concepts.find(concept => concept.id === attributeConcept.id).parentId, subjectConcept.id)
  await page.getByRole('region', { name: 'AI整理建议', exact: true }).waitFor()
  assert.equal(await page.getByLabel(`${chineseConcept}的英文生成描述`, { exact: true }).inputValue(), '', 'Review must leave the current canvas unchanged until acceptance')
  await page.getByRole('button', { name: '采纳并更新画布', exact: true }).click()
  assert.equal(await page.getByLabel(`${chineseConcept}的英文生成描述`, { exact: true }).inputValue(), translated.promptText)
  const accepted = await preview()
  assert.ok(accepted.result.applied_concept_ids.includes(chineseId))
  assert.ok(accepted.result.prompt.includes(translated.promptText))
  checks.push('real local Qwen translation', 'editing the brief dismisses an outdated proposal', 'review then accept', 'translated concept reaches prompt')

  await page.getByLabel('随机种子', { exact: true }).fill('4294967295')
  const maximumSeed = await preview()
  assert.equal(maximumSeed.request.seed, 4_294_967_295)
  checks.push('uint32 maximum seed accepted through normal preview')
  await page.getByLabel('随机种子', { exact: true }).fill('0')
  const styleStrength = page.getByRole('slider', { name: '侗绣风格强度', exact: true })
  await styleStrength.press('Home')
  for (let step = 0; step < 7; step += 1) await styleStrength.press('ArrowRight')
  assert.equal(await styleStrength.inputValue(), '0.35')
  await waitForDraft(draft => draft.seed === '0' && draft.brief === brief && draft.loraScale === 0.35, 'seed, brief and style strength')
  await page.reload()
  await page.getByRole('checkbox', { name: chineseConcept, exact: true }).waitFor()
  await page.locator('.co-service-status[data-state="online"]').waitFor()
  assert.equal(await page.getByLabel('随机种子', { exact: true }).inputValue(), '0')
  assert.equal(await page.getByLabel('用中文描述创作意图', { exact: true }).inputValue(), brief)
  assert.equal(await styleStrength.inputValue(), '0.35')
  assert.equal(await page.getByLabel(`${attribute}的关联主体`, { exact: true }).inputValue(), subjectConcept.id)
  assert.equal(await page.getByLabel(`${chineseConcept}的英文生成描述`, { exact: true }).inputValue(), translated.promptText)
  checks.push('unsaved canvas survives reload with relationships and Chinese brief')

  const first = await generate()
  assert.equal(first.lora_scale, 0.35)
  const attributeCard = page.locator('.semantic-concept').filter({ has: page.getByRole('checkbox', { name: attribute, exact: true }) })
  await attributeCard.locator('details > summary').first().click()
  await page.getByLabel(`${attribute}的英文生成描述`, { exact: true }).fill('vermilion red feathers')
  const secondPreview = await preview()
  assert.notEqual(secondPreview.result.prompt, first.prompt)
  assert.equal(secondPreview.request.seed, 0)
  const second = await generate()
  assert.equal(second.lora_scale, 0.35)
  assert.equal(second.seed, first.seed)
  assert.notEqual(second.prompt, first.prompt)
  assert.notEqual(second.candidates[0].image, first.candidates[0].image)
  const comparison = page.getByRole('region', { name: '轮次对照', exact: true })
  assert.equal(await comparison.getByLabel('选择对照轮次', { exact: true }).inputValue(), first.id)
  assert.equal(await comparison.getByRole('img', { name: '对照轮次的已选纹样', exact: true }).getAttribute('src'), first.candidates[0].image)
  assert.equal(await comparison.getByRole('img', { name: '当前轮次的已选纹样', exact: true }).getAttribute('src'), second.candidates[0].image)
  assert.match(await comparison.locator('.iteration-delta').innerText(), /vermilion red feathers/)
  assert.match(await comparison.innerText(), /相同随机种子/)
  await comparison.getByText('对照两轮实际提示词', { exact: true }).click()
  assert.deepEqual(await comparison.locator('details .prompt-text').allTextContents(), [first.prompt, second.prompt])
  await comparison.screenshot({ path: join(screenshotDirectory, 'paper-workflow-comparison.png') })
  checks.push('two real generation iterations', 'same-seed image change', 'previous/current images and prompt differences')

  await page.getByRole('button', { name: `移除${subject}`, exact: true }).click()
  assert.equal(await page.getByLabel(`${attribute}的关联主体`, { exact: true }).inputValue(), '')
  assert.match(await page.locator('.semantic-editor').innerText(), /关联条件已改为全局条件/)
  checks.push('removing parent detaches child with notice')

  if (testVision) {
    const [visionResponse] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/lora/analyze-reference'), { timeout: 300_000 }),
      page.getByRole('button', { name: '分析这张参考图', exact: true }).click(),
    ])
    assert.equal(visionResponse.status(), 200, await visionResponse.text())
    const analysis = await visionResponse.json()
    assert.ok(analysis.model)
    assert.ok(analysis.semantic_plan.concepts.some(concept => concept.dimension === 'subject' && concept.promptText))
    await page.getByRole('heading', { name: '参考图分析建议', exact: true }).waitFor()
    await page.getByRole('button', { name: '采纳并更新画布', exact: true }).click()
    assert.match(await page.locator('.co-source').innerText(), /已采纳本机读图建议/)
    const analyzedPreview = await preview()
    assert.ok(analysis.reference?.id, 'The vision response must provide its persisted reference ID')
    assert.match(analysis.reference.sha256, /^[a-f0-9]{64}$/i)
    assert.equal(analyzedPreview.request.reference_id, analysis.reference.id, 'Generation must use the backend reference ID for traceability')
    assert.ok(analyzedPreview.result.applied_concept_ids.length)
    await waitForDraft(draft => draft.referenceImage?.id === analysis.reference.id && draft.referenceImage.sha256 === analysis.reference.sha256, 'backend reference ID and image hash')
    await page.reload()
    await page.getByText(/已采纳本机读图建议/).waitFor()
    checks.push('real reference-image model', 'image proposal acceptance', 'reference survives draft reload')
  }

  await page.getByLabel('用中文描述创作意图', { exact: true }).fill('切换母纹前的意图')
  await page.getByLabel('选择母纹', { exact: true }).selectOption('DX005')
  assert.equal(await page.getByLabel('用中文描述创作意图', { exact: true }).inputValue(), '')
  await page.getByLabel('用中文描述创作意图', { exact: true }).fill('恢复轮次前的意图')
  await page.locator('.co-history-grid > button').first().click()
  assert.equal(await page.getByLabel('用中文描述创作意图', { exact: true }).inputValue(), '')
  checks.push('changing mother pattern and restoring history clear the previous brief')

  const conceptToRename = page.locator('.semantic-concept').first()
  const previousLabel = await conceptToRename.locator('.concept-toggle span').innerText()
  const correctedLabel = `${previousLabel}（用户修订）`
  const labelEditor = page.getByLabel(`${previousLabel}的概念名称`, { exact: true })
  if (!await labelEditor.isVisible()) await conceptToRename.locator('details > summary').first().click()
  await labelEditor.fill(correctedLabel)
  await waitForDraft(draft => draft.plan.concepts.some(concept => concept.label === correctedLabel && concept.evidence === 'user'), 'corrected concept label')
  await page.reload()
  await page.getByRole('checkbox', { name: correctedLabel, exact: true }).waitFor()
  await page.locator('.co-service-status[data-state="online"]').waitFor()
  checks.push('edited observation label survives reload')

  await page.route('**/lora/health', route => route.abort('connectionfailed'))
  await page.getByRole('button', { name: '重试连接', exact: true }).click()
  await page.locator('.co-service-status[data-state="offline"]').waitFor()
  assert.match(await page.locator('.co-service-status').innerText(), /本机服务未连接/)
  assert.equal(await page.getByRole('button', { name: '生成三张候选', exact: true }).isDisabled(), true)
  await page.unroute('**/lora/health')
  await page.getByRole('button', { name: '重试连接', exact: true }).click()
  await page.locator('.co-service-status[data-state="online"]').waitFor()
  assert.equal(await page.getByRole('button', { name: '生成三张候选', exact: true }).isEnabled(), true)
  checks.push('offline status and retry recovery')

  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
  await page.screenshot({ path: join(screenshotDirectory, 'paper-workflow-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  assert.ok(dimensions.scrollWidth <= dimensions.width + 1, JSON.stringify(dimensions))
  await page.screenshot({ path: join(screenshotDirectory, 'paper-workflow-mobile.png') })
  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({
    generationIds: [first.id, second.id],
    languageModel: refinement.model,
    refinementSeconds: refinement.elapsed_seconds,
    previousRefinementSeconds: previousRefinement.elapsed_seconds,
    inferenceSeconds: [first.inference_seconds, second.inference_seconds],
    checks,
    screenshots: screenshotDirectory,
    vision: testVision ? 'tested' : 'Run with --vision when the local vision model is ready',
  }, null, 2))
} finally {
  await context.close()
  await browser.close()
}
