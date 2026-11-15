import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import sharp from 'sharp'

const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true })
await context.addInitScript(() => {
  window.__THREE_DEVTOOLS__ = new EventTarget()
  window.__THREE_DEVTOOLS__.addEventListener('observe', event => {
    const renderer = event.detail
    if (!renderer.isWebGLRenderer) return
    const render = renderer.render
    renderer.render = function (scene, camera) {
      render.call(this, scene, camera)
      window.__museumRenderedScene = scene
      window.__museumRenderedCamera = camera
    }
  })
})
const page = await context.newPage()
page.setDefaultTimeout(25_000)
const errors = []
const exhibits = [
  ['mug', '马克杯'], ['vase', '陶瓷花器'], ['tote', '帆布袋'], ['tee', '文化衫'],
  ['cushion', '织纹抱枕'], ['scarf', '丝巾'], ['notebook', '精装笔记本'], ['poster', '装裱画'],
  ['tumbler', '随行保温杯'], ['coaster', '陶瓷杯垫'], ['bookmark', '织纹书签'],
  ['fan', '折扇'], ['phonecase', '手机壳'], ['pouch', '拉链收纳包'],
]
page.on('pageerror', error => errors.push(error.message))
mkdirSync('test-results', { recursive: true })
const ready = () => page.getByRole('status').filter({ hasText: /^已就绪$/ }).waitFor()
const projectedBounds = () => page.evaluate(async () => {
  const resource = performance.getEntriesByType('resource').find(entry => /\/deps\/three\.js/.test(entry.name))
  if (!resource) throw new Error('Three.js resource was not loaded')
  const THREE = await import(resource.name)
  return window.__museumRenderedScene.children.filter(child => child.userData.productCarrier).map(group => {
    const box = new THREE.Box3().setFromObject(group)
    const points = []
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const projected = new THREE.Vector3(x, y, z).project(window.__museumRenderedCamera)
      points.push({ x: projected.x, y: projected.y, z: projected.z })
    }
    return { carrier: group.userData.productCarrier, visible: group.visible, points }
  })
})
const allVisible = points => points.every(point => Math.abs(point.x) < 0.98 && Math.abs(point.y) < 0.98 && point.z > -1 && point.z < 1)
const exportGallery = async () => {
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出展厅截图', exact: true }).click()
  const download = await downloadEvent
  assert.ok(download.suggestedFilename().endsWith('.png'))
  return readFileSync(await download.path())
}

try {
  await page.goto(`${baseUrl}/museum?pattern=DX027&carrier=tee&source=library`)
  await ready()
  assert.equal(await page.getByLabel('展陈母纹').inputValue(), 'DX027')
  assert.equal(await page.locator('.museum-canvas canvas').count(), 1)
  assert.equal(await page.getByText('生成 Marble Mock 记录', { exact: true }).count(), 0)
  const catalog = await page.evaluate(async () => (await import('/src/productCatalog.ts')).PRODUCT_CATALOG.map(({ id, label, category }) => ({ id, label, category })))
  assert.equal(catalog.length, exhibits.length)
  for (const [id, label] of exhibits) assert.ok(catalog.some(item => item.id === id && item.label === label))
  await page.locator('.museum-stage').scrollIntoViewIfNeeded()
  const overview = await page.locator('.museum-canvas canvas').screenshot()
  const statistics = await sharp(overview).stats()
  assert.ok(statistics.channels.some(channel => channel.stdev > 12), 'The gallery should contain visibly rendered exhibits')
  await page.screenshot({ path: 'test-results/museum-desktop.png', fullPage: true })
  const desktopBounds = await projectedBounds()
  assert.equal(desktopBounds.filter(item => item.visible).length, exhibits.length)
  assert.ok(desktopBounds.every(item => allVisible(item.points)), 'Every complete exhibit must fit inside the desktop overview')
  for (const [id, label] of exhibits) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.waitForTimeout(200)
    assert.equal(await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true')
    assert.notDeepEqual(await page.locator('.museum-canvas canvas').screenshot(), overview)
    const bounds = await projectedBounds()
    assert.deepEqual(bounds.filter(item => item.visible).map(item => item.carrier), [id], 'A close-up must clear other exhibits from the sightline')
    assert.ok(allVisible(bounds.find(item => item.carrier === id).points), `${label} must fit fully inside its desktop close-up`)
  }
  for (const category of new Set(catalog.map(item => item.category))) {
    await page.getByRole('button', { name: category + '展区', exact: true }).click()
    const selected = (await projectedBounds()).filter(item => item.visible)
    assert.deepEqual(selected.map(item => item.carrier).sort(), catalog.filter(item => item.category === category).map(item => item.id).sort())
    assert.ok(selected.every(item => allVisible(item.points)), `${category} must fit inside its focused collection view`)
  }
  await page.locator('.museum-stage').screenshot({ path: 'test-results/museum-collection.png' })
  await page.getByRole('button', { name: '文化衫', exact: true }).click()
  const defaultTee = await page.locator('.museum-canvas canvas').screenshot()
  await page.locator('.museum-stage').screenshot({ path: 'test-results/museum-closeup.png' })
  await page.getByRole('button', { name: '向左旋转视角' }).click()
  await page.getByRole('button', { name: '拉近', exact: true }).click()
  await page.getByRole('button', { name: '重置视角', exact: true }).click()
  await page.getByRole('button', { name: '自动旋转展品', exact: true }).click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '暂停展品旋转', exact: true }).click()
  await page.waitForTimeout(300)
  const paused = await exportGallery()
  await page.waitForTimeout(250)
  assert.ok((await exportGallery()).equals(paused), 'Paused exhibits must remain stationary')
  const exported = await sharp(paused).stats()
  assert.ok(exported.channels.some(channel => channel.stdev > 12), 'Export must contain real rendered gallery pixels')
  await page.getByRole('button', { name: '重置视角', exact: true }).click()
  await page.getByRole('button', { name: '下一件', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '马克杯', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: '上一件', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: catalog.at(-1).label, exact: true }).getAttribute('aria-pressed'), 'true')
  const designParams = 'printScale=0.65&printX=0.15&printY=-0.1&printRotation=30&printRepeat=false&printRemoveBackground=true&productColor=%232f5863&productDetailColor=%23e7c78a'
  await page.goto(`${baseUrl}/museum?pattern=DX027&carrier=tee&source=library&${designParams}`)
  await ready()
  await page.getByRole('button', { name: '文化衫', exact: true }).click()
  const designedTee = await page.locator('.museum-canvas canvas').screenshot()
  assert.notDeepEqual(designedTee, defaultTee, 'Saved appearance must change the actual featured product rendering')
  const returnUrl = new URL(await page.getByRole('link', { name: '继续调整文创贴图', exact: true }).getAttribute('href'), baseUrl)
  for (const [key, value] of new URLSearchParams(designParams)) assert.equal(returnUrl.searchParams.get(key), value)
  await page.getByRole('button', { name: '陶瓷花器', exact: true }).click()
  assert.equal(new URL(await page.getByRole('link', { name: '继续调整文创贴图', exact: true }).getAttribute('href'), baseUrl).searchParams.get('carrier'), 'tee', 'Changing the gallery view must preserve the current design carrier')
  const secondColorUrl = new URL(page.url())
  secondColorUrl.searchParams.set('productDetailColor', '#8a3e49')
  await page.goto(secondColorUrl.toString())
  await ready()
  await page.getByRole('button', { name: '文化衫', exact: true }).click()
  assert.notDeepEqual(await page.locator('.museum-canvas canvas').screenshot(), designedTee, 'Changing only the detail color must change the visible featured model')
  const changedReturn = new URL(await page.getByRole('link', { name: '继续调整文创贴图', exact: true }).getAttribute('href'), baseUrl)
  assert.equal(changedReturn.searchParams.get('productColor'), '#2f5863')
  assert.equal(changedReturn.searchParams.get('productDetailColor'), '#8a3e49')
  for (const [id, label] of exhibits.slice(8)) {
    await page.goto(`${baseUrl}/museum?pattern=DX027&carrier=${id}&source=library&${designParams}`)
    await ready()
    await page.getByRole('button', { name: label, exact: true }).click()
    const print = await page.evaluate(carrier => {
      const group = window.__museumRenderedScene.children.find(item => item.userData.productCarrier === carrier)
      let settings
      group.traverse(mesh => { if (mesh.material?.userData.print) settings = mesh.material.userData.print })
      return settings
    }, id)
    assert.equal(print.color, '#2f5863', `${label} must use the featured body color`)
    assert.equal(print.detailColor, '#e7c78a', `${label} must keep the featured detail color`)
    const link = new URL(await page.getByRole('link', { name: '继续调整文创贴图', exact: true }).getAttribute('href'), baseUrl)
    assert.equal(link.searchParams.get('carrier'), id)
    for (const [key, value] of new URLSearchParams(designParams)) assert.equal(link.searchParams.get(key), value)
    await page.locator('.museum-stage').screenshot({ path: `test-results/museum-featured-${id}.png` })
  }
  for (const id of ['DX001', 'DX042', 'DX027']) await page.getByLabel('展陈母纹').selectOption(id)
  await ready()
  assert.equal(await page.locator('.museum-canvas canvas').count(), 1)
  assert.match(page.url(), /pattern=DX027/)
  await page.goBack()
  await ready()
  assert.equal(await page.getByLabel('展陈母纹').inputValue(), 'DX042')
  await page.evaluate(async () => {
    const patterns = await (await fetch('/data/patterns.json')).json()
    const pattern = patterns.find(item => item.id === 'DX027')
    sessionStorage.setItem('xiuwen-workshop-session-v1', JSON.stringify({
      patternId: pattern.id, patternName: pattern.name, carrier: 'tee', source: 'create',
      textureUrl: pattern.image, createdAt: new Date().toISOString(),
      appearance: { scale: 1.2, offsetX: 0.1, offsetY: -0.1, rotation: 20, repeat: false, removeBackground: false, color: 'indigo' },
    }))
  })
  await page.goto(`${baseUrl}/museum?pattern=DX027&carrier=tee&source=session`)
  await ready()
  const legacyReturn = new URL(await page.getByRole('link', { name: '继续调整文创贴图', exact: true }).getAttribute('href'), baseUrl)
  assert.equal(legacyReturn.searchParams.get('productColor'), 'indigo')
  assert.equal(legacyReturn.searchParams.get('productDetailColor'), 'auto')
  assert.equal(legacyReturn.searchParams.get('printScale'), '1.2')
  await page.evaluate(() => sessionStorage.setItem('xiuwen-workshop-session-v1', JSON.stringify({
    patternId: 'DX001', patternName: '旧会话', carrier: 'tote', source: 'create',
    textureUrl: '/missing-invalid-pattern-test.png', createdAt: new Date().toISOString(),
  })))
  for (const invalidPattern of ['INVALID', '']) {
    await page.goto(`${baseUrl}/museum?pattern=${invalidPattern}&carrier=invalid`)
    await ready()
    assert.equal(await page.getByLabel('展陈母纹').inputValue(), 'DX001')
    assert.match(page.url(), /carrier=mug/)
    assert.match(page.url(), /source=library/)
    assert.doesNotMatch(await page.getByAltText('当前文创贴图').getAttribute('src'), /missing-invalid-pattern/)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(200)
  await page.locator('.museum-stage').scrollIntoViewIfNeeded()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  const overviewBounds = await projectedBounds()
  assert.equal(overviewBounds.filter(item => item.visible).length, exhibits.length)
  assert.ok(overviewBounds.every(item => allVisible(item.points)), 'Every complete exhibit must fit inside the mobile overview')
  await page.screenshot({ path: 'test-results/museum-mobile.png', fullPage: true })
  for (const [id, label] of exhibits) {
    await page.getByLabel('切换展厅视角').selectOption(id)
    await page.waitForTimeout(100)
    const bounds = await projectedBounds()
    assert.ok(allVisible(bounds.find(item => item.carrier === id).points), `${label} must fit fully inside its mobile close-up`)
  }
  for (const category of new Set(catalog.map(item => item.category))) {
    await page.getByLabel('切换展厅视角').selectOption(`collection:${category}`)
    await page.waitForTimeout(100)
    const selected = (await projectedBounds()).filter(item => item.visible)
    assert.ok(selected.every(item => allVisible(item.points)), `${category} must fit fully inside its mobile collection view`)
  }
  await page.locator('.museum-stage').screenshot({ path: 'test-results/museum-mobile-collection.png' })
  await page.getByRole('button', { name: '展厅全景', exact: true }).click()
  await page.locator('.museum-canvas canvas').evaluate(canvas => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext())
  await page.getByRole('button', { name: '重新加载展厅', exact: true }).waitFor()
  await page.getByRole('button', { name: '重新加载展厅', exact: true }).click()
  await ready()
  assert.equal(await page.locator('.museum-canvas canvas').count(), 1)

  const brokenContext = await browser.newContext()
  await brokenContext.addInitScript(() => {
    sessionStorage.setItem('xiuwen-workshop-session-v1', JSON.stringify({
      patternId: 'DX027', patternName: '保存的测试纹样', carrier: 'tote', source: 'create',
      textureUrl: '/missing-museum-test.png', createdAt: new Date().toISOString(),
    }))
  })
  const brokenPage = await brokenContext.newPage()
  await brokenPage.goto(`${baseUrl}/museum?pattern=DX027&source=session`)
  await brokenPage.getByRole('alert').filter({ hasText: '纹样图片加载失败' }).waitFor()
  assert.equal(await brokenPage.locator('.museum-canvas canvas').count(), 0)
  await brokenPage.getByRole('button', { name: '使用母纹原图', exact: true }).click()
  await brokenPage.getByRole('status').filter({ hasText: /^已就绪$/ }).waitFor()
  assert.equal(await brokenPage.locator('.museum-canvas canvas').count(), 1)
  await brokenContext.close()

  const stalledContext = await browser.newContext()
  await stalledContext.addInitScript(() => {
    sessionStorage.setItem('xiuwen-workshop-session-v1', JSON.stringify({
      patternId: 'DX027', patternName: '等待图片测试', carrier: 'tote', source: 'create',
      textureUrl: '/stalled-museum-test.png', createdAt: new Date().toISOString(),
    }))
  })
  const stalledPage = await stalledContext.newPage()
  await stalledPage.route('**/stalled-museum-test.png', () => {})
  await stalledPage.clock.install()
  await stalledPage.goto(`${baseUrl}/museum?pattern=DX027&source=session`, { waitUntil: 'domcontentloaded' })
  await stalledPage.locator('.museum-canvas canvas').waitFor()
  await stalledPage.clock.fastForward(20_001)
  await stalledPage.getByRole('alert').filter({ hasText: '纹样图片加载失败' }).waitFor()
  assert.equal(await stalledPage.locator('.museum-canvas canvas').count(), 0)
  await stalledContext.close()

  const noGpuContext = await browser.newContext()
  await noGpuContext.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      return kind.startsWith('webgl') ? null : original.call(this, kind, ...args)
    }
  })
  const noGpuPage = await noGpuContext.newPage()
  await noGpuPage.goto(`${baseUrl}/museum?pattern=DX027`)
  await noGpuPage.getByRole('alert').filter({ hasText: '无法启动三维显示' }).waitFor()
  assert.equal(await noGpuPage.getByAltText('母纹原图参考').isVisible(), true)
  await noGpuContext.close()
  assert.deepEqual(errors, [])
  console.log(`Museum passed: ${exhibits.length} rendered products and close-ups, category views, six new featured designs and color handoff, main/detail color pixels, legacy appearance migration, view/design isolation, previous/next, controls, pause, PNG export, rapid changes, URL/history, invalid input, desktop/mobile projected bounds, context loss/retry, texture failure/recovery/timeout, and WebGL fallback.`)
} finally {
  await browser.close()
}
