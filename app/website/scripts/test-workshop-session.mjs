import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/workshopSession.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
})
const { resolveWorkshopSelection, readWorkshopSession, saveWorkshopSession, appearanceSearchParams, WORKSHOP_SESSION_KEY } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)
const patterns = JSON.parse(await readFile(new URL('../public/data/patterns.json', import.meta.url), 'utf8'))
const previous = {
  patternId: 'DX060', patternName: '旧创作', textureUrl: 'data:image/png;base64,AAAA',
  carrier: 'tee', source: 'create', createdAt: '2026-11-08T07:00:00.000Z',
}
const select = query => resolveWorkshopSelection(patterns, new URLSearchParams(query), previous)
assert.equal(select('pattern=DX008').pattern.id, 'DX008')
assert.equal(select('pattern=DX008').source, 'library')
assert.equal(select('pattern=DX008').carrier, 'mug')
assert.equal(select('pattern=DX060&carrier=poster').carrier, 'poster')
assert.equal(select('pattern=DX060').textureUrl, previous.textureUrl)
assert.equal(select('pattern=DX060&source=library').textureUrl, patterns.find(item => item.id === 'DX060').image)
assert.equal(select('pattern=DX060&source=library').source, 'library')
assert.equal(select('pattern=DX060&carrier=invalid').carrier, 'mug')
assert.equal(select('').pattern.id, 'DX060')
assert.equal(select('').carrier, 'tee')
assert.equal(select('pattern=missing').pattern.id, patterns[0].id)
assert.equal(select('pattern=missing').source, 'library')
assert.equal(resolveWorkshopSelection(patterns, new URLSearchParams('pattern=missing'), { ...previous, patternId: patterns[0].id }).source, 'library')
assert.equal(resolveWorkshopSelection([], new URLSearchParams()).pattern, undefined)

const appearance = {
  scale: 1.3, offsetX: 0.12, offsetY: -0.25, rotation: 35,
  repeat: true, removeBackground: true, color: 'indigo', detailColor: 'auto',
}
const styledSession = { ...previous, carrier: 'cushion', appearance }
const styledSelection = query => resolveWorkshopSelection(patterns, new URLSearchParams(query), styledSession)
assert.deepEqual(styledSelection('pattern=DX060&carrier=cushion').appearance, appearance)
assert.equal(styledSelection('pattern=DX060&carrier=cushion&source=library').appearance.scale, 1)
assert.equal(styledSelection('pattern=DX060&carrier=cushion&source=library&printScale=1.4').appearance.scale, 1.4)
assert.equal(styledSelection('pattern=DX060&carrier=tee').appearance.scale, 1)
assert.equal(styledSelection('pattern=DX008&carrier=cushion').appearance.scale, 1)
const appearanceQuery = appearanceSearchParams(appearance)
appearanceQuery.set('pattern', 'DX008')
appearanceQuery.set('carrier', 'vase')
assert.deepEqual(select(appearanceQuery).appearance, appearance)
assert.equal(styledSelection('pattern=DX060&carrier=cushion&printRepeat=false').appearance.repeat, false)
assert.equal(styledSelection('pattern=DX060&carrier=cushion&printRemoveBackground=false').appearance.removeBackground, false)
const invalidAppearance = styledSelection('pattern=DX060&carrier=cushion&printScale=Infinity&printX=&printY=wrong&printRotation=999&productColor=invalid')
assert.equal(invalidAppearance.appearance.scale, 1)
assert.equal(invalidAppearance.appearance.offsetX, 0)
assert.equal(invalidAppearance.appearance.offsetY, 0)
assert.equal(invalidAppearance.appearance.rotation, 0)
assert.equal(invalidAppearance.appearance.color, 'ivory')
assert.equal(invalidAppearance.appearance.removeBackground, true)
const customAppearance = { ...appearance, color: '#6b8c7a', detailColor: '#dbb67d' }
const customQuery = appearanceSearchParams(customAppearance)
assert.deepEqual(select(customQuery).appearance, customAppearance)
assert.equal(customQuery.get('productColor'), '#6b8c7a')
assert.equal(customQuery.get('productDetailColor'), '#dbb67d')
const uppercaseQuery = new URLSearchParams({ productColor: '#AABBCC', productDetailColor: '#DDEEFF' })
assert.equal(select(uppercaseQuery).appearance.color, '#aabbcc')
assert.equal(select(uppercaseQuery).appearance.detailColor, '#ddeeff')
for (const invalid of ['#abc', '#gggggg', '#12345678', 'red', 'url(https://example.com/image)', '']) {
  const damaged = new URLSearchParams({ productColor: invalid, productDetailColor: invalid, printScale: '1.3' })
  assert.equal(select(damaged).appearance.color, 'ivory')
  assert.equal(select(damaged).appearance.detailColor, 'auto')
  assert.equal(select(damaged).appearance.scale, 1.3)
}
for (const carrier of ['mug', 'tote', 'tee', 'poster', 'cushion', 'scarf', 'notebook', 'vase', 'tumbler', 'coaster', 'bookmark', 'fan', 'phonecase', 'pouch']) {
  assert.equal(select(`pattern=DX008&carrier=${carrier}`).carrier, carrier)
}

const values = new Map()
globalThis.sessionStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
}
assert.equal(readWorkshopSession(), undefined)
saveWorkshopSession(previous)
assert.deepEqual(readWorkshopSession(), previous)
saveWorkshopSession(styledSession)
assert.deepEqual(readWorkshopSession(), styledSession)
for (const carrier of ['tumbler', 'coaster', 'bookmark', 'fan', 'phonecase', 'pouch']) {
  const productSession = { ...styledSession, carrier, appearance: customAppearance }
  saveWorkshopSession(productSession)
  assert.deepEqual(readWorkshopSession(), productSession)
  const query = appearanceSearchParams(customAppearance)
  query.set('carrier', carrier)
  query.set('pattern', productSession.patternId)
  const selected = resolveWorkshopSelection(patterns, query, readWorkshopSession())
  assert.equal(selected.carrier, carrier)
  assert.equal(selected.textureUrl, previous.textureUrl)
  assert.deepEqual(selected.appearance, customAppearance)
}
const legacyAppearance = { ...appearance }
delete legacyAppearance.detailColor
values.set(WORKSHOP_SESSION_KEY, JSON.stringify({ ...styledSession, appearance: legacyAppearance }))
assert.deepEqual(readWorkshopSession().appearance, appearance)
assert.equal(appearanceSearchParams(legacyAppearance).get('productDetailColor'), 'auto')
saveWorkshopSession({ ...styledSession, appearance: customAppearance })
assert.deepEqual(readWorkshopSession().appearance, customAppearance)
values.set(WORKSHOP_SESSION_KEY, JSON.stringify({ ...styledSession, appearance: { ...customAppearance, detailColor: 'broken' } }))
assert.equal(readWorkshopSession().appearance.color, customAppearance.color)
assert.equal(readWorkshopSession().appearance.scale, customAppearance.scale)
assert.equal(readWorkshopSession().appearance.detailColor, 'auto')
values.set(WORKSHOP_SESSION_KEY, JSON.stringify({ ...styledSession, appearance: { scale: 'broken' } }))
assert.equal(readWorkshopSession().textureUrl, previous.textureUrl)
assert.equal(readWorkshopSession().appearance, undefined)
values.set(WORKSHOP_SESSION_KEY, JSON.stringify({ ...previous, carrier: 'invalid' }))
assert.equal(readWorkshopSession().carrier, 'mug')
assert.equal(readWorkshopSession().source, 'create')
for (const raw of ['{invalid', 'null', JSON.stringify({ ...previous, textureUrl: '' }), JSON.stringify({ ...previous, createdAt: 'invalid' })]) {
  values.set(WORKSHOP_SESSION_KEY, raw)
  assert.equal(readWorkshopSession(), undefined)
}
assert.throws(() => saveWorkshopSession({ ...previous, textureUrl: 'javascript:alert(1)' }), /贴图记录不完整/)
globalThis.sessionStorage = {
  getItem: () => { throw new Error('blocked') },
  setItem: () => { throw new Error('quota') },
}
assert.equal(readWorkshopSession(), undefined)
assert.throws(() => saveWorkshopSession(previous), /浏览器未能保存/)
console.log('Workshop session checks passed — URL precedence, source identity, legacy records, invalid values and storage failures.')
