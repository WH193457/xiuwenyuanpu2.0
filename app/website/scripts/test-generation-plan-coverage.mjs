import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = new URL('../../', import.meta.url)
const output = new URL('../test-results/generation-plan-coverage.json', import.meta.url)
const api = process.env.XIUWEN_LORA_API ?? 'http://127.0.0.1:8001/api/lora'
const data = await readFile(new URL('纹样库/侗族/_标注成果/03_标注数据/patterns.json', root))
const patterns = JSON.parse(data.toString('utf8').replace(/^\uFEFF/u, ''))
assert.equal(patterns.length, 80)
assert.equal(new Set(patterns.map(pattern => pattern.id)).size, 80)
const sources = ['website/src/knowledge.ts', 'prompt_plan.py', 'generation_policy.py', 'lora_service.py']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(new URL(path, root)))])))
const bundle = await build({ entryPoints: [fileURLToPath(new URL('website/src/knowledge.ts', root))],
  bundle: true, write: false, format: 'esm', platform: 'node' })
const { createInitialPlan, contextFor, isConceptActive } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

function conflictCandidates(prompt, negative) {
  // Default canvases contain positive dictionary phrases and an empty supplement.
  // These lexical checks locate direct conflicts, without claiming image fidelity.
  const positive = prompt.toLowerCase()
  const terms = negative.toLowerCase().split(',').map(term => term.trim()).filter(Boolean)
  const exact = terms.filter(term => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u').test(positive))
  const conflicts = exact.map(term => ({ kind: 'literal', positive: term, negative: term }))
  const border = positive.match(/\b(?:borders?|edging)\b/u)?.[0]
  if (border && terms.includes('ornamental border')) conflicts.push({ kind: 'border', positive: border, negative: 'ornamental border' })
  const repeat = positive.match(/\b(?:repeats?|repeating|repeated|tiled|tiling|seamless|all.over|bands?|rows?|arrays?|tessellation)\b/u)?.[0]
  if (repeat) for (const term of ['tiled', 'repeating pattern']) {
    if (terms.includes(term)) conflicts.push({ kind: 'repeat', positive: repeat, negative: term })
  }
  return conflicts
}

const cases = []
const startedAt = new Date().toISOString()
for (const pattern of patterns) {
  const initial = createInitialPlan(pattern)
  const plan = { ...initial, context: contextFor(initial) }
  assert.equal(plan.extraPrompt, '', 'Coverage must never request automatic supplemental translation')
  const subjects = plan.concepts.filter(concept => concept.dimension === 'subject')
  const response = await fetch(`${api}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pattern_id: pattern.id, semantic_plan: plan, generation_profile: 'subject-fidelity', lora_scale: 0.35 }),
    signal: AbortSignal.timeout(15_000) })
  const body = await response.json()
  const row = { patternId: pattern.id, patternName: pattern.name, status: response.status,
    conceptCount: plan.concepts.length, activeCount: plan.concepts.filter(concept => isConceptActive(plan, concept)).length,
    subjects: subjects.map(concept => ({ id: concept.id, label: concept.label, promptText: concept.promptText,
      active: isConceptActive(plan, concept), applied: body.applied_concept_ids?.includes(concept.id) ?? false })),
    ...(response.ok ? { compilerVersion: body.compiler_version, generationProfile: body.generation_profile,
      prompt: body.prompt, negativePrompt: body.negative_prompt, promptTokenCount: body.prompt_token_count,
      tokenLimit: body.token_limit, omitted: body.concept_dispositions.filter(item => item.status === 'omitted'),
      warnings: body.warnings, negativePolicy: body.generation_policy,
      lexicalConflictCandidates: conflictCandidates(body.prompt, body.negative_prompt) } : { error: body.error ?? body }),
  }
  cases.push(row)
}

const successful = cases.filter(row => row.status === 200)
const sourceHashesAfter = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(new URL(path, root)))])))
const summary = {
  total: cases.length, success: successful.length, failed: cases.length - successful.length,
  conceptRange: [Math.min(...cases.map(row => row.conceptCount)), Math.max(...cases.map(row => row.conceptCount))],
  promptTokenRange: [Math.min(...successful.map(row => row.promptTokenCount)), Math.max(...successful.map(row => row.promptTokenCount))],
  missingEnglishSubjects: cases.flatMap(row => row.subjects.filter(subject => !subject.promptText.trim()).map(subject => ({ patternId: row.patternId, ...subject }))),
  omittedActiveSubjects: successful.flatMap(row => row.subjects.filter(subject => subject.active && !subject.applied).map(subject => ({ patternId: row.patternId, ...subject }))),
  casesWithOmissions: successful.filter(row => row.omitted.length).map(row => ({ patternId: row.patternId, omitted: row.omitted })),
  casesWithLexicalConflictCandidates: successful.filter(row => row.lexicalConflictCandidates.length).map(row => ({ patternId: row.patternId, conflicts: row.lexicalConflictCandidates })),
  overBudget: successful.filter(row => row.promptTokenCount > row.tokenLimit).map(row => row.patternId),
  sourceUnchanged: sources.every(path => sourceHashes[path] === sourceHashesAfter[path]),
}
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true })
await writeFile(output, JSON.stringify({ type: 'real-local-preview-default-canvas-coverage', startedAt, completedAt: new Date().toISOString(),
  endpoint: `${api}/preview`, generationProfile: 'subject-fidelity', dataSha256: hash(data), sourceHashes, sourceHashesAfter,
  scope: 'All 80 canonical default canvases through createInitialPlan/contextFor and the real CPU preview endpoint. No generation, composition, refinement or image-quality evaluation.',
  summary, cases }, null, 2))
console.log(JSON.stringify({ output: fileURLToPath(output), ...summary }, null, 2))
assert.equal(summary.failed, 0, 'Every canonical default canvas should compile')
assert.equal(summary.missingEnglishSubjects.length, 0, 'Default subjects must have English conditions')
assert.equal(summary.omittedActiveSubjects.length, 0, 'Default active subjects should fit the budget')
assert.equal(summary.casesWithLexicalConflictCandidates.length, 0, 'Inspect positive/negative conflict candidates')
assert.equal(summary.overBudget.length, 0)
assert.equal(summary.sourceUnchanged, true, 'Do not alter frozen business sources during coverage')
