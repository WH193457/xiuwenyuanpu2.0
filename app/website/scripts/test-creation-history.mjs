import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const websiteDirectory = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({
  stdin: {
    contents: "import * as history from './src/creationHistory'; globalThis.creationHistory = history",
    resolveDir: websiteDirectory,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'browser',
})
const server = createServer((request, response) => {
  if (request.url === '/history.js') {
    response.setHeader('Content-Type', 'application/javascript')
    response.end(bundle.outputFiles[0].text)
    return
  }
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><title>Creation history regression</title><script src="/history.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }),
  })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)

  const pattern = {
    id: 'DX001', image: '/patterns/DX001.webp', original_file: 'source.png', name: '测试母纹',
    category: '几何与边饰', main_elements: ['菱形'], secondary_elements: [], composition: '中心式',
    symmetry_repeat: '左右对称', colors: ['红'], visual_description: '菱形',
    meaning: '[中性设计意向] 秩序', source_ids: [], element_ids: [], generation_keywords: ['菱形'],
  }
  const legacyRecord = {
    result: {
      id: 'legacy', createdAt: '2026-11-08T00:00:00Z', pattern,
      composition: '中心式', palette: '红', intention: '秩序', carrier: '海报',
      candidates: [
        { image: 'data:image/png;base64,AAAA', seed: 0, path: 'first.png' },
        { image: 'data:image/png;base64,BBBB', seed: 1, path: 'second.png' },
      ],
    },
    selectedIndex: 99, note: '旧版本数据',
  }

  // Create the previous database version before opening it through the current application.
  await page.evaluate(record => new Promise((resolve, reject) => {
    const request = indexedDB.open('xiuwen-creations-v1', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('creations', { keyPath: 'result.id' })
      store.createIndex('createdAt', 'createdAtTimestamp')
    }
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('creations', 'readwrite')
      transaction.objectStore('creations').put({ ...record, createdAtTimestamp: Date.parse(record.result.createdAt) })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
    request.onerror = () => reject(request.error)
  }), legacyRecord)
  let records = await page.evaluate(() => creationHistory.listCreations())
  assert.equal(records.length, 1)
  assert.equal(records[0].result.id, 'legacy', 'Upgrading the database must retain existing creations')
  assert.equal(records[0].selectedIndex, 1)
  assert.equal(records[0].result.candidates[0].seed, 0)
  const legacyManifest = await page.evaluate(record => creationHistory.creationManifest(record), legacyRecord)
  assert.equal(legacyManifest.runtime.generationProfile, 'standard')
  assert.equal(legacyManifest.runtime.generationPolicy, undefined)
  assert.equal(await page.evaluate(() => creationHistory.loadDraft()), undefined)
  const upgradedDatabase = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('xiuwen-creations-v1')
    request.onsuccess = () => {
      const database = request.result
      resolve({ version: database.version, stores: [...database.objectStoreNames] })
      database.close()
    }
    request.onerror = () => reject(request.error)
  }))
  assert.equal(upgradedDatabase.version, 2)
  assert.deepEqual(upgradedDatabase.stores, ['creations', 'drafts'])

  const concurrentRecords = Array.from({ length: 20 }, (_, index) => ({
    ...legacyRecord,
    result: {
      ...legacyRecord.result,
      id: `run-${index}`,
      createdAt: new Date(Date.UTC(2026, 10, 8, 1, index)).toISOString(),
    },
    selectedIndex: 0,
  }))
  await page.evaluate(records => Promise.all(records.map(record => creationHistory.saveCreation(record))), concurrentRecords)
  records = await page.evaluate(() => creationHistory.listCreations())
  assert.equal(records.length, 12)
  assert.equal(records[0].result.id, 'run-19')
  assert.equal(records[11].result.id, 'run-8')

  const latest = {
    ...records[0],
    note: '保留边框，继续调整红色', parentId: 'run-18', selectedIndex: 1,
    result: {
      ...records[0].result,
      prompt: 'dongzu, diamond border', negativePrompt: 'blurry',
      parentResultId: 'run-18',
      model: 'dongzu_embroidery_v2', baseModel: 'sd1.5', steps: 30, guidance: 7.2,
      loraScale: 0.65,
      generationProfile: 'subject-fidelity',
      generationPolicy: { version: 1, fixture: true, rules: ['preserve-explicit-border'], nested: { enabled: true } },
      assistance: { model: 'Qwen2-1.5B-Instruct', kind: 'language', elapsedSeconds: 1.5, createdAt: '2026-11-08T01:18:00Z' },
      width: 512, height: 512, inferenceSeconds: 2.5, compilerVersion: 'semantic-v1',
      fixedPromptPrefix: 'dongzu', appliedConceptIds: ['subject:菱形'],
      omittedConceptIds: ['palette:红'], promptTokenCount: 68, tokenLimit: 75,
      conceptDispositions: [
        { id: 'subject:菱形', status: 'applied', reason: '主体已采用' },
        { id: 'palette:红', status: 'omitted', reason: '提示词预算不足' },
      ],
      referenceImage: {
        id: 'reference-1', name: '用户参考.png', image: 'data:image/png;base64,AAAA',
        width: 640, height: 480, analysisModel: 'local-vision-test', sha256: 'a'.repeat(64),
      },
      semanticPlan: {
        version: 1, extraPrompt: '', concepts: [{
          id: 'subject:菱形', dimension: 'subject', label: '菱形', promptText: 'diamond',
          priority: 3, enabled: true, patternIds: ['DX001'], sourceIds: [], evidence: 'visual',
        }, {
          id: 'palette:红', dimension: 'palette', label: '红', promptText: 'red',
          priority: 2, enabled: true, parentId: 'subject:菱形',
          patternIds: ['DX001'], sourceIds: [], evidence: 'visual',
        }],
      },
      generatedImage: 'data:image/png;base64,AAAA',
    },
  }
  latest.result.semanticPlan.context = { goal: 'heritage', algorithm: 'context-walk-v1', brief: '保留菱形', focusConceptIds: ['subject:菱形'], excludedConceptIds: ['palette:白'] }
  latest.result.semanticPlan.concepts[0].annotations = [{ patternId: 'DX001', field: 'main_elements', value: '菱形', sourceIds: [], evidence: 'visual' }]
  latest.result.semanticPlan.concepts[0].recommendation = { algorithm: 'context-walk-v1', goal: 'heritage', nodes: ['pattern:DX001', 'subject:菱形'], relations: [['main_elements']], sourceIds: [], factors: ['保留母纹特征'] }
  latest.reviews = [{ candidateIndex: 0, conceptId: 'subject:菱形', status: 'met' }, { candidateIndex: 1, conceptId: 'subject:菱形', status: 'missed' }]
  latest.result.planChecks = [{ code: 'test-check', severity: 'info', conceptIds: ['subject:菱形'], message: 'Test fixture only' }]
  latest.result.candidates[0].structureMetrics = [{ kind: 'mirror_lr', label: 'Test fixture metric', score: 0.75, conceptIds: [], reliable: true, note: 'Synthetic test fixture only' }]
  await page.evaluate(record => creationHistory.saveCreation(record), latest)
  records = await page.evaluate(() => creationHistory.listCreations())
  assert.equal(records.length, 12)
  assert.equal(records[0].note, latest.note)
  assert.equal(records[0].selectedIndex, 1)
  assert.deepEqual(records[0].result.appliedConceptIds, ['subject:菱形'])
  assert.deepEqual(records[0].result.omittedConceptIds, ['palette:红'])
  assert.equal(records[0].result.semanticPlan.concepts[1].parentId, 'subject:菱形')
  assert.deepEqual(records[0].result.referenceImage, latest.result.referenceImage)
  assert.deepEqual(records[0].result.conceptDispositions, latest.result.conceptDispositions)
  assert.equal(records[0].result.loraScale, 0.65)
  assert.equal(records[0].result.generationProfile, 'subject-fidelity')
  assert.deepEqual(records[0].result.generationPolicy, latest.result.generationPolicy)
  assert.deepEqual(records[0].result.assistance, latest.result.assistance)
  assert.deepEqual(records[0].reviews, latest.reviews)
  assert.deepEqual(records[0].result.semanticPlan, latest.result.semanticPlan)
  assert.deepEqual(records[0].result.planChecks, latest.result.planChecks)
  assert.deepEqual(records[0].result.candidates[0].structureMetrics, latest.result.candidates[0].structureMetrics)
  const manifest = await page.evaluate(record => creationHistory.creationManifest(record), latest)
  assert.equal(manifest.selectedCandidate.seed, 1)
  assert.deepEqual(manifest.reviews, latest.reviews)
  assert.deepEqual(manifest.conditions.planChecks, latest.result.planChecks)
  assert.deepEqual(manifest.candidates[0].structureMetrics, latest.result.candidates[0].structureMetrics)
  assert.equal(manifest.runtime.seed, 0)
  assert.equal(manifest.runtime.compilerVersion, 'semantic-v1')
  assert.equal(manifest.conditions.semanticPlan.concepts[0].promptText, 'diamond')
  assert.equal(manifest.conditions.semanticPlan.concepts[1].parentId, 'subject:菱形')
  assert.deepEqual(manifest.conditions.conceptDispositions, latest.result.conceptDispositions)
  assert.deepEqual(manifest.reference.uploadedImage, {
    id: 'reference-1', name: '用户参考.png', width: 640, height: 480, analysisModel: 'local-vision-test', sha256: 'a'.repeat(64),
  })
  assert.equal(manifest.prompt, 'dongzu, diamond border')
  assert.equal(manifest.fixedPromptPrefix, 'dongzu')
  assert.deepEqual(manifest.conditions.appliedConceptIds, ['subject:菱形'])
  assert.deepEqual(manifest.conditions.omittedConceptIds, ['palette:红'])
  assert.equal(manifest.runtime.promptTokenCount, 68)
  assert.equal(manifest.runtime.tokenLimit, 75)
  assert.equal(manifest.runtime.loraScale, 0.65)
  assert.equal(manifest.runtime.generationProfile, 'subject-fidelity')
  assert.deepEqual(manifest.runtime.generationPolicy, latest.result.generationPolicy)
  assert.deepEqual(manifest.assistance, latest.result.assistance)
  assert.equal(manifest.reference.image, '/patterns/DX001.webp')
  assert.equal(manifest.parentId, 'run-18')
  const manifestWithRequestParent = await page.evaluate(record => creationHistory.creationManifest(record), { ...latest, parentId: undefined })
  assert.equal(manifestWithRequestParent.parentId, 'run-18')
  assert.equal(JSON.stringify(manifest).includes('base64'), false)

  const draft = {
    version: 1, patternId: 'DX001', plan: latest.result.semanticPlan,
    referenceImage: latest.result.referenceImage,
    loraScale: 0,
    assistance: latest.result.assistance,
    element: {
      id: 'element-1', pattern_id: 'DX001', image: 'data:image/png;base64,BBBB',
      name: '菱形裁片', type: '主体', position: '中央', use: '创作', crop_box: [0, 0, 100, 100],
    },
    carrier: '海报', seed: '0', brief: '保留红色菱形', parentId: 'run-18', resultId: 'run-19',
    updatedAt: '2026-11-08T02:00:00Z',
  }
  await page.evaluate(value => creationHistory.saveDraft(value), draft)
  assert.deepEqual(await page.evaluate(() => creationHistory.loadDraft()), draft)
  await page.reload()
  assert.deepEqual(await page.evaluate(() => creationHistory.loadDraft()), draft, 'Draft must survive a page reload')

  const newerDraft = { ...draft, seed: '42', brief: '最新修改', generationProfile: 'subject-fidelity', updatedAt: '2026-11-08T02:00:02Z' }
  const olderDraft = { ...draft, seed: '1', brief: '延迟到达的旧修改', updatedAt: '2026-11-08T02:00:01Z' }
  await page.evaluate(async values => {
    await creationHistory.saveDraft(values.newer)
    await creationHistory.saveDraft(values.older)
  }, { newer: newerDraft, older: olderDraft })
  assert.deepEqual(await page.evaluate(() => creationHistory.loadDraft()), newerDraft, 'A delayed old save must not overwrite a newer draft')
  const newestDraft = { ...newerDraft, brief: '并发保存后的最新修改', updatedAt: '2026-11-08T02:00:03Z' }
  await page.evaluate(values => Promise.all(values.map(value => creationHistory.saveDraft(value))), [newestDraft, olderDraft, draft])
  assert.deepEqual(await page.evaluate(() => creationHistory.loadDraft()), newestDraft)

  const invalidProfileError = await page.evaluate(async value => {
    try { await creationHistory.saveDraft(value); return null } catch (error) { return error.message }
  }, { ...newestDraft, generationProfile: 'invalid-profile' })
  assert.ok(invalidProfileError, 'Unknown profiles must reject without overwriting the previous draft')
  assert.deepEqual(await page.evaluate(() => creationHistory.loadDraft()), newestDraft)

  const invalidDraftError = await page.evaluate(async value => {
    try { await creationHistory.saveDraft(value); return null } catch (error) { return error.message }
  }, { ...draft, plan: { version: 9 } })
  assert.ok(invalidDraftError, 'Invalid drafts must reject rather than overwrite the previous draft')
  assert.deepEqual(await page.evaluate(() => creationHistory.loadDraft()), newestDraft)

  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('xiuwen-creations-v1', 2)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('creations', 'readwrite')
      transaction.objectStore('creations').put({
        result: { id: 'corrupted' }, createdAtTimestamp: Date.now(),
      })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }))
  records = await page.evaluate(() => creationHistory.listCreations())
  assert.equal(records.length, 12)
  assert.equal(records.some(record => record.result.id === 'corrupted'), false)
  await page.evaluate(record => creationHistory.saveCreation(record), latest)
  records = await page.evaluate(() => creationHistory.listCreations())
  assert.equal(records.length, 12)

  const invalidRecord = { ...latest, result: { ...latest.result, semanticPlan: { version: 9 } } }
  const invalidError = await page.evaluate(async record => {
    try { await creationHistory.saveCreation(record); return null } catch (error) { return error.message }
  }, invalidRecord)
  assert.match(invalidError, /格式不完整/)
  const failedSave = await page.evaluate(async record => {
    const originalPut = IDBObjectStore.prototype.put
    const originalClose = IDBDatabase.prototype.close
    let closed = 0
    IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota failure', 'QuotaExceededError') }
    IDBDatabase.prototype.close = function () { closed += 1; originalClose.call(this) }
    try {
      await creationHistory.saveCreation(record)
      return { error: '', closed }
    } catch (error) {
      return { error: error.message, closed }
    } finally {
      IDBObjectStore.prototype.put = originalPut
      IDBDatabase.prototype.close = originalClose
    }
  }, latest)
  assert.match(failedSave.error, /保存失败/)
  assert.equal(failedSave.closed, 1)

  const draftPageErrors = []
  page.on('pageerror', error => draftPageErrors.push(error.message))
  const failedDraftSave = await page.evaluate(async value => {
    const originalPut = IDBObjectStore.prototype.put
    const originalClose = IDBDatabase.prototype.close
    let closed = 0
    IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota failure', 'QuotaExceededError') }
    IDBDatabase.prototype.close = function () { closed += 1; originalClose.call(this) }
    try {
      await creationHistory.saveDraft(value)
      return { error: '', closed }
    } catch (error) {
      return { error: error.message, closed }
    } finally {
      IDBObjectStore.prototype.put = originalPut
      IDBDatabase.prototype.close = originalClose
    }
  }, { ...newestDraft, updatedAt: '2026-11-08T02:00:04Z' })
  assert.match(failedDraftSave.error, /保存失败/)
  assert.equal(failedDraftSave.closed, 1)
  assert.deepEqual(draftPageErrors, [], 'A failed draft write must be handled without uncaught browser exceptions')
  assert.deepEqual(await page.evaluate(() => creationHistory.loadDraft()), newestDraft, 'A failed save must preserve the previous draft')
  console.log('Creation history passed: v1 migration, legacy records and standard profile default, concurrent pruning, parent relationships, reference images, dispositions, profile/policy metadata export, drafts and reload, stale-save protection, invalid data, failed-save cleanup.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
