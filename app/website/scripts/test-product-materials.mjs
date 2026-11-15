import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const baseUrl = process.env.XIUWEN_TEST_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
mkdirSync('test-results', { recursive: true })
try {
  await page.goto(baseUrl + '/workshop?pattern=DX027&carrier=tee&source=library')
  await page.locator('.workshop-canvas[data-render-state="ready"]').waitFor()
  const report = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js')
    const { buildProduct, prepareProductTexture } = await import('/src/productModels.ts')
    const { defaultProductAppearance, PRODUCT_CATALOG } = await import('/src/productCatalog.ts')
    const { printedMaterial } = await import('/src/productMaterials.ts')
    const { resolveProductColor } = await import('/src/productColors.ts')
    const source = document.createElement('canvas')
    source.width = source.height = 100
    const context = source.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 100, 100)
    context.fillStyle = '#111111'
    context.fillRect(30, 30, 40, 40)
    context.fillStyle = '#ffffff'
    context.fillRect(40, 40, 20, 20)
    const texture = new THREE.CanvasTexture(source)
    const dispose = product => {
      const textures = new Set()
      const materials = new Set()
      product.traverse(object => {
        object.geometry?.dispose()
        for (const material of object.material ? Array.isArray(object.material) ? object.material : [object.material] : []) {
          materials.add(material)
          for (const property of Object.values(material)) if (property?.isTexture) textures.add(property)
        }
      })
      textures.forEach(value => value.dispose())
      materials.forEach(value => value.dispose())
    }
    const models = PRODUCT_CATALOG.map(({ id }) => {
      const settings = defaultProductAppearance(id)
      const prepared = prepareProductTexture(texture.clone(), id)
      const product = buildProduct(id, prepared, settings)
      const print = product.getObjectByName('product-print')
      const position = print.geometry.getAttribute('position')
      let minZ = Infinity
      let maxZ = -Infinity
      let finite = true
      for (let index = 0; index < position.count; index++) {
        minZ = Math.min(minZ, position.getZ(index))
        maxZ = Math.max(maxZ, position.getZ(index))
        finite &&= Number.isFinite(position.getX(index)) && Number.isFinite(position.getY(index)) && Number.isFinite(position.getZ(index))
      }
      const bounds = new THREE.Box3().setFromObject(product)
      let boundaryLoops = 0
      let boundaryBranches = 0
      let minTriangleQuality = 1
      let invertedTriangles = 0
      let reversedSideNormals = 0
      let invertedBackTriangles = 0
      let minBackTriangleQuality = 1
      if (id === 'tee') {
        const backGeometry = product.getObjectByName('shirt-back').geometry
        const backPosition = backGeometry.getAttribute('position')
        const backIndex = backGeometry.getIndex()
        for (let triangle = 0; triangle < backIndex.count; triangle += 3) {
          const vertices = [0, 1, 2].map(corner => backIndex.getX(triangle + corner))
          const points = vertices.map(vertex => new THREE.Vector2(backPosition.getX(vertex), backPosition.getY(vertex)))
          const twiceArea = -((points[1].x - points[0].x) * (points[2].y - points[0].y) - (points[1].y - points[0].y) * (points[2].x - points[0].x))
          if (twiceArea <= 0) invertedBackTriangles++
          const sumSquared = points.reduce((sum, point, corner) => sum + point.distanceToSquared(points[(corner + 1) % 3]), 0)
          minBackTriangleQuality = Math.min(minBackTriangleQuality, 2 * Math.sqrt(3) * twiceArea / sumSquared)
        }
        const sideGeometry = product.getObjectByName('shirt-sewn-sides').geometry
        const sidePosition = sideGeometry.getAttribute('position')
        const sideNormal = sideGeometry.getAttribute('normal')
        const sideIndex = sideGeometry.getIndex()
        for (let triangle = 0; triangle < sideIndex.count; triangle += 3) {
          const vertices = [0, 1, 2].map(corner => sideIndex.getX(triangle + corner))
          const points = vertices.map(vertex => new THREE.Vector3().fromBufferAttribute(sidePosition, vertex))
          const geometric = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize()
          const shading = vertices.reduce((sum, vertex) => sum.add(new THREE.Vector3().fromBufferAttribute(sideNormal, vertex)), new THREE.Vector3()).normalize()
          if (geometric.dot(shading) < 0) reversedSideNormals++
        }
        const edges = new Map()
        const indices = print.geometry.getIndex()
        for (let index = 0; index < indices.count; index += 3) {
          const triangle = [indices.getX(index), indices.getX(index + 1), indices.getX(index + 2)]
          const points = triangle.map(vertex => new THREE.Vector2(position.getX(vertex), position.getY(vertex)))
          const twiceArea = (points[1].x - points[0].x) * (points[2].y - points[0].y) - (points[1].y - points[0].y) * (points[2].x - points[0].x)
          if (twiceArea <= 0) invertedTriangles++
          const sumSquared = points.reduce((sum, point, corner) => sum + point.distanceToSquared(points[(corner + 1) % 3]), 0)
          minTriangleQuality = Math.min(minTriangleQuality, 2 * Math.sqrt(3) * twiceArea / sumSquared)
          for (let corner = 0; corner < 3; corner++) {
            const a = triangle[corner]
            const b = triangle[(corner + 1) % 3]
            const key = a < b ? `${a}-${b}` : `${b}-${a}`
            edges.set(key, (edges.get(key) ?? 0) + 1)
          }
        }
        const boundary = new Map()
        for (const [key, count] of edges) {
          if (count > 2) boundaryBranches++
          if (count !== 1) continue
          const [a, b] = key.split('-').map(Number)
          boundary.set(a, [...(boundary.get(a) ?? []), b])
          boundary.set(b, [...(boundary.get(b) ?? []), a])
        }
        boundaryBranches += [...boundary.values()].filter(neighbors => neighbors.length !== 2).length
        const visited = new Set()
        for (const vertex of boundary.keys()) {
          if (visited.has(vertex)) continue
          boundaryLoops++
          const pending = [vertex]
          while (pending.length) {
            const current = pending.pop()
            if (visited.has(current)) continue
            visited.add(current)
            pending.push(...boundary.get(current).filter(value => !visited.has(value)))
          }
        }
      }
      product.updateMatrixWorld(true)
      const ray = new THREE.Raycaster(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, -1, 0))
      const openingHits = ['mug', 'vase', 'tote', 'tee'].includes(id)
        ? [...new Set(ray.intersectObject(product, true).map(hit => Math.round(hit.point.y * 1000) / 1000))] : []
      const sleeveRay = new THREE.Raycaster(new THREE.Vector3(1.4, 0.4, 0), new THREE.Vector3(-1, 0, 0))
      const sleeveHits = id === 'tee' ? sleeveRay.intersectObject(product, true).length : 0
      const result = {
        id, finite, openingHits, sleeveHits, vertices: position.count, depth: maxZ - minZ,
        dimensions: bounds.getSize(new THREE.Vector3()).toArray(),
        composed: print.material.map !== prepared && print.material.map.image instanceof HTMLCanvasElement,
        material: print.material.type, hasPrintMetadata: Boolean(print.material.userData.print), boundaryLoops, boundaryBranches, minTriangleQuality, invertedTriangles, reversedSideNormals, invertedBackTriangles, minBackTriangleQuality,
      }
      dispose(product)
      prepared.dispose()
      return result
    })
    const detailNames = {
      mug: 'mug-handle', vase: 'vase-rim', tote: 'tote-handle', tee: 'shirt-collar',
      cushion: 'cushion-piping', scarf: 'scarf-rolled-hem', notebook: 'notebook-spine', poster: 'poster-frame',
      tumbler: 'tumbler-lid', coaster: 'coaster-rim', bookmark: 'bookmark-tassel',
      fan: 'fan-ribs', phonecase: 'phonecase-rim', pouch: 'pouch-zipper',
    }
    context.fillStyle = '#b32941'
    context.fillRect(0, 0, 100, 100)
    texture.needsUpdate = true
    const colors = []
    for (const [body, detail] of [['#416f78', '#d5b279'], ['#9f5346', '#294452']]) {
      for (const { id } of PRODUCT_CATALOG) {
        const settings = { ...defaultProductAppearance(id), color: body, detailColor: detail, repeat: false, removeBackground: false }
        const product = buildProduct(id, texture, settings)
        const image = product.getObjectByName('product-print').material.map.image
        const pixels = image.getContext('2d')
        colors.push({ id, body, detail,
          bodyPixel: Array.from(pixels.getImageData(2, 2, 1, 1).data),
          printPixel: Array.from(pixels.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data),
          detailHex: `#${product.getObjectByName(detailNames[id]).material.color.getHexString()}`,
        })
        dispose(product)
      }
    }
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 100, 100)
    context.fillStyle = '#111111'
    context.fillRect(30, 30, 40, 40)
    context.fillStyle = '#ffffff'
    context.fillRect(40, 40, 20, 20)
    texture.needsUpdate = true
    const appearance = { ...defaultProductAppearance('cushion'), color: 'indigo', removeBackground: true }
    const material = printedMaterial(texture, appearance, 1, 1, { width: 1, height: 1 }, 'fabric')
    const image = material.map.image
    const pixels = image.getContext('2d')
    const pixel = (x, y) => Array.from(pixels.getImageData(Math.round(x * image.width), Math.round(y * image.height), 1, 1).data)
    const removed = pixel(0.1, 0.1)
    const enclosed = pixel(0.5, 0.5)
    const dark = pixel(0.35, 0.5)
    material.map.dispose()
    material.dispose()
    texture.dispose()
    const actualImage = document.querySelector('.workshop-reference img')
    await actualImage.decode()
    const actualTexture = new THREE.Texture(actualImage)
    const paperSample = []
    for (const removeBackground of [false, true]) {
      const actual = printedMaterial(actualTexture, { ...appearance, removeBackground }, 1, 1, { width: 1, height: 1 }, 'fabric')
      const image = actual.map.image
      paperSample.push(Array.from(image.getContext('2d').getImageData(Math.round(image.width * 0.5), Math.round(image.height * 0.16), 1, 1).data))
      actual.map.dispose()
      actual.dispose()
    }
    actualTexture.dispose()
    return { models, colors, removed, enclosed, dark, paperSample, indigo: resolveProductColor('indigo') }
  })
  assert.equal(report.models.length, 14)
  for (const model of report.models) {
    assert.equal(model.finite, true, model.id)
    assert.equal(model.composed, true, `${model.id} must use an integrated print map`)
    assert.equal(model.hasPrintMetadata, true)
    assert.ok(model.dimensions.every(value => value > 0.005 && value < 4), model.id)
    if (['tee', 'tote', 'cushion', 'scarf'].includes(model.id)) {
      assert.ok(model.vertices > 2000, `${model.id} needs tessellation for cloth deformation`)
      assert.ok(model.depth > 0.05, `${model.id} printed surface must follow real folds`)
    }
    if (model.id === 'tee') {
      assert.equal(model.openingHits.length, 0, 'Neck and hem must remain open through the garment interior')
      assert.equal(model.sleeveHits, 0, 'Sleeve openings must lead into the hollow garment')
      assert.equal(model.boundaryLoops, 1, 'The garment must have only its outside silhouette, with no interior cracks')
      assert.equal(model.boundaryBranches, 0, 'Shared garment edges must form a conforming manifold mesh')
      assert.equal(model.invertedBackTriangles, 0, 'The shallow back neckline must retain every back-facing triangle')
      assert.ok(model.minBackTriangleQuality > 0.00015, 'The back neckline must avoid needle triangles and shading speckles')
      assert.equal(model.reversedSideNormals, 0, 'Rounded shoulder and side-wall winding must agree with their explicit outward normals')
      assert.equal(model.invertedTriangles, 0, 'Every garment triangle must retain its front-facing winding')
      assert.ok(model.minTriangleQuality > 0.00015, 'Needle-like outline triangles cause visible shading seams')
    }
  }
  for (const model of report.models.filter(value => ['mug', 'vase', 'tote'].includes(value.id))) {
    assert.ok(model.openingHits.length > 0, `${model.id} must have an internal floor`)
    assert.ok(model.openingHits[0] < -0.4, `${model.id} must have an open mouth above the internal floor`)
  }
  for (const color of report.colors) {
    const expected = color.body.slice(1).match(/../g).map(value => Number.parseInt(value, 16))
    assert.deepEqual(color.bodyPixel, [...expected, 255], `${color.id} must use arbitrary body color on its actual print surface`)
    assert.equal(color.detailHex, color.detail, `${color.id} must apply its independent detail color`)
    assert.deepEqual(color.printPixel, [179, 41, 65, 255], `${color.id} must preserve opaque motif RGB across body colors`)
  }
  assert.deepEqual(report.removed, [36, 62, 80, 255], 'The edge-connected pale background must reveal the material color')
  assert.deepEqual(report.enclosed, [255, 255, 255, 255], 'Enclosed white motif details must be preserved')
  assert.ok(report.dark.slice(0, 3).every(value => value < 30), 'Dark embroidery must remain intact')
  assert.notDeepEqual(report.paperSample[0], report.paperSample[1], 'The actual DX027 paper background must change after removal')
  assert.deepEqual(report.paperSample[1], [36, 62, 80, 255], 'DX027 warm paper must reveal the selected cloth color')
  const renderColors = {
    mug: ['#95acb4', 'ivory'], vase: ['#79958b', '#faf8f2'], tote: ['#b9a17c', '#79553d'],
    tee: ['indigo', 'ivory'], cushion: ['#79958b', '#b9a17c'], scarf: ['#8a3e49', '#c89b4e'],
    notebook: ['#52624b', '#303436'], poster: ['ivory', '#79553d'],
    tumbler: ['#95acb4', '#303436'], coaster: ['ivory', '#79958b'], bookmark: ['#8a3e49', '#c89b4e'],
    fan: ['ivory', '#79553d'], phonecase: ['#79958b', '#303436'], pouch: ['#b9a17c', '#79553d'],
  }
  for (const { id } of report.models) {
    await page.goto(`${baseUrl}/workshop?pattern=DX027&carrier=${id}&source=library&productColor=${encodeURIComponent(renderColors[id][0])}&productDetailColor=${encodeURIComponent(renderColors[id][1])}&printRemoveBackground=true`)
    await page.locator('.workshop-canvas[data-render-state="ready"]').waitFor()
    await page.waitForTimeout(200)
    await page.locator('.workshop-stage').screenshot({ path: `test-results/product-material-${id}.png` })
  }
  for (const color of ['ivory', 'indigo']) {
    await page.goto(`${baseUrl}/workshop?pattern=DX027&carrier=tee&source=library&productColor=${color}&printRemoveBackground=true`)
    await page.locator('.workshop-canvas[data-render-state="ready"]').waitFor()
    for (const [view, label] of [['front', '正面'], ['back', '背面'], ['perspective', '重置视角']]) {
      await page.getByRole('button', { name: label, exact: true }).click()
      await page.waitForTimeout(150)
      await page.locator('.workshop-stage').screenshot({ path: `test-results/product-tee-${color}-${view}.png` })
    }
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ models: report.models, checks: ['open garment neck / sleeves / hem', 'open vessel and lined bag interiors', 'all fourteen custom body and accessory colors', 'opaque motif RGB preserved', 'fourteen real renders', 'finite geometry', 'curved cloth UV surfaces', 'integrated material maps', 'edge-connected background removal', 'enclosed white preservation'] }, null, 2))
} finally {
  await browser.close()
}
