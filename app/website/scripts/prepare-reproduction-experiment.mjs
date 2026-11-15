import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const websiteRoot = fileURLToPath(new URL('../', import.meta.url))
const argumentsList = process.argv.slice(2)
const checkOnly = argumentsList.includes('--check')
const amendmentIndex = argumentsList.indexOf('--amendment-from')
const amendmentPath = amendmentIndex >= 0 ? argumentsList[amendmentIndex + 1] : undefined
if (amendmentIndex >= 0 && (!amendmentPath || amendmentPath.startsWith('--'))) throw new Error('--amendment-from requires an existing manifest path')
const positional = argumentsList.filter((value, index) => value !== '--check'
  && (amendmentIndex < 0 || (index !== amendmentIndex && index !== amendmentIndex + 1)))
const destination = resolve(projectRoot, positional[0] ?? 'outputs/reproduction-2026-11-09')
const manifestPath = resolve(destination, 'manifest.json')
const hash = value => createHash('sha256').update(value).digest('hex')
const bundle = await build({
  stdin: { contents: "export * from './src/knowledge'", resolveDir: websiteRoot, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { buildKnowledgeGraph, recommendConcepts, contextFor } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const dataPath = resolve(projectRoot, '纹样库/侗族/_标注成果/03_标注数据/patterns.json')
const rawData = await readFile(dataPath)
const patterns = JSON.parse(rawData.toString('utf8').replace(/^\uFEFF/u, ''))
const graph = buildKnowledgeGraph(patterns)
assert.equal(graph.patternCount, 80)

// These tasks and choices are fixed before model outputs are generated. They
// cover recognizable motifs and different layouts, rather than a random sample.
const specifications = [
  { id: 'T01', patternId: 'DX027', title: '红蓝蝴蝶', subjectId: 'subject:蝴蝶',
    palette: ['palette:红', 'palette:蓝'], compositionId: 'composition:中心式',
    relationId: 'composition:左右对称', goal: 'heritage', seed: 110101,
    target: 'A centered red and blue butterfly with bilateral symmetry, Dong embroidery pattern with crisp embroidery stitches.' },
  { id: 'T02', patternId: 'DX025', title: '黑白凤鸟', subjectId: 'subject:凤鸟',
    palette: ['palette:黑', 'palette:白'], compositionId: 'composition:中心式',
    relationId: 'composition:左右对称', goal: 'heritage', seed: 220201,
    target: 'A centered black and white phoenix bird with bilateral symmetry, Dong embroidery pattern with crisp embroidery stitches.' },
  { id: 'T03', patternId: 'DX023', title: '粉红团花', subjectId: 'subject:团花',
    palette: ['palette:粉', 'palette:红'], compositionId: 'composition:中心式',
    relationId: 'composition:旋转对称', goal: 'balanced', seed: 330301,
    target: 'A centered pink and red floral medallion with rotational symmetry, Dong embroidery pattern with crisp embroidery stitches.' },
  { id: 'T04', patternId: 'DX013', title: '蓝白八角星', subjectId: 'subject:八角星',
    palette: ['palette:蓝', 'palette:白'], compositionId: 'composition:放射式',
    relationId: 'composition:多轴对称', goal: 'heritage', seed: 440401,
    target: 'A blue and white eight-pointed star in a radial composition with multiple axes of symmetry, Dong embroidery pattern with crisp embroidery stitches.' },
  { id: 'T05', patternId: 'DX044', title: '黑白折线边带', subjectId: 'subject:折线',
    palette: ['palette:黑', 'palette:白'], compositionId: 'composition:带状连续',
    relationId: 'composition:平移重复', goal: 'repeat', seed: 550501,
    target: 'Black and white zigzag lines in a horizontal repeating band, Dong embroidery pattern with crisp embroidery stitches.' },
  { id: 'T06', patternId: 'DX052', title: '红黄盘龙', subjectId: 'subject:盘龙',
    palette: ['palette:红', 'palette:黄'], compositionId: 'composition:单体式',
    relationId: 'composition:非严格对称', goal: 'minimal', seed: 660601,
    target: 'An isolated single red and yellow coiled dragon with loose asymmetry, Dong embroidery pattern with crisp embroidery stitches.' },
  { id: 'T07', patternId: 'DX064', title: '黑白抽象鱼形', subjectId: 'subject:鱼形抽象纹',
    palette: ['palette:黑', 'palette:白'], compositionId: 'composition:中心式',
    relationId: 'composition:多轴对称', goal: 'heritage', seed: 770701,
    target: 'A centered black and white abstract fish motif with multiple axes of symmetry, Dong embroidery pattern with crisp embroidery stitches.' },
  { id: 'T08', patternId: 'DX017', title: '黑米白连臂人形', subjectId: 'subject:人形',
    secondaryId: 'subject:连臂动作', palette: ['palette:黑', 'palette:米白'],
    compositionId: 'composition:带状连续', relationId: 'composition:平移重复', goal: 'repeat', seed: 880801,
    target: 'Black and ivory human figure silhouettes joining arms in a horizontal repeating band, Dong embroidery pattern with crisp embroidery stitches.' },
]
const recommendationPolicy = {
  algorithm: 'context-walk-v2', query: '', rankLimit: graph.conceptCount, maximumAdopted: 2,
  allowedIds: ['style:几何化', 'style:简洁', 'style:简洁几何', 'style:简约', 'style:高对比', 'technique:细线'],
  maximumPerDimension: 1,
  priority: 1,
  description: 'Take the highest-ranked available item per allowed style/technique dimension, up to two total. Keep exact graph text and provenance. No output-dependent selection.',
}

function userConcept(id, dimension, label, promptText, priority = 2) {
  return { id, dimension, label, promptText, priority, enabled: true, patternIds: [], sourceIds: [], evidence: 'user' }
}

function sourceConcept(id, patternId) {
  const concept = structuredClone(graph.concepts.get(id))
  assert.ok(concept?.promptText, `Missing translated graph concept ${id}`)
  assert.ok(concept.patternIds.includes(patternId), `${id} is not annotated for ${patternId}`)
  return { ...concept, enabled: true }
}

const tasks = []
for (const specification of specifications) {
  const pattern = patterns.find(item => item.id === specification.patternId)
  assert.ok(pattern)
  const subject = sourceConcept(specification.subjectId, pattern.id)
  subject.priority = 3
  const concepts = [subject]
  if (specification.secondaryId) {
    concepts.push({ ...sourceConcept(specification.secondaryId, pattern.id), parentId: subject.id })
  }
  for (const id of specification.palette) {
    concepts.push({ ...sourceConcept(id, pattern.id), parentId: subject.id })
  }
  concepts.push(sourceConcept(specification.compositionId, pattern.id))
  if (specification.relationId !== specification.compositionId) concepts.push(sourceConcept(specification.relationId, pattern.id))
  concepts.push(userConcept('task:embroidery', 'technique', '侗绣与清晰针脚', 'Dong embroidery pattern, crisp embroidery stitches'))
  const taskPlan = { version: 1, concepts, extraPrompt: '' }
  taskPlan.context = { ...contextFor(taskPlan), algorithm: recommendationPolicy.algorithm, goal: specification.goal }
  const recommendations = recommendConcepts(graph, pattern.id, taskPlan, '', recommendationPolicy.rankLimit)
  const usedDimensions = new Set()
  const adopted = []
  for (const row of recommendations) {
    const concept = row.concept
    if (!recommendationPolicy.allowedIds.includes(concept.id) || usedDimensions.has(concept.dimension)) continue
    adopted.push({ ...structuredClone(concept), priority: recommendationPolicy.priority, enabled: true })
    usedDimensions.add(concept.dimension)
    if (adopted.length === recommendationPolicy.maximumAdopted) break
  }
  const knowledgePlan = { ...taskPlan, concepts: [...taskPlan.concepts, ...adopted] }
  const directPlan = { version: 1, concepts: [userConcept('task:direct', 'subject', specification.title, specification.target, 3)], extraPrompt: '' }
  const referencePath = resolve(projectRoot, '纹样库/侗族/_标注成果', pattern.image)
  const paletteLabels = specification.palette.map(id => graph.concepts.get(id).label).join('、')
  const secondaryText = specification.secondaryId ? `，包含${graph.concepts.get(specification.secondaryId).label}` : ''
  const evaluationTargetChinese = `以${paletteLabels}表现${subject.label}${secondaryText}。采用${graph.concepts.get(specification.compositionId).label}，满足${graph.concepts.get(specification.relationId).label}。呈现侗绣纹样与清晰针脚。`
  tasks.push({
    ...specification, evaluationTargetEnglish: specification.target, evaluationTargetChinese,
    reference: { pattern, relativeImagePath: pattern.image, imageSha256: hash(await readFile(referencePath)) },
    seeds: [specification.seed, specification.seed + 1, specification.seed + 2],
    directPlan, taskPlan, knowledgePlan,
    recommendations: recommendations.map((row, index) => ({ rank: index + 1, ...row })),
    adoptedConceptIds: adopted.map(concept => concept.id),
  })
}

const sourceFiles = ['website/src/knowledge.ts', 'website/src/domain.ts', 'prompt_plan.py', 'semantic_checks.py', 'local_language.py', 'lora_service.py',
  'structure_metrics.py', 'website/scripts/prepare-reproduction-experiment.mjs', 'scripts/run-reproduction-experiment.py']
const sourceHashes = {}
for (const file of sourceFiles) sourceHashes[file] = hash(await readFile(resolve(projectRoot, file)))
const methods = [
  { id: 'A', name: 'direct-task', planKey: 'directPlan', compose: false },
  { id: 'B', name: 'direct-task-local-llm', planKey: 'directPlan', compose: true },
  { id: 'C', name: 'knowledge-canvas', planKey: 'knowledgePlan', compose: false },
  { id: 'D', name: 'knowledge-canvas-local-llm', planKey: 'knowledgePlan', compose: true },
]
const manifest = {
  schemaVersion: 1, experimentId: 'prompttcp-local-paired-2026-11-09', createdAt: new Date().toISOString(),
  studyType: 'predeclared-automated-paired-ablation', expectedCompiler: 'dong-semantic-plan-5',
  scope: 'Local Dong embroidery adaptation of the disclosed PromptTCP framework. Model replacements and graph choices are explicit.',
  sampling: 'Eight purposively selected recognizable motifs and layouts. These are in-domain annotated references, not a held-out generalization dataset.',
  parameters: { count: 3, steps: 30, guidance: 7.2, width: 512, height: 512, lora_scale: 0.35 },
  seedPolicy: 'The same three consecutive predeclared seeds are used for all four methods within each task.',
  selectionPolicy: 'Keep every generated image, including poor outputs. Never select a best seed. Record failures and retries.',
  workflowFailurePolicy: 'With --continue-on-error, record every failed preparation or generation, then process remaining jobs. A failed composition never falls back to a baseline prompt. The planned denominator remains all 96 images.',
  recommendationPolicy, methods, tasks,
  jobs: tasks.flatMap((task, taskIndex) => methods.map((_, offset) => {
    const method = methods[(taskIndex + offset) % methods.length]
    return { id: `${task.id}-${method.id}`, taskId: task.id, methodId: method.id }
  })),
  evaluation: {
    primaryAutomaticMetric: 'Normalized CLIP image-text cosine against the same fixed evaluationTargetEnglish for all four methods in each task. This score is not a probability.',
    scoringModel: { id: 'openai/clip-vit-base-patch32', revision: '3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268' },
    primaryComparison: 'D-A', exploratoryComparisons: ['D-C', 'B-A', 'C-A'],
    aggregation: 'Average the three seeds per task, then average across eight tasks. Bootstrap entire paired tasks, never individual images, for descriptive 95% confidence intervals.',
    bootstrap: { unit: 'paired task', resamples: 10000, seed: 20261109, interval: 'percentile 95%' },
    secondaryMetrics: ['technical success rate', 'request and inference latency', 'CLIP token count and omitted conditions', 'task-applicable all-image mirror and tile-edge pixel references', 'target specificity'],
    targetSpecificity: 'For each image, subtract its highest cosine among the seven other fixed task targets from its cosine with the intended target. Also report top-1 retrieval of the intended target among these eight task texts.',
    missingData: 'Retain all planned jobs and all failure statuses. Never impute missing scores. Report the scored denominator and exclude an incomplete task only from a paired contrast requiring its missing images.',
    interpretation: 'Automatic similarity and pixel measures are proxies. Cultural accuracy, aesthetic quality and interaction workload require real independent ratings.',
    humanRatings: 'Not collected by this script. Scripted graph choices and automatic outputs must not be labeled user or expert observations.',
  },
  provenance: { patternsSha256: hash(rawData), graph: { patterns: graph.patternCount, concepts: graph.conceptCount, relations: graph.edgeCount },
    sourceHashes, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(),
    gitStatus: execFileSync('git', ['status', '--short'], { cwd: projectRoot, encoding: 'utf8' }).trim() },
}
if (amendmentPath) {
  const previousPath = resolve(projectRoot, amendmentPath)
  const previousBytes = await readFile(previousPath)
  const previous = JSON.parse(previousBytes.toString('utf8'))
  assert.deepEqual(manifest.parameters, previous.parameters, 'An amendment must preserve the fixed generation parameters')
  assert.deepEqual(manifest.tasks.map(task => [task.id, task.patternId, task.seeds, task.evaluationTargetEnglish]),
    previous.tasks.map(task => [task.id, task.patternId, task.seeds, task.evaluationTargetEnglish]), 'An amendment must preserve tasks, seeds and evaluation targets')
  manifest.experimentId += '-revision2'
  manifest.amendment = {
    previousManifestPath: previousPath, previousManifestSha256: hash(previousBytes),
    reason: 'The first frozen run failed at T01-D before any image generation. Rewriting an already-English atomic style condition introduced other groups\' subject and color words, which strict scope validation rejected.',
    compositionPolicy: 'Preserve a single already-English non-subject atomic condition verbatim with origin=preserved. Use the same local Qwen model for subject, multi-concept and translation-needed groups, conditioned on the full canvas, with origin=model. This preprocessing decision is made before inference and never substitutes a baseline after a failed model call.',
    retainedEvidence: 'The first manifest, source snapshot, request attempts and failure diagnostic remain in the original experiment directory.',
    unchanged: ['eight tasks', 'four methods', 'three paired seeds', 'generation parameters', 'evaluation targets', 'CLIP scoring revision', 'paired task bootstrap protocol'],
  }
}
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
if (!checkOnly) {
  await mkdir(dirname(manifestPath), { recursive: true })
  // Exclusive creation makes a frozen protocol impossible to overwrite by rerun.
  await writeFile(manifestPath, bytes, { flag: 'wx' })
  await writeFile(resolve(destination, 'manifest.sha256'), `${hash(bytes)}  manifest.json\n`, { flag: 'wx' })
  for (const file of sourceFiles) {
    const source = await readFile(resolve(projectRoot, file))
    assert.equal(hash(source), sourceHashes[file], `Source changed while freezing ${file}`)
    const snapshotPath = resolve(destination, 'source-snapshot', file)
    await mkdir(dirname(snapshotPath), { recursive: true })
    await writeFile(snapshotPath, source, { flag: 'wx' })
  }
  await writeFile(resolve(destination, 'source-snapshot', 'patterns.json'), rawData, { flag: 'wx' })
}
console.log(JSON.stringify({ checkOnly, manifestPath, sha256: hash(bytes), tasks: tasks.length, methods: methods.length,
  images: tasks.length * methods.length * manifest.parameters.count, adopted: tasks.map(task => ({ task: task.id, ids: task.adoptedConceptIds })) }, null, 2))
