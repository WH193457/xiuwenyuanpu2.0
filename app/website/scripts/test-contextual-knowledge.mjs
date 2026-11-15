import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const bundle = await build({ stdin: { contents: "export * from './src/knowledge'; export * from './src/iterationFeedback'; export { SemanticPlanSchema } from './src/domain'",
  resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' })
const { buildKnowledgeGraph, createInitialPlan, recommendConcepts, contextFor, feedbackPlan, SemanticPlanSchema, CREATIVE_GOALS } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const raw = await readFile(new URL('../../纹样库/侗族/_标注成果/03_标注数据/patterns.json', import.meta.url), 'utf8')
const patterns = JSON.parse(raw.replace(/^\uFEFF/u, ''))
const graph = buildKnowledgeGraph(patterns)
const plan = createInitialPlan(patterns[0])
const withContext = (value, updates) => ({ ...value, context: { ...contextFor(value), ...updates } })
const ranks = rows => rows.map(row => [row.concept.id, row.score])

for (const concept of graph.concepts.values()) {
  assert.ok(concept.annotations.length)
  for (const row of concept.annotations) {
    const source = patterns.find(pattern => pattern.id === row.patternId)
    assert.ok(source)
    assert.deepEqual(row.sourceIds, source.source_ids)
    if (row.field !== 'meaning') assert.ok(Array.isArray(source[row.field]) ? source[row.field].includes(row.value) : source[row.field] === row.value)
  }
}
const comparisons = []
for (const pattern of patterns.filter(item => ['DX001', 'DX017', 'DX060', 'DX080'].includes(item.id))) {
  const basePlan = createInitialPlan(pattern)
  const cases = []
  for (const goal of CREATIVE_GOALS) {
    const start = performance.now()
    const nextPlan = withContext(basePlan, { goal: goal.id })
    const rows = recommendConcepts(graph, pattern.id, nextPlan, '', 12)
    const elapsedMs = performance.now() - start
    assert.deepEqual(rows, recommendConcepts(graph, pattern.id, nextPlan, '', 12))
    for (const row of rows) {
      assert.ok(row.score > 0 && row.score <= 1)
      assert.equal(row.trace.algorithm, 'context-walk-v2')
      assert.ok(row.trace.factors.includes('均匀长度1至6，累计访问分数'))
      assert.ok(row.trace.nodes.length > 0 && row.trace.nodes.length <= 7)
      assert.equal(row.trace.nodes.at(-1), row.concept.id)
      for (let index = 0; index < row.trace.nodes.length - 1; index++) {
        const edge = graph.adjacency.get(row.trace.nodes[index]).find(edge => edge.to === row.trace.nodes[index + 1])
        assert.ok(edge, 'Every displayed path edge must exist in the graph')
        assert.deepEqual(row.trace.relations[index], edge.relations)
      }
      SemanticPlanSchema.parse({ ...nextPlan, concepts: [...nextPlan.concepts, row.concept] })
    }
    cases.push({ goal: goal.id, elapsedMs, recommendations: rows })
  }
  assert.notDeepEqual(ranks(cases[0].recommendations), ranks(cases[2].recommendations), 'Goal must change actual scores')
  const baseline = recommendConcepts(graph, pattern.id, withContext(basePlan, { algorithm: 'restart-v1' }), '', 12)
  assert.deepEqual(ranks(baseline), ranks(recommendConcepts(graph, pattern.id, withContext(basePlan, { algorithm: 'restart-v1', goal: 'repeat', brief: '蝴蝶' }), '', 12)), 'Baseline must ignore new intent modifiers')
  const legacyPlan = withContext(basePlan, { algorithm: 'context-walk-v1' })
  const legacy = recommendConcepts(graph, pattern.id, legacyPlan, '', 12)
  assert.notDeepEqual(ranks(legacy), ranks(cases[0].recommendations), 'Cumulative visits must differ from the legacy endpoint average')
  for (const row of legacy) {
    assert.equal(row.trace.algorithm, 'context-walk-v1')
    assert.ok(row.trace.factors.includes('长度1至6的终点概率均值（v1）'))
    SemanticPlanSchema.parse({ ...legacyPlan, concepts: [...legacyPlan.concepts, row.concept] })
  }
  comparisons.push({ patternId: pattern.id, baseline, legacy, cases })
}
const plain = recommendConcepts(graph, patterns[0].id, plan, '', 12)
const intention = recommendConcepts(graph, patterns[0].id, withContext(plan, { brief: '蝴蝶' }), '', 12)
assert.notDeepEqual(ranks(plain), ranks(intention))
assert.ok(intention.slice(0, 3).some(row => row.concept.label.includes('蝴蝶')))
assert.deepEqual(ranks(plain), ranks(recommendConcepts(graph, patterns[0].id, withContext(plan, { brief: '不要蝴蝶' }), '', 12)), 'Negation must not promote the rejected subject')
const excluded = withContext(plan, { excludedConceptIds: [plain[0].concept.id] })
assert.ok(recommendConcepts(graph, patterns[0].id, excluded, '', 12).every(row => row.concept.id !== plain[0].concept.id))
assert.equal(recommendConcepts(graph, patterns[0].id, withContext(plan, { excludedConceptIds: [] }), '', 12)[0].concept.id, plain[0].concept.id)

const original = structuredClone(plan)
const focusId = plan.concepts.find(item => item.enabled && item.priority !== 3).id
const next = feedbackPlan(plan, [{ candidateIndex: 0, conceptId: focusId, status: 'missed' },
  { candidateIndex: 1, conceptId: focusId, status: 'met' }], 0)
assert.deepEqual(plan, original, 'Feedback must not change the saved source round')
assert.equal(next.concepts.find(item => item.id === focusId).priority, 3)
assert.deepEqual(next.context.focusConceptIds, [focusId])
assert.deepEqual(feedbackPlan(plan, [{ candidateIndex: 1, conceptId: focusId, status: 'missed' }], 0).context.focusConceptIds, [])
assert.notDeepEqual(ranks(recommendConcepts(graph, patterns[0].id, next, '', 12)), ranks(plain))
const disabled = { ...next, concepts: next.concepts.map(item => item.id === focusId ? { ...item, enabled: false } : item) }
assert.deepEqual(ranks(recommendConcepts(graph, patterns[0].id, disabled, '', 12)),
  ranks(recommendConcepts(graph, patterns[0].id, withContext(disabled, { focusConceptIds: [] }), '', 12)),
  'Disabled feedback conditions must not keep biasing the graph')
const sourceAnnotation = structuredClone(plain[0].concept.annotations)
plain[0].concept.annotations[0].value = 'changed by editor'
assert.deepEqual(graph.concepts.get(plain[0].concept.id).annotations, sourceAnnotation, 'Recommendation metadata must be detached from graph state')

const report = { type: 'algorithm-behavior-check', createdAt: new Date().toISOString(),
  datasetSha256: createHash('sha256').update(raw).digest('hex'),
  graph: { patterns: graph.patternCount, concepts: graph.conceptCount, relations: graph.edgeCount },
  interpretation: 'Measured recommendation behavior and latency only; not a user study or image-quality evaluation.',
  method: { algorithm: 'context-walk-v2', walkLengths: [1, 2, 3, 4, 5, 6],
    lengthDistribution: 'uniform', aggregation: 'cumulative visits normalized by expected length',
    stepWeights: [6, 5, 4, 3, 2, 1].map(value => value / 21),
    baseline: { algorithm: 'restart-v1', steps: 32, restartProbability: 0.2 } },
  comparisons }
await mkdir(new URL('../test-results', import.meta.url), { recursive: true })
await writeFile(new URL('../test-results/contextual-recommendation-comparison.json', import.meta.url), JSON.stringify(report, null, 2))
console.log('Contextual graph passed: 7 relation types, 4 motifs × 4 goals, baseline isolation, source paths, negation, feedback, exclusions, immutable evidence and serialization.')
