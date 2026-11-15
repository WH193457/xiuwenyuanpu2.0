import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const output = fileURLToPath(new URL('../test-results/', import.meta.url))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const errors = []
page.on('pageerror', error => errors.push(error.message))
const ready = () => page.waitForFunction(() => !document.querySelector('.co-generation .button.primary')?.disabled)
async function callButton(name, endpoint, timeout = 60_000) {
  const [response] = await Promise.all([page.waitForResponse(item => item.url().endsWith(endpoint), { timeout }),
    page.getByRole('button', { name, exact: true }).click()])
  assert.equal(response.status(), 200, await response.text())
  await ready()
  return response.json()
}
async function add(label, dimension, english) {
  const form = page.locator('.semantic-custom')
  if (!await form.locator('form').isVisible()) await form.locator('summary').click()
  await form.locator('.custom-concept-row select').selectOption(dimension)
  await page.getByLabel('概念名称', { exact: true }).fill(label)
  await page.getByLabel('英文生成描述', { exact: true }).fill(english)
  await form.getByRole('button', { name: '加入画布', exact: true }).click()
}

try {
  await page.goto(`${baseUrl}/create?patterns=DX001`)
  await page.locator('.co-service-status[data-state="online"]').waitFor()
  await ready()
  const before = await page.locator('.knowledge-recommendation h3').allTextContents()
  await page.getByLabel('创作方向', { exact: true }).selectOption('minimal')
  const after = await page.locator('.knowledge-recommendation h3').allTextContents()
  assert.notDeepEqual(before, after)
  await page.getByLabel('用中文描述创作意图', { exact: true }).fill('蝴蝶')
  await page.getByLabel('检索相关概念', { exact: true }).fill('蝴蝶')
  const first = page.locator('.knowledge-recommendation').first()
  const label = await first.locator('h3').innerText()
  assert.match(label, /蝴蝶/)
  await first.getByText('查看依据', { exact: true }).click()
  assert.ok(await first.locator('.recommendation-path li').count() > 0)
  await first.getByRole('button', { name: '本方案暂不推荐', exact: true }).click()
  assert.ok(!(await page.locator('.knowledge-recommendation h3').allTextContents()).includes(label))
  await page.getByText('推荐对照设置', { exact: true }).click()
  await page.getByRole('button', { name: /恢复暂不推荐的概念/ }).click()
  assert.equal(await first.locator('h3').innerText(), label)
  await first.getByRole('button', { name: '加入画布' }).click()
  const boxes = page.locator('.semantic-concept input[type="checkbox"]')
  for (let index = 0; index < await boxes.count(); index++) await boxes.nth(index).uncheck()
  await page.getByRole('checkbox', { name: label, exact: true }).check()
  await page.getByRole('checkbox', { name: '清晰针脚', exact: true }).check()
  await add('镜像结构', 'composition', 'bilateral symmetry')
  await add('红色翅膀', 'palette', 'red wings')
  await page.getByLabel('红色翅膀的关联主体', { exact: true }).selectOption({ label })
  await page.getByText('查看主体与条件层级', { exact: true }).click()
  assert.ok(await page.locator('.co-hierarchy ul ul').count() > 0)
  await page.getByLabel('检索相关概念', { exact: true }).fill('')
  await page.getByLabel('随机种子', { exact: true }).fill('20261108')
  const preview = await callButton('预览实际提示词', '/lora/preview')
  assert.equal(preview.compiler_version, 'dong-semantic-plan-6')
  assert.equal(preview.semantic_plan.context.goal, 'minimal')
  assert.equal(preview.semantic_plan.context.brief, '蝴蝶')
  const subject = preview.semantic_plan.concepts.find(item => item.label === label)
  assert.ok(subject.annotations.length > 0)
  assert.ok(subject.recommendation.nodes.length > 0)
  assert.match(preview.prompt, /with red wings/)
  assert.match(preview.prompt, /bilateral symmetry/)
  assert.ok(preview.prompt_token_count <= preview.token_limit)

  // Same-scope conflicts must be visible before generating; remove afterwards.
  await add('非严格对称', 'composition', 'loose asymmetry')
  const conflict = await callButton('预览实际提示词', '/lora/preview')
  assert.ok(conflict.plan_checks.some(item => item.code === 'composition-conflict'))
  assert.match(await page.getByLabel('生成条件检查', { exact: true }).innerText(), /左右对称与非严格对称/)
  await page.getByRole('button', { name: '移除非严格对称', exact: true }).click()
  await callButton('预览实际提示词', '/lora/preview')
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }))
  await page.waitForFunction(() => scrollY < 5)
  await page.screenshot({ path: `${output}/contextual-workflow-desktop.png` })

  const result = await callButton('生成三张候选', '/lora/generate', 300_000)
  assert.equal(result.mode, 'lora')
  assert.equal(result.candidates.length, 3)
  assert.equal(result.prompt, preview.prompt)
  for (const candidate of result.candidates) {
    assert.ok(candidate.image.startsWith('data:image/png;base64,'))
    assert.equal(candidate.structureMetrics.length, 1)
    assert.equal(candidate.structureMetrics[0].kind, 'mirror_lr')
    assert.ok(candidate.structureMetrics[0].score >= 0 && candidate.structureMetrics[0].score <= 1)
  }
  await page.getByLabel(`核对${label}`, { exact: true }).selectOption('partial')
  await ready()
  await page.getByLabel('核对镜像结构', { exact: true }).selectOption('missed')
  await ready()
  await page.locator('.co-candidates > button').nth(1).click()
  await ready()
  assert.equal(await page.getByLabel(`核对${label}`, { exact: true }).inputValue(), '')
  await page.locator('.co-candidates > button').nth(0).click()
  await ready()
  assert.equal(await page.getByLabel(`核对${label}`, { exact: true }).inputValue(), 'partial')
  await page.reload()
  await page.getByLabel('核对镜像结构', { exact: true }).waitFor()
  await ready()
  assert.equal(await page.getByLabel('核对镜像结构', { exact: true }).inputValue(), 'missed')
  assert.equal(await page.getByLabel('创作方向', { exact: true }).inputValue(), 'minimal')
  await page.locator('.co-condition-review').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${output}/contextual-workflow-review.png` })
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出创作记录', exact: true }).click()])
  const manifest = JSON.parse(await readFile(await download.path(), 'utf8'))
  assert.equal(manifest.reviews.length, 2)
  assert.deepEqual(manifest.conditions.semanticPlan.concepts.find(item => item.id === subject.id).annotations, subject.annotations)
  assert.equal(manifest.candidates[0].structureMetrics[0].kind, 'mirror_lr')
  await page.getByRole('button', { name: /根据核对结果调整下一轮/ }).click()
  const followup = await callButton('预览实际提示词', '/lora/preview')
  assert.equal(followup.semantic_plan.context.focusConceptIds.length, 2)
  assert.equal(followup.semantic_plan.concepts.find(item => item.id === subject.id).priority, 3)
  assert.equal(await page.getByLabel('随机种子', { exact: true }).inputValue(), '20261108')
  const history = await page.evaluate(async () => (await import('/src/creationHistory.ts')).listCreations())
  assert.deepEqual(history[0].result.semanticPlan, result.semantic_plan, 'Feedback may not overwrite historical generation conditions')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }))
  await page.waitForFunction(() => scrollY < 5)
  await page.screenshot({ path: `${output}/contextual-workflow-mobile.png` })
  const widths = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth])
  assert.ok(widths[1] <= widths[0] + 1, JSON.stringify(widths))
  assert.deepEqual(errors, [])
  const report = { type: 'real-generation-integration-check', createdAt: new Date().toISOString(),
    generationId: result.id, metadataPath: result.metadata_path, inferenceSeconds: result.inference_seconds,
    compilerVersion: result.compiler_version, semanticPlan: result.semantic_plan, prompt: result.prompt,
    candidates: result.candidates.map(({ image, ...candidate }) => candidate),
    checks: ['goal changes ranking', 'verified paths', 'reject/restore recommendation', 'accepted concept provenance',
      'hierarchical attribute binding', 'composition conflict preview', 'real LoRA generation', 'pixel diagnostics',
      'candidate-isolated human review', 'review reload/export', 'feedback prioritization', 'historical immutability', 'mobile layout'],
    reviewInputs: 'Scripted UI test selections only; not real user or expert evaluation data.',
    interpretation: 'One fixed-seed batch validates integration; it does not establish improved generation quality or cultural accuracy.' }
  await writeFile(`${output}/contextual-workflow-verification.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ generationId: result.id, inferenceSeconds: result.inference_seconds, checks: report.checks }, null, 2))
} catch (error) {
  await page.screenshot({ path: `${output}/contextual-workflow-failure.png` })
  const state = await page.evaluate(async () => {
    const { loadDraft, listCreations } = await import('/src/creationHistory.ts')
    const draft = await loadDraft()
    const records = await listCreations()
    return { draft: draft && { resultId: draft.resultId, patternId: draft.patternId, updatedAt: draft.updatedAt },
      history: records.map(item => ({ id: item.result.id, reviews: item.reviews })), text: document.body.innerText.slice(-6000) }
  }).catch(() => ({}))
  await writeFile(`${output}/contextual-workflow-failure.json`, JSON.stringify(state, null, 2))
  throw error
} finally { await context.close(); await browser.close() }
