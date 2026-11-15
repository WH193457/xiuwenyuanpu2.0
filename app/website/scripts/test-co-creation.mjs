import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }),
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))

async function preview() {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/lora/preview'), { timeout: 60_000 }),
    page.getByRole('button', { name: '预览实际提示词', exact: true }).click(),
  ])
  assert.equal(response.status(), 200, await response.text())
  await page.getByRole('button', { name: '预览实际提示词', exact: true }).waitFor()
  return { request: response.request().postDataJSON(), result: await response.json() }
}

async function generate() {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/lora/generate'), { timeout: 300_000 }),
    page.getByRole('button', { name: '生成三张候选', exact: true }).click(),
  ])
  assert.equal(response.status(), 200, await response.text())
  const body = await response.json()
  await page.getByRole('button', { name: '生成三张候选', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.co-generation .button.primary')?.disabled)
  return body
}

try {
  for (const route of ['/', '/patterns', '/patterns/DX017', '/deconstruct', '/create', '/evaluate']) {
    await page.goto(`${baseUrl}${route}`)
    await page.locator('h1').first().waitFor()
    assert.ok((await page.locator('h1').first().textContent()).trim(), `Missing heading on ${route}`)
    assert.equal(await page.getByText('Unexpected Application Error!', { exact: true }).count(), 0)
  }
  assert.deepEqual(pageErrors, [])

  await page.goto(`${baseUrl}/create?patterns=DX001`)
  await page.getByRole('heading', { name: '语义画布', exact: true }).waitFor()
  assert.equal(await page.locator('.co-source select').inputValue(), 'DX001')
  const referenceElement = page.locator('.co-elements > button').first()
  await referenceElement.click()
  assert.equal(await referenceElement.getAttribute('aria-pressed'), 'true')

  const firstRecommendation = page.locator('.knowledge-recommendation').first()
  const recommendationName = await firstRecommendation.locator('h3').innerText()
  await firstRecommendation.getByRole('button', { name: '加入画布' }).click()
  assert.equal(await page.getByRole('checkbox', { name: recommendationName, exact: true }).isChecked(), true)

  await page.getByText('添加自定义概念', { exact: true }).click()
  await page.getByLabel('概念名称', { exact: true }).fill('测试同心菱形')
  await page.getByLabel('英文生成描述', { exact: true }).fill('concentric diamond')
  await page.locator('.semantic-custom').getByRole('button', { name: '加入画布', exact: true }).click()
  await page.getByLabel('测试同心菱形的优先级', { exact: true }).selectOption('3')
  const addedPreview = await preview()
  assert.ok(addedPreview.result.prompt.includes('concentric diamond'))
  const customId = addedPreview.request.semantic_plan.concepts.find(concept => concept.label === '测试同心菱形').id
  assert.ok(addedPreview.result.applied_concept_ids.includes(customId))

  await page.getByRole('checkbox', { name: '测试同心菱形', exact: true }).uncheck()
  const uncheckedPreview = await preview()
  assert.equal(uncheckedPreview.result.prompt.includes('concentric diamond'), false)
  assert.equal(uncheckedPreview.result.applied_concept_ids.includes(customId), false)
  assert.notEqual(addedPreview.result.prompt, uncheckedPreview.result.prompt)
  await page.getByRole('button', { name: '移除测试同心菱形', exact: true }).click()
  await page.getByLabel('随机种子', { exact: true }).fill('0')
  await page.getByLabel('应用载体', { exact: true }).selectOption('陶瓷花器')
  const finalPreview = await preview()
  assert.equal(finalPreview.request.semantic_plan.concepts.some(concept => concept.id === customId), false)
  assert.equal(finalPreview.request.seed, 0)

  const firstGeneration = await generate()
  assert.equal(firstGeneration.mode, 'lora')
  assert.equal(firstGeneration.seed, 0)
  assert.equal(firstGeneration.candidates.length, 3)
  assert.equal(firstGeneration.prompt, finalPreview.result.prompt)
  assert.equal(await page.locator('.co-candidates > button').count(), 3)
  assert.equal(await page.locator('.co-history-grid > button').count(), 1)
  assert.ok(firstGeneration.candidates.every(candidate => candidate.image.startsWith('data:image/png;base64,')))

  await page.locator('.co-candidates > button').nth(1).click()
  await page.waitForFunction(() => !document.querySelector('.co-candidates > button')?.disabled)
  await page.locator('.co-results textarea').fill('保留边框，下一轮调整配色。')
  await page.getByRole('button', { name: '保存批注', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.co-candidates > button')?.disabled)
  await page.reload()
  await page.locator('.co-history-grid > button').first().waitFor()
  await page.locator('.co-history-grid > button').first().click()
  assert.equal(await page.getByLabel('随机种子', { exact: true }).inputValue(), '1')
  assert.equal(await page.locator('.co-results textarea').inputValue(), '保留边框，下一轮调整配色。')
  assert.equal(await page.locator('.co-candidates > button').nth(1).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('.co-elements > button').first().getAttribute('aria-pressed'), 'true')
  const restoredPreview = await preview()
  assert.equal(restoredPreview.request.seed, 1)
  assert.equal(restoredPreview.result.prompt, firstGeneration.prompt)

  await page.getByLabel('补充描述（中文 / English）', { exact: true }).fill('ivory background')
  const changedPreview = await preview()
  assert.notEqual(changedPreview.result.prompt, firstGeneration.prompt)
  await page.locator('.co-history-grid > button').first().click()
  assert.equal(await page.getByLabel('补充描述（中文 / English）', { exact: true }).inputValue(), '')

  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出创作记录', exact: true }).click()
  const download = await downloadEvent
  const manifest = JSON.parse(readFileSync(await download.path(), 'utf8'))
  assert.equal(manifest.id, firstGeneration.id)
  assert.equal(manifest.selectedCandidate.seed, 1)
  assert.equal(manifest.runtime.seed, 0)
  assert.equal(manifest.runtime.compilerVersion, firstGeneration.compiler_version)
  assert.deepEqual(manifest.conditions.appliedConceptIds, firstGeneration.applied_concept_ids)
  assert.equal(JSON.stringify(manifest).includes('base64'), false)

  // The second real inference checks reproducibility while a storage failure is injected.
  await page.getByLabel('随机种子', { exact: true }).fill('0')
  await page.evaluate(() => {
    globalThis.savedIdbPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function () { throw new DOMException('Regression test quota failure', 'QuotaExceededError') }
  })
  const repeatedGeneration = await generate()
  assert.equal(repeatedGeneration.prompt, firstGeneration.prompt)
  assert.deepEqual(repeatedGeneration.candidates.map(item => item.image), firstGeneration.candidates.map(item => item.image))
  assert.equal(await page.getByText(/浏览器历史保存失败/).count(), 1)
  assert.match(await page.locator('.co-live').innerText(), /请导出本轮记录/)
  await page.evaluate(() => { IDBObjectStore.prototype.put = globalThis.savedIdbPut })

  // A saved temporary cutout must survive after its SAM3 session has disappeared.
  const temporaryReference = await page.evaluate(async () => {
    const history = await import('/src/creationHistory.ts')
    const [record] = await history.listCreations()
    const fixture = structuredClone(record)
    fixture.result.id = 'TEST-SAM3-REFERENCE'
    fixture.result.createdAt = new Date(Date.now() + 1000).toISOString()
    fixture.result.element = {
      id: 'SAM3-TEMP', pattern_id: fixture.result.pattern.id,
      image: fixture.result.candidates[1].image, name: '历史拆解参考', type: 'SAM3 临时纹样元',
      position: '用户框选区域', use: '创作视觉参考', crop_box: [0, 0, 20, 20],
    }
    await history.saveCreation(fixture)
    sessionStorage.removeItem('xiuwen-sam3-selection-v1')
    return fixture.result.element.image
  })
  await page.reload()
  await page.locator('.co-history-grid > button').first().waitFor()
  await page.locator('.co-history-grid > button').first().click()
  const restoredReference = page.locator('.co-elements > button').filter({ hasText: '历史拆解参考' })
  await restoredReference.waitFor()
  assert.equal(await restoredReference.getAttribute('aria-pressed'), 'true')
  assert.equal(await restoredReference.locator('img').getAttribute('src'), temporaryReference)

  // Failed session storage must keep the selected candidate visible instead of opening stale work.
  const selectedTexture = await page.getByAltText('当前选中的创作结果', { exact: true }).getAttribute('src')
  await page.evaluate(() => {
    globalThis.savedStorageSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage) throw new DOMException('Regression test quota failure', 'QuotaExceededError')
      return globalThis.savedStorageSetItem.call(this, key, value)
    }
  })
  for (const link of ['进入文创 3D 贴图', '进入博物馆展陈 →']) {
    await page.getByRole('link', { name: link, exact: true }).click()
    assert.equal(new URL(page.url()).pathname, '/create')
    await page.getByText(/当前纹样未能传递到文创页面/).waitFor()
  }
  await page.evaluate(() => { Storage.prototype.setItem = globalThis.savedStorageSetItem })
  await page.getByRole('link', { name: '进入文创 3D 贴图', exact: true }).click()
  await page.getByRole('heading', { name: '文创贴图台', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.workshop-canvas')?.dataset.renderState === 'ready')
  assert.equal(await page.getByAltText('当前贴图纹样', { exact: true }).getAttribute('src'), selectedTexture)
  assert.equal(new URL(page.url()).searchParams.get('source'), 'session')
  assert.equal(new URL(page.url()).searchParams.get('carrier'), 'vase')
  await page.getByRole('link', { name: '进入 3D 博物馆', exact: true }).click()
  await page.getByRole('heading', { name: '3D文创博物馆', exact: true }).waitFor()
  assert.equal(await page.getByAltText('当前文创贴图', { exact: true }).getAttribute('src'), selectedTexture)
  await page.getByRole('link', { name: '继续调整文创贴图', exact: true }).click()
  await page.getByRole('heading', { name: '文创贴图台', exact: true }).waitFor()
  assert.equal(await page.getByAltText('当前贴图纹样', { exact: true }).getAttribute('src'), selectedTexture)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(200)
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  assert.ok(dimensions.scrollWidth <= dimensions.width + 1, JSON.stringify(dimensions))
  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({
    routes: 6,
    generationIds: [firstGeneration.id, repeatedGeneration.id],
    inferenceSeconds: [firstGeneration.inference_seconds, repeatedGeneration.inference_seconds],
    reproducibleImages: 3,
    checks: ['concept add/disable/remove', 'actual preview', 'seed zero', 'history reload', 'notes', 'reference restore', 'manifest', 'same-seed inference', 'storage failure', 'blocked stale handoff', 'selected candidate in workshop and museum', 'mobile overflow'],
  }, null, 2))
} finally {
  await context.close()
  await browser.close()
}
