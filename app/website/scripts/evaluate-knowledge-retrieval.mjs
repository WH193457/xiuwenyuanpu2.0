import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = new URL('../../', import.meta.url)
const outputLocation = process.argv[2] ?? 'outputs/reproduction-2026-11-09/knowledge-retrieval/'
const output = new URL(outputLocation.replace(/\\/gu, '/').replace(/\/?$/u, '/'), root)
const data = await readFile(new URL('纹样库/侗族/_标注成果/03_标注数据/patterns.json', root))
const patterns = JSON.parse(data.toString('utf8').replace(/^\uFEFF/u, ''))
const source = await readFile(new URL('website/src/knowledge.ts', root))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const bundle = await build({ entryPoints: [fileURLToPath(new URL('website/src/knowledge.ts', root))],
  bundle: true, write: false, format: 'esm', platform: 'node' })
const { buildKnowledgeGraph, createInitialPlan, recommendConcepts, contextFor } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const methods = ['frequency', 'restart-v1', 'context-walk-v1', 'context-walk-v2']
const protocol = {
  createdAt: new Date().toISOString(), dataSha256: digest(data), codeSha256: digest(source),
  scope: 'Leave-one-field-out annotation retrieval on all 80 in-domain records. This evaluates graph retrieval, not cultural truth or user preference.',
  fields: ['composition', 'symmetry_repeat'], methods,
  masking: 'Blank the target field of one pattern before building its graph and initial canvas. Keep other patterns. Never seed the hidden label. Cases where the same label survives another field are excluded and explicitly counted.',
  context: 'heritage goal, empty brief and query, no feedback',
  candidates: 'All unselected graph concepts across all dimensions, without filtering to the known target dimension.',
  frequency: 'Rank by number of distinct annotated patterns, with deterministic ID tie breaking.',
  metrics: ['hit@3', 'hit@5', 'mean reciprocal rank'],
  missingVocabulary: 'An absent target receives zero, is retained in the denominator, and is counted separately.',
}
await mkdir(output, { recursive: true })
await writeFile(new URL('protocol.json', output), JSON.stringify(protocol, null, 2), { flag: 'wx' })
const cases = []
for (const pattern of patterns) {
  for (const field of protocol.fields) {
    const target = `composition:${pattern[field]}`
    const masked = { ...pattern, [field]: '' }
    const graph = buildKnowledgeGraph(patterns.map(item => item.id === pattern.id ? masked : item))
    const plan = createInitialPlan(masked)
    const selected = new Set(plan.concepts.map(item => item.id))
    const row = { patternId: pattern.id, field, target, targetInVocabulary: graph.concepts.has(target), rankings: {} }
    if (selected.has(target) || graph.adjacency.get(`pattern:${pattern.id}`).some(edge => edge.to === target)) {
      row.excludedReason = 'The hidden label also occurs in another retained field.'
      cases.push(row)
      continue
    }
    assert.ok(!plan.concepts.some(item => item.id === target))
    for (const method of methods) {
      const started = performance.now()
      let identifiers
      if (method === 'frequency') {
        identifiers = [...graph.concepts.values()].filter(item => !selected.has(item.id))
          .sort((a, b) => b.patternIds.length - a.patternIds.length || a.id.localeCompare(b.id, 'en'))
          .map(item => item.id)
      } else {
        const contextual = { ...plan, context: { ...contextFor(plan), algorithm: method, goal: 'heritage' } }
        identifiers = recommendConcepts(graph, pattern.id, contextual, '', graph.conceptCount).map(item => item.concept.id)
      }
      const index = identifiers.indexOf(target)
      row.rankings[method] = { rank: index < 0 ? null : index + 1, top5: identifiers.slice(0, 5), elapsedMs: performance.now() - started }
    }
    cases.push(row)
  }
}
const included = cases.filter(item => !item.excludedReason)
const metrics = Object.fromEntries(methods.map(method => {
  const ranks = included.map(item => item.rankings[method].rank)
  return [method, { count: ranks.length, hitAt3: ranks.filter(rank => rank && rank <= 3).length / ranks.length,
    hitAt5: ranks.filter(rank => rank && rank <= 5).length / ranks.length,
    meanReciprocalRank: ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length }]
}))
const report = { protocol, plannedCases: cases.length, evaluatedCases: included.length,
  excludedCases: cases.length - included.length, outOfVocabulary: included.filter(item => !item.targetInVocabulary).length,
  metrics, cases, interpretation: 'Descriptive retrieval results on the existing annotated corpus. The methods and weights were developed with this corpus. These measurements do not establish external generalization.' }
assert.equal(digest(await readFile(new URL('纹样库/侗族/_标注成果/03_标注数据/patterns.json', root))), protocol.dataSha256)
await writeFile(new URL('results.json', output), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ plannedCases: cases.length, evaluatedCases: included.length, metrics }, null, 2))
