import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/knowledge.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
})
const { buildKnowledgeGraph, createInitialPlan, recommendConcepts, canAssignParent, isConceptActive, DIMENSIONS } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)
const dataUrl = new URL('../../纹样库/侗族/_标注成果/03_标注数据/patterns.json', import.meta.url)
const patterns = JSON.parse((await readFile(dataUrl, 'utf8')).replace(/^\uFEFF/u, ''))
const graph = buildKnowledgeGraph(patterns)
const initial = createInitialPlan(patterns[0])
assert.equal(graph.patternCount, 80)
assert.equal(DIMENSIONS.length, 6)
assert.ok(graph.conceptCount > 100)
assert.equal(graph.edgeCount * 2, [...graph.adjacency.values()].reduce((sum, edges) => sum + edges.length, 0))
assert.equal(buildKnowledgeGraph([...patterns, patterns[0]]).edgeCount, graph.edgeCount)
assert.equal(initial.version, 1)
assert.ok(initial.concepts.some(item => item.dimension === 'subject' && item.promptText))
assert.ok(initial.concepts.some(item => item.dimension === 'intention' && !item.enabled && !item.promptText))
assert.equal(new Set(initial.concepts.map(item => item.id)).size, initial.concepts.length)

const original = JSON.stringify(patterns)
for (const pattern of patterns) {
  const plan = createInitialPlan(pattern)
  const results = recommendConcepts(graph, pattern.id, plan, '', 8)
  assert.ok(results.length > 0)
  assert.deepEqual(results, recommendConcepts(graph, pattern.id, plan, '', 8))
  assert.ok(results.every(item => !plan.concepts.some(selected => selected.id === item.concept.id)))
  assert.ok(results.every(item => item.score > 0 && Number.isFinite(item.score)))
  for (const result of results) {
    assert.ok(result.concept.patternIds.every(id => patterns.some(record => record.id === id)))
    const sources = new Set(patterns.filter(record => result.concept.patternIds.includes(record.id)).flatMap(record => record.source_ids))
    assert.ok(result.concept.sourceIds.every(id => sources.has(id)))
  }
}
assert.equal(JSON.stringify(patterns), original, 'Graph construction and recommendations must preserve source data')

const searched = recommendConcepts(graph, patterns[0].id, initial, '蝴蝶', 12)
assert.ok(searched.slice(0, 3).some(item => item.concept.label.includes('蝴蝶')), 'Query should focus graph recommendations')
assert.notDeepEqual(searched, recommendConcepts(graph, patterns[0].id, initial, '', 12))
const changedPriorities = {
  ...initial,
  concepts: initial.concepts.map(concept => ({ ...concept, priority: concept.dimension === 'palette' ? 3 : 1 })),
}
assert.notDeepEqual(
  recommendConcepts(graph, patterns[0].id, changedPriorities, '', 12),
  recommendConcepts(graph, patterns[0].id, initial, '', 12),
  'Selected priorities should influence the recommendation context',
)
assert.deepEqual(recommendConcepts(buildKnowledgeGraph([]), 'missing', initial, ''), [])
assert.deepEqual(recommendConcepts(graph, 'missing', { version: 1, concepts: [], extraPrompt: '' }, ''), [])
assert.deepEqual(recommendConcepts(graph, patterns[0].id, initial, '', 0), [])
assert.deepEqual(recommendConcepts(graph, patterns[0].id, initial, 'xyznotfound', 8), [], 'Unknown queries must not silently show default results')
const phraseResults = recommendConcepts(graph, patterns[0].id, initial, 'banyan tree', 12)
assert.ok(phraseResults.some(item => item.concept.label === '榕树' && item.reason.includes('匹配“banyan tree”')), 'English phrase matches must be explained')

const customPlan = structuredClone(initial)
customPlan.concepts.push({ id: 'user:butterfly', dimension: 'subject', label: '蝴蝶', promptText: 'butterfly',
  priority: 3, enabled: true, evidence: 'user', patternIds: [], sourceIds: [] })
assert.notDeepEqual(recommendConcepts(graph, patterns[0].id, customPlan, '', 12),
  recommendConcepts(graph, patterns[0].id, initial, '', 12), 'Custom concept descriptions must affect graph context')
const editedPlan = structuredClone(initial)
editedPlan.concepts[0].promptText = 'butterfly'
editedPlan.concepts[0].evidence = 'user'
assert.notDeepEqual(recommendConcepts(graph, patterns[0].id, editedPlan, '', 12),
  recommendConcepts(graph, patterns[0].id, initial, '', 12), 'Edited descriptions must affect graph context')

const hierarchy = structuredClone(customPlan)
const subject = hierarchy.concepts.find(item => item.dimension === 'subject' && item.id !== 'user:butterfly')
const child = hierarchy.concepts.find(item => item.dimension === 'palette')
child.parentId = subject.id
assert.equal(canAssignParent(hierarchy, child.id, subject.id), true)
assert.equal(canAssignParent(hierarchy, subject.id, subject.id), false)
assert.equal(canAssignParent(hierarchy, subject.id, child.id), false, 'Only subjects can own conditions')
assert.equal(isConceptActive(hierarchy, child), true)
subject.enabled = false
assert.equal(isConceptActive(hierarchy, child), false, 'A disabled subject also disables its conditions')
assert.equal(canAssignParent(hierarchy, child.id, subject.id), false)
subject.enabled = true
subject.parentId = 'user:butterfly'
assert.equal(canAssignParent(hierarchy, 'user:butterfly', subject.id), false, 'Cycles must be excluded')
const butterfly = hierarchy.concepts.find(item => item.id === 'user:butterfly')
butterfly.parentId = subject.id
assert.equal(isConceptActive(hierarchy, subject), false, 'Corrupt cycles cannot activate concepts')

const catalogue = JSON.parse(await readFile(new URL('../src/data/sources.json', import.meta.url), 'utf8'))
const workbook = await readFile(new URL('../../' + catalogue.workbook, import.meta.url))
assert.equal(catalogue.workbookSha256, createHash('sha256').update(workbook).digest('hex'))
assert.equal(catalogue.sources.length, 7)
assert.equal(new Set(catalogue.sources.map(source => source.id)).size, 7)
assert.ok(patterns.every(pattern => pattern.source_ids.every(id => catalogue.sources.some(source => source.id === id))))
assert.ok(catalogue.sources.every(source => source.title && source.author && /^https?:\/\//u.test(source.url)))

const future = { ...patterns[0], id: 'DX999', main_elements: ['待核实新形态'], meaning: '[资料支持／谨慎表述] 尚待实物核查。' }
const futurePlan = createInitialPlan(future)
assert.equal(futurePlan.concepts.find(item => item.label === '待核实新形态').promptText, '')
assert.equal(futurePlan.concepts.find(item => item.dimension === 'intention').evidence, 'cautious')
assert.ok(futurePlan.concepts.filter(item => item.evidence === 'user').every(item => !item.patternIds.length && !item.sourceIds.length))

const firstRecommendation = searched[0]
const graphLabel = graph.concepts.get(firstRecommendation.concept.id).label
firstRecommendation.concept.label = 'changed by editor'
firstRecommendation.concept.patternIds.push('DX999')
assert.equal(graph.concepts.get(firstRecommendation.concept.id).label, graphLabel)
assert.ok(!graph.concepts.get(firstRecommendation.concept.id).patternIds.includes('DX999'))

console.log(`Knowledge graph checks passed — ${graph.patternCount} patterns, ${graph.conceptCount} concepts, ${graph.edgeCount} edges.`)
