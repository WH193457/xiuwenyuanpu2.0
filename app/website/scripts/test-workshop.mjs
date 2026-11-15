import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import sharp from 'sharp'
import { chromium } from 'playwright'

const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
await page.addInitScript(() => {
  window.__THREE_DEVTOOLS__ = new EventTarget()
  window.__THREE_DEVTOOLS__.addEventListener('observe', event => {
    const renderer = event.detail
    if (!renderer.isWebGLRenderer) return
    const render = renderer.render
    renderer.render = function (scene, camera) {
      render.call(this, scene, camera)
      window.renderedWorkshopScene = scene
      window.renderedWorkshopCamera = camera
      window.workshopRenderer = this
      const appearance = scene.children.find(object => object.userData.carrier)?.userData.appearance
      window.lastRenderedAppearance = appearance ? { ...appearance } : undefined
    }
  })
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style')
    style.textContent = '.ip-guide { visibility: hidden !important; }'
    document.head.append(style)
  })
})
const failures = []
page.on('pageerror', error => failures.push(error.message))
page.setDefaultTimeout(20_000)
mkdirSync('test-results', { recursive: true })
const ready = () => page.locator('.workshop-canvas[data-render-state="ready"]').waitFor()
const image = await sharp({ create: { width: 160, height: 80, channels: 4, background: '#d4382d' } }).png().toBuffer()
const textureUrl = 'data:image/png;base64,' + image.toString('base64')
const stored = { patternId: 'DX060', patternName: '保存的生成结果', textureUrl, carrier: 'tee', source: 'create', createdAt: new Date().toISOString() }
const labels = { mug: '马克杯', tote: '帆布袋', tee: '文化衫', cushion: '织纹抱枕', scarf: '丝巾', notebook: '精装笔记本', vase: '陶瓷花器',
  tumbler: '随行保温杯', coaster: '陶瓷杯垫', bookmark: '织纹书签', fan: '折扇', phonecase: '手机壳', pouch: '拉链收纳包', poster: '装裱画' }
const checks = []
const waitForAppearance = patch => page.waitForFunction(expected => {
  const appearance = window.lastRenderedAppearance
  return appearance && Object.entries(expected).every(([key, value]) => appearance[key] === value)
}, patch)
const renderedFrame = async () => Buffer.from(await page.evaluate(() => {
  const renderer = window.workshopRenderer
  // Read the rendered pixels directly so sticky-panel scrolling cannot shift the screenshot crop.
  renderer.render(window.renderedWorkshopScene, window.renderedWorkshopCamera)
  return renderer.domElement.toDataURL('image/png').split(',')[1]
}), 'base64')
async function chooseSource(name) {
  await page.getByRole('radio', { name, exact: true }).click()
  await page.waitForFunction(label => Array.from(document.querySelectorAll('.workshop-source-options input')).some(input => input.checked && input.parentElement.textContent.trim() === label), name)
  await ready()
}
try {
  // Freeze the 100ms product-update debounce to exercise immediate view/rotation actions.
  // Playwright's clock applies to an entire context, including subsequent page navigations.
  const controlsContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const controlsPage = await controlsContext.newPage()
  controlsPage.on('pageerror', error => failures.push(error.message))
  await controlsPage.addInitScript(() => {
    window.__THREE_DEVTOOLS__ = new EventTarget()
    window.__THREE_DEVTOOLS__.addEventListener('observe', event => {
      const renderer = event.detail
      if (!renderer.isWebGLRenderer) return
      const render = renderer.render
      renderer.render = function (scene, camera) {
        render.call(this, scene, camera)
        window.renderedWorkshopScene = scene
        window.renderedWorkshopCamera = camera
      }
    })
  })
  await controlsPage.clock.install({ time: new Date('2026-11-08T00:00:00Z') })
  await controlsPage.goto(baseUrl + '/workshop?pattern=DX027&carrier=mug&source=library')
  await controlsPage.locator('.workshop-canvas[data-render-state="ready"]').waitFor()
  await controlsPage.waitForTimeout(400)
  await controlsPage.clock.pauseAt(new Date('2026-11-08T00:02:00Z'))
  const cameraPosition = () => controlsPage.evaluate(() => window.renderedWorkshopCamera.position.toArray())
  for (const name of ['正面', '背面', '重置视角']) {
    await controlsPage.getByRole('button', { name: /马克杯/ }).click({ force: true })
    await controlsPage.clock.runFor(180)
    await controlsPage.getByRole('button', { name: /文化衫/ }).click({ force: true })
    await controlsPage.waitForURL(url => url.searchParams.get('carrier') === 'tee')
    await controlsPage.getByRole('button', { name, exact: true }).click({ force: true })
    await controlsPage.clock.runFor(180)
    const immediate = await cameraPosition()
    await controlsPage.getByRole('button', { name, exact: true }).click({ force: true })
    await controlsPage.clock.runFor(32)
    const settled = await cameraPosition()
    assert.ok(immediate.every((value, index) => Math.abs(value - settled[index]) < 1e-8), `${name} must apply to the newly selected carrier before the pending update`)
  }
  await controlsPage.getByRole('button', { name: /马克杯/ }).click({ force: true })
  await controlsPage.clock.runFor(180)
  await controlsPage.getByRole('button', { name: /文化衫/ }).click({ force: true })
  await controlsPage.waitForURL(url => url.searchParams.get('carrier') === 'tee')
  await controlsPage.getByRole('button', { name: '自动旋转', exact: true }).click({ force: true })
  await controlsPage.clock.runFor(180)
  assert.equal(await controlsPage.getByRole('button', { name: '暂停旋转', exact: true }).getAttribute('aria-pressed'), 'true')
  const rotation = () => controlsPage.evaluate(() => window.renderedWorkshopScene.children.find(object => object.userData.carrier === 'tee').rotation.y)
  const firstRotation = await rotation()
  await controlsPage.clock.runFor(180)
  assert.ok(await rotation() > firstRotation, 'Rotation must continue on the newly selected carrier after the pending update')
  await controlsPage.getByRole('button', { name: '暂停旋转', exact: true }).click({ force: true })
  await controlsPage.getByRole('button', { name: /马克杯/ }).click({ force: true })
  await controlsPage.clock.runFor(180)
  await controlsPage.getByRole('tab', { name: '物品配色', exact: true }).click({ force: true })
  await controlsPage.evaluate(() => {
    document.querySelector('[aria-label="燕麦底色"]').click()
    const detail = document.querySelector('[aria-label="部件颜色"]')
    detail.value = '#79553d'
    detail.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await controlsPage.waitForURL(url => url.searchParams.get('productColor') === '#b9a17c' && url.searchParams.get('productDetailColor') === '#79553d')
  await controlsPage.evaluate(() => {
    // Both events run before React can commit a new render or router state.
    document.querySelector('[aria-label="雾蓝底色"]').click()
    const detail = document.querySelector('[aria-label="部件颜色"]')
    detail.value = 'ivory'
    detail.dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector('.workshop-actions button').click()
  })
  await controlsPage.waitForURL(url => url.searchParams.get('productColor') === '#95acb4' && url.searchParams.get('productDetailColor') === 'ivory')
  await controlsPage.clock.runFor(180)
  const rapidColors = await controlsPage.evaluate(() => {
    const product = window.renderedWorkshopScene.children.find(object => object.userData.carrier === 'mug')
    const image = product.getObjectByName('product-print').material.map.image
    return {
      appearance: product.userData.appearance,
      bodyPixel: [...image.getContext('2d').getImageData(0, 0, 1, 1).data],
      detailColor: product.getObjectByName('mug-handle').material.color.getHexString(),
      saved: JSON.parse(sessionStorage.getItem('xiuwen-workshop-session-v1')).appearance,
    }
  })
  assert.equal(rapidColors.appearance.color, '#95acb4')
  assert.equal(rapidColors.appearance.detailColor, 'ivory')
  assert.deepEqual(rapidColors.bodyPixel, [149, 172, 180, 255])
  assert.equal(rapidColors.detailColor, 'eee7d8')
  assert.equal(rapidColors.saved.color, '#95acb4')
  assert.equal(rapidColors.saved.detailColor, 'ivory')
  await controlsPage.clock.resume()
  await controlsContext.close()
  checks.push('Immediate front/back/reset and rotation survive a carrier change during the 100ms debounce')
  checks.push('Same-event-loop body/detail changes and immediate save retain both latest colors in the URL, storage, and actual rendered materials')

  await page.goto(baseUrl + '/workshop')
  await ready()
  await page.evaluate(value => sessionStorage.setItem('xiuwen-workshop-session-v1', JSON.stringify(value)), stored)
  await page.goto(baseUrl + '/workshop?pattern=DX027&carrier=poster')
  await ready()
  assert.equal(await page.getByLabel('文创母纹').inputValue(), 'DX027')
  assert.equal(await page.getByRole('button', { name: /装裱画/ }).getAttribute('aria-pressed'), 'true')
  assert.match(await page.locator('.workshop-reference figcaption').innerText(), /母纹原图/)
  checks.push('Explicit URL overrides a different saved session')

  assert.equal(await page.locator('.carrier-grid button').count(), 14)
  await page.getByLabel('文创类别', { exact: true }).selectOption('随身')
  assert.deepEqual(await page.locator('.carrier-grid button b').allTextContents(), ['折扇', '手机壳', '拉链收纳包'])
  await page.getByLabel('文创类别', { exact: true }).selectOption('all')
  checks.push('All fourteen styles are available and category filtering exposes the three carry accessories')

  const canvasIdentity = await page.locator('.workshop-canvas canvas').evaluate(element => { element.dataset.testIdentity = 'same-renderer'; return element.dataset.testIdentity })
  let sourceRequests = 0
  page.on('request', request => { if (request.resourceType() === 'image') sourceRequests++ })
  for (const carrier of Object.keys(labels)) {
    await page.getByRole('button', { name: new RegExp(labels[carrier]), exact: false }).click()
    await ready()
    await page.waitForTimeout(250)
    assert.equal(new URL(page.url()).searchParams.get('carrier'), carrier)
    assert.equal(await page.locator('.workshop-canvas canvas').count(), 1)
    assert.equal(await page.locator('.workshop-canvas canvas').getAttribute('data-test-identity'), canvasIdentity)
    await page.locator('.workshop-stage').screenshot({ path: 'test-results/workshop-' + carrier + '.png' })
  }
  assert.equal(sourceRequests, 0, 'Carrier changes must reuse the loaded source texture')
  checks.push('All fourteen carriers render with one persistent canvas and synchronized URL, without reloading the source')
  const canvas = page.locator('.workshop-canvas canvas')
  const stillA = await canvas.screenshot()
  await page.waitForTimeout(350)
  assert.ok((await canvas.screenshot()).equals(stillA), 'A static model must keep the same pixels')
  await page.getByRole('button', { name: '自动旋转', exact: true }).click()
  await page.waitForTimeout(500)
  assert.ok(!(await canvas.screenshot()).equals(stillA), 'Automatic rotation must change the model pixels')
  await page.getByRole('button', { name: '暂停旋转', exact: true }).click()
  await page.waitForTimeout(100)
  const pausedA = await canvas.screenshot()
  await page.waitForTimeout(350)
  assert.ok((await canvas.screenshot()).equals(pausedA), 'Pausing rotation must hold the exact frame')
  checks.push('Default is static, rotation changes pixels, pause holds the exact frame')
  await page.getByRole('button', { name: '正面', exact: true }).click()
  await page.waitForTimeout(120)
  const front = await canvas.screenshot()
  await page.getByRole('button', { name: '自动旋转', exact: true }).click()
  const canvasBounds = await canvas.boundingBox()
  await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(canvasBounds.x + canvasBounds.width / 2 + 80, canvasBounds.y + canvasBounds.height / 2 + 30, { steps: 6 })
  await page.mouse.up()
  assert.equal(await page.getByRole('button', { name: '自动旋转', exact: true }).getAttribute('aria-pressed'), 'false')
  await page.getByRole('button', { name: '正面', exact: true }).click()
  await page.waitForTimeout(120)
  const resetFront = await canvas.screenshot()
  await sharp(front).toFile('test-results/workshop-front-before-drag.png')
  await sharp(resetFront).toFile('test-results/workshop-front-after-reset.png')
  const beforePixels = await sharp(front).raw().toBuffer()
  const afterPixels = await sharp(resetFront).raw().toBuffer()
  let resetPixelDifference = 0
  for (let index = 0; index < beforePixels.length; index++) {
    const difference = Math.abs(beforePixels[index] - afterPixels[index])
    assert.ok(difference <= 1, 'Front reset must restore the original camera with only one-level GPU rounding tolerance')
    resetPixelDifference += difference
  }
  assert.ok(resetPixelDifference / beforePixels.length < 0.0001, 'Reset must clear manual orbit inertia')
  await page.getByRole('button', { name: '背面', exact: true }).click()
  await page.waitForTimeout(120)
  assert.ok(!(await canvas.screenshot()).equals(front), 'Back view must differ from front view')
  await page.getByRole('button', { name: '重置视角', exact: true }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: '下载预览图', exact: true }).click(),
  ])
  assert.match(download.suggestedFilename(), /DX027-poster.*\.png$/)
  const metadata = await sharp(await download.path()).metadata()
  assert.ok(metadata.width > 300 && metadata.height > 200)
  checks.push('Front/back/reset controls and actual PNG export work')

  await page.getByRole('tab', { name: '调整贴图', exact: true }).click()
  const designBefore = await canvas.screenshot()
  for (const [label, key, end, value] of [
    ['纹样缩放', 'printScale', 'Home', '0.35'],
    ['水平位置', 'printX', 'End', '0.5'],
    ['垂直位置', 'printY', 'Home', '-0.5'],
    ['纹样旋转', 'printRotation', 'End', '180'],
  ]) {
    await page.getByLabel(label, { exact: true }).press(end)
    await page.waitForURL(url => url.searchParams.get(key) === value)
  }
  await page.getByLabel('连续纹样', { exact: true }).click()
  await page.waitForURL(url => url.searchParams.get('printRepeat') === 'true')
  await page.getByLabel('去除浅色底色', { exact: true }).click()
  await page.waitForURL(url => url.searchParams.get('printRemoveBackground') === 'true')
  await page.getByRole('tab', { name: '物品配色', exact: true }).click()
  await page.getByRole('button', { name: '靛青底色', exact: true }).click()
  await page.waitForURL(url => url.searchParams.get('productColor') === 'indigo')
  await page.getByLabel('部件颜色', { exact: true }).selectOption('terracotta')
  await page.waitForURL(url => url.searchParams.get('productDetailColor') === 'terracotta')
  await page.waitForTimeout(300)
  assert.ok(!(await canvas.screenshot()).equals(designBefore), 'Appearance controls must change actual rendered pixels')
  assert.equal(sourceRequests, 0, 'Appearance controls must reuse the loaded source texture')
  assert.equal(await canvas.getAttribute('data-test-identity'), canvasIdentity)
  await page.getByRole('button', { name: '保存贴图方案', exact: true }).click()
  const savedAppearance = await page.evaluate(() => JSON.parse(sessionStorage.getItem('xiuwen-workshop-session-v1')).appearance)
  assert.deepEqual(savedAppearance, { scale: 0.35, offsetX: 0.5, offsetY: -0.5, rotation: 180, repeat: true, removeBackground: true, color: 'indigo', detailColor: 'terracotta' })
  await page.reload()
  await ready()
  await page.getByRole('tab', { name: '调整贴图', exact: true }).click()
  assert.equal(await page.getByLabel('纹样缩放', { exact: true }).inputValue(), '0.35')
  await page.getByRole('tab', { name: '物品配色', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '靛青底色', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.getByLabel('部件颜色', { exact: true }).inputValue(), 'terracotta')
  await page.getByRole('link', { name: /进入 3D 博物馆/ }).click()
  await page.waitForURL(/\/museum\?/)
  for (const [name, value] of [['printScale', '0.35'], ['printX', '0.5'], ['printY', '-0.5'], ['printRotation', '180'], ['printRepeat', 'true'], ['printRemoveBackground', 'true'], ['productColor', 'indigo'], ['productDetailColor', 'terracotta']]) {
    assert.equal(new URL(page.url()).searchParams.get(name), value)
  }
  await page.getByRole('link', { name: '继续调整文创贴图', exact: true }).click()
  await ready()
  await page.getByRole('tab', { name: '调整贴图', exact: true }).click()
  assert.equal(await page.getByLabel('纹样缩放', { exact: true }).inputValue(), '0.35')
  await page.getByRole('button', { name: '重置贴图参数', exact: true }).click()
  await page.waitForURL(url => url.searchParams.get('printScale') === '1')
  await page.getByRole('tab', { name: '物品配色', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '靛青底色', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.getByLabel('部件颜色', { exact: true }).inputValue(), 'terracotta')
  await page.getByRole('button', { name: '重置物品配色', exact: true }).click()
  await page.waitForURL(url => url.searchParams.get('productColor') === 'ivory')
  assert.equal(await page.getByRole('button', { name: '米白底色', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.getByLabel('部件颜色', { exact: true }).inputValue(), 'auto')
  checks.push('All eight appearance fields update real pixels, retain a single renderer, save, reload, transfer to museum and restore; print reset preserves colors')

  // Color controls edit the product body and detail independently, including arbitrary native color input values.
  assert.equal(await page.locator('.workshop-color-presets button').count(), 12)
  let previousColorFrame
  for (const colorButton of await page.locator('.workshop-color-presets button').all()) {
    const label = await colorButton.getAttribute('aria-label')
    await colorButton.click()
    await page.waitForFunction(name => document.querySelector(`[aria-label="${name}"]`)?.getAttribute('aria-pressed') === 'true', label)
    await waitForAppearance({ color: new URL(page.url()).searchParams.get('productColor') })
    const colorFrame = await renderedFrame()
    if (previousColorFrame) assert.ok(!colorFrame.equals(previousColorFrame), `${label} must change the product pixels`)
    previousColorFrame = colorFrame
  }
  await page.getByLabel('自定义物品主色', { exact: true }).fill('#386a78')
  await page.waitForURL(url => url.searchParams.get('productColor') === '#386a78')
  await page.getByLabel('自定义部件颜色', { exact: true }).fill('#eab35e')
  await page.waitForURL(url => url.searchParams.get('productDetailColor') === '#eab35e')
  await waitForAppearance({ color: '#386a78', detailColor: '#eab35e' })
  const independentFrame = await renderedFrame()
  await page.getByLabel('部件颜色', { exact: true }).selectOption('indigo')
  await page.waitForURL(url => url.searchParams.get('productDetailColor') === 'indigo')
  await waitForAppearance({ color: '#386a78', detailColor: 'indigo' })
  assert.ok(!(await renderedFrame()).equals(independentFrame), 'Detail color must change the rendered product independently')
  assert.equal(await page.getByLabel('自定义物品主色', { exact: true }).inputValue(), '#386a78')
  await page.getByLabel('自定义部件颜色', { exact: true }).fill('#eab35e')
  await page.waitForURL(url => url.searchParams.get('productDetailColor') === '#eab35e')
  for (const id of ['DX008', 'DX027']) {
    await page.getByLabel('文创母纹').selectOption(id)
    await ready()
    assert.equal(await page.getByLabel('自定义物品主色', { exact: true }).inputValue(), '#386a78')
    assert.equal(await page.getByLabel('自定义部件颜色', { exact: true }).inputValue(), '#eab35e')
  }
  await page.getByRole('button', { name: '保存贴图方案', exact: true }).click()
  await page.reload()
  await ready()
  await page.getByRole('tab', { name: '物品配色', exact: true }).click()
  assert.equal(await page.getByLabel('自定义物品主色', { exact: true }).inputValue(), '#386a78')
  assert.equal(await page.getByLabel('自定义部件颜色', { exact: true }).inputValue(), '#eab35e')
  await page.getByRole('link', { name: /进入 3D 博物馆/ }).click()
  await page.waitForURL(/\/museum\?/)
  assert.equal(new URL(page.url()).searchParams.get('productColor'), '#386a78')
  assert.equal(new URL(page.url()).searchParams.get('productDetailColor'), '#eab35e')
  await page.getByRole('link', { name: '继续调整文创贴图', exact: true }).click()
  await ready()
  await page.getByRole('tab', { name: '物品配色', exact: true }).click()
  assert.equal(await page.getByLabel('自定义物品主色', { exact: true }).inputValue(), '#386a78')
  assert.equal(await page.getByLabel('自定义部件颜色', { exact: true }).inputValue(), '#eab35e')
  const colorParts = {
    mug: ['杯身', '杯把与内釉'], tote: ['包身', '提带与包边'], tee: ['衣身', '领口与袖边'],
    cushion: ['枕面', '滚边'], scarf: ['巾面', '卷边'], notebook: ['封面', '书脊与绑带'],
    vase: ['瓶身', '瓶口与内釉'], poster: ['衬纸', '画框'],
    tumbler: ['杯身', '杯盖与底圈'], coaster: ['垫面', '外缘'], bookmark: ['书签面', '流苏与织边'],
    fan: ['扇面', '扇骨'], phonecase: ['背壳', '边框与镜头圈'], pouch: ['包身', '拉链与提环'],
  }
  for (const carrier of Object.keys(labels)) {
    await page.getByRole('tab', { name: '选择文创', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(labels[carrier]), exact: false }).click()
    await page.waitForURL(url => url.searchParams.get('carrier') === carrier)
    await page.getByRole('tab', { name: '物品配色', exact: true }).click()
    assert.equal(await page.getByLabel('自定义物品主色', { exact: true }).inputValue(), '#386a78')
    assert.equal(await page.getByLabel('自定义部件颜色', { exact: true }).inputValue(), '#eab35e')
    assert.equal(await page.locator('.workshop-colors legend').innerText(), colorParts[carrier][0])
    assert.equal(await page.locator('.workshop-detail-colors legend').innerText(), colorParts[carrier][1])
  }
  await page.screenshot({ path: 'test-results/workshop-colors.png', fullPage: true })
  checks.push('Twelve presets and custom body/detail colors alter pixels independently and survive source/carrier changes, save, reload, and museum return')
  await page.evaluate(value => sessionStorage.setItem('xiuwen-workshop-session-v1', JSON.stringify(value)), stored)

  await page.goto(baseUrl + '/workshop?pattern=DX060&carrier=mug&source=session')
  await ready()
  assert.equal(await page.locator('.workshop-reference img').getAttribute('src'), textureUrl)
  assert.match(await page.locator('.workshop-reference figcaption').innerText(), /创生工坊/)
  await page.getByRole('button', { name: /文化衫/ }).click()
  await ready()
  await page.getByRole('button', { name: '保存贴图方案', exact: true }).click()
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('xiuwen-workshop-session-v1')))
  assert.equal(saved.source, 'create')
  assert.equal(saved.carrier, 'tee')
  assert.equal(saved.textureUrl, textureUrl)
  assert.match(await page.locator('.workshop-feedback').innerText(), /已保存/)
  checks.push('Saving preserves generated texture provenance and selected carrier')
  await chooseSource('母纹原图')
  await ready()
  assert.notEqual(await page.locator('.workshop-reference img').getAttribute('src'), textureUrl)
  await chooseSource('已保存的创作纹理')
  await ready()
  assert.equal(await page.locator('.workshop-reference img').getAttribute('src'), textureUrl)
  checks.push('Original/generated texture switching preserves the saved candidate')

  const savedBeforeOriginalTransfer = await page.evaluate(() => sessionStorage.getItem('xiuwen-workshop-session-v1'))
  await chooseSource('母纹原图')
  await ready()
  await page.getByRole('link', { name: /进入 3D 博物馆/ }).click()
  await page.waitForURL(/\/museum\?/)
  assert.equal(new URL(page.url()).searchParams.get('source'), 'library')
  assert.equal(await page.evaluate(() => sessionStorage.getItem('xiuwen-workshop-session-v1')), savedBeforeOriginalTransfer)
  await page.goBack()
  await ready()
  await chooseSource('已保存的创作纹理')
  await ready()
  assert.equal(await page.locator('.workshop-reference img').getAttribute('src'), textureUrl)
  checks.push('Original-image museum transfer preserves the generated candidate for return visits')

  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    window.restoreStorage = () => { Storage.prototype.setItem = original }
    Storage.prototype.setItem = function (key, value) {
      if (key === 'xiuwen-workshop-session-v1') throw new DOMException('Test quota', 'QuotaExceededError')
      return original.call(this, key, value)
    }
  })
  await page.getByRole('button', { name: '保存贴图方案', exact: true }).click()
  assert.match(await page.locator('.workshop-error').innerText(), /保存/)
  const beforeNavigation = page.url()
  await page.getByRole('link', { name: /进入 3D 博物馆/ }).click()
  assert.equal(page.url(), beforeNavigation)
  await page.evaluate(() => window.restoreStorage())
  await page.getByRole('link', { name: /进入 3D 博物馆/ }).click()
  await page.waitForURL(/\/museum\?/)
  assert.equal(new URL(page.url()).searchParams.get('carrier'), 'tee')
  assert.equal(new URL(page.url()).searchParams.get('source'), 'session')
  checks.push('Storage failure is visible and prevents an incomplete museum transfer')

  await page.goto(baseUrl + '/workshop?pattern=DX027&carrier=invalid&source=library')
  await ready()
  assert.equal(await page.getByRole('button', { name: /马克杯/ }).getAttribute('aria-pressed'), 'true')
  await page.getByLabel('文创母纹').selectOption('DX042')
  await ready()
  await page.getByRole('button', { name: /帆布袋/ }).click()
  await ready()
  await page.goBack()
  await ready()
  assert.equal(await page.getByLabel('文创母纹').inputValue(), 'DX042')
  assert.equal(await page.getByRole('button', { name: /马克杯/ }).getAttribute('aria-pressed'), 'true')
  await page.goBack()
  await ready()
  assert.equal(await page.getByLabel('文创母纹').inputValue(), 'DX027')
  checks.push('Invalid carrier is safe and browser Back restores same-route selections')

  const firstPatternId = await page.getByLabel('文创母纹').locator('option').first().getAttribute('value')
  await page.evaluate(value => sessionStorage.setItem('xiuwen-workshop-session-v1', JSON.stringify(value)), { ...stored, patternId: firstPatternId })
  await page.goto(baseUrl + '/workshop?pattern=does-not-exist')
  await ready()
  assert.equal(await page.getByLabel('文创母纹').inputValue(), firstPatternId)
  assert.notEqual(await page.locator('.workshop-reference img').getAttribute('src'), textureUrl)
  await page.getByRole('button', { name: /帆布袋/ }).click()
  await ready()
  assert.equal(new URL(page.url()).searchParams.get('source'), 'library')
  assert.notEqual(await page.locator('.workshop-reference img').getAttribute('src'), textureUrl)
  checks.push('Invalid pattern fallback remains on its original image after changing carrier')

  await page.route('**/workshop-test-texture.png', route => route.abort())
  await page.evaluate(value => sessionStorage.setItem('xiuwen-workshop-session-v1', JSON.stringify({ ...value, textureUrl: '/workshop-test-texture.png' })), stored)
  await page.goto(baseUrl + '/workshop?pattern=DX060&source=session')
  await page.locator('.workshop-canvas[data-render-state="error"]').waitFor()
  assert.match(await page.locator('.workshop-overlay').innerText(), /加载失败/)
  await page.unroute('**/workshop-test-texture.png')
  await page.route('**/workshop-test-texture.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: image }))
  await page.getByRole('button', { name: '重新加载预览', exact: true }).click()
  await ready()
  checks.push('Failed image load reports an error and retries successfully')
  await page.evaluate(() => {
    const canvas = document.querySelector('.workshop-canvas canvas')
    canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()
  })
  await page.locator('.workshop-canvas[data-render-state="error"]').waitFor()
  await page.getByRole('button', { name: '重新加载预览', exact: true }).click()
  await ready()
  assert.equal(await page.locator('.workshop-canvas canvas').count(), 1)
  checks.push('Lost WebGL context recovers without duplicate canvases')

  await page.goto(baseUrl + '/workshop?pattern=DX027&carrier=tee&source=library')
  await ready()
  for (const carrier of ['mug', 'tee', 'tote', 'poster', 'tee']) await page.getByRole('button', { name: new RegExp(labels[carrier]) }).click()
  await ready()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: 'test-results/workshop-mobile.png', fullPage: true })
  await page.getByRole('tab', { name: '物品配色', exact: true }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: 'test-results/workshop-mobile-colors.png', fullPage: true })
  checks.push('Rapid carrier switching and 390px mobile layout remain usable')

  const fallbackContext = await browser.newContext()
  await fallbackContext.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null
      return original.call(this, type, ...args)
    }
  })
  const fallbackPage = await fallbackContext.newPage()
  await fallbackPage.goto(baseUrl + '/workshop?pattern=DX027')
  await fallbackPage.locator('.workshop-canvas[data-render-state="error"]').waitFor()
  assert.match(await fallbackPage.locator('.workshop-overlay').innerText(), /未能启用三维/)
  assert.equal(await fallbackPage.getByRole('button', { name: '下载预览图' }).isEnabled(), false)
  await fallbackContext.close()
  checks.push('Unavailable WebGL has an actionable fallback')
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ checks, pageErrors: failures }, null, 2))
} finally { await browser.close() }
