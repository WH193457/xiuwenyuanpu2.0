import { splitMeaning, type Pattern } from './domain'

export const DIMENSIONS = [
  { id: 'subject', label: '主体与纹样元' },
  { id: 'composition', label: '构图与关系' },
  { id: 'palette', label: '色彩' },
  { id: 'intention', label: '文化意向' },
  { id: 'style', label: '视觉风格' },
  { id: 'technique', label: '表现技法' },
] as const

export type SemanticDimension = typeof DIMENSIONS[number]['id']
export type ConceptEvidence = 'visual' | 'supported' | 'cautious' | 'neutral' | 'user'

export const RELATION_LABELS = {
  main_elements: '主要元素', secondary_elements: '辅助元素', composition: '构图',
  symmetry_repeat: '对称与重复', colors: '配色', meaning: '文化说明', generation_keywords: '风格与技法标注',
} as const
export type AnnotationField = keyof typeof RELATION_LABELS
export interface ConceptAnnotation {
  patternId: string
  field: AnnotationField
  value: string
  sourceIds: string[]
  evidence: ConceptEvidence
}
export const CREATIVE_GOALS = [
  { id: 'balanced', label: '综合探索', hint: '兼顾主体、结构与色彩' },
  { id: 'heritage', label: '保留母纹特征', hint: '优先主要元素、构图和对称关系' },
  { id: 'minimal', label: '简洁文创', hint: '优先简洁风格和独立构图' },
  { id: 'repeat', label: '连续纹样', hint: '优先重复方式和边饰结构' },
] as const
export interface SemanticContext {
  goal: typeof CREATIVE_GOALS[number]['id']
  algorithm: 'context-walk-v2' | 'context-walk-v1' | 'restart-v1'
  brief: string
  focusConceptIds: string[]
  excludedConceptIds: string[]
}
export interface RecommendationTrace {
  algorithm: SemanticContext['algorithm']
  goal: SemanticContext['goal']
  nodes: string[]
  relations: AnnotationField[][]
  sourceIds: string[]
  factors: string[]
}

export interface SemanticConcept {
  id: string
  dimension: SemanticDimension
  label: string
  promptText: string
  priority: 1 | 2 | 3
  enabled: boolean
  parentId?: string
  patternIds: string[]
  sourceIds: string[]
  evidence: ConceptEvidence
  annotations?: ConceptAnnotation[]
  recommendation?: RecommendationTrace
}

export interface SemanticPlan {
  version: 1
  concepts: SemanticConcept[]
  extraPrompt: string
  extraPromptTranslation?: { sourceText: string; text: string; model: string }
  promptRealization?: {
    version: 1
    sourceFingerprint: string
    model: string
    groups: { rootId: string; conceptIds: string[]; text: string; origin?: 'model' | 'preserved' }[]
  }
  context?: SemanticContext
}

export function contextFor(plan: SemanticPlan): SemanticContext {
  return plan.context ?? { goal: 'balanced', algorithm: 'context-walk-v2', brief: '', focusConceptIds: [], excludedConceptIds: [] }
}

export interface KnowledgeEdge {
  to: string
  weight: number
  relations: AnnotationField[]
  sourceIds: string[]
}

export interface KnowledgeGraph {
  patternCount: number
  conceptCount: number
  edgeCount: number
  patterns: Map<string, Pattern>
  concepts: Map<string, SemanticConcept>
  adjacency: Map<string, KnowledgeEdge[]>
}

export interface ConceptRecommendation {
  concept: SemanticConcept
  score: number
  reason: string
  trace: RecommendationTrace
}

// These are literal visual translations. Cultural interpretations remain in the
// source annotation and require an explicit user-authored generation description.
const VISUAL_TERMS: Record<string, string> = {
  '中心动物花形': 'central animal and flower motif',
  '中心复合花形': 'central composite floral motif',
  '中心放射花': 'central radial flower', '中心花': 'central flower',
  '中心花形': 'central flower shape', '中心面形': 'central face-like shape',
  '人': 'human figure', '人形': 'human figure silhouette', '人物队列': 'row of human figures',
  '八瓣花': 'eight-petalled flower', '八角星': 'eight-pointed star',
  '八角花': 'eight-pointed floral motif', '八边形团花': 'octagonal floral medallion',
  '凤凰': 'phoenix bird', '凤鸟': 'phoenix bird', '动物形': 'animal silhouette',
  '动物花形': 'animal and floral shape', '双人形': 'two human figures',
  '双翼形': 'paired wing shapes', '双龙': 'paired dragons', '团花': 'floral medallion',
  '圆形团纹': 'circular medallion', '多层团花': 'layered floral medallion',
  '多瓣花': 'many-petalled flower', '多瓣花形': 'many-petalled floral shape',
  '太阳': 'sun motif', '太阳花': 'sun-shaped flower', '对鸟': 'paired birds',
  '小龙抽象形': 'small abstract dragon shape', '巢形': 'nest-like shape',
  '折线': 'zigzag lines', '抽象人物形': 'abstract human figures',
  '抽象动物形': 'abstract animal shapes', '抽象花形': 'abstract flower shape',
  '抽象面形': 'abstract face-like shape', '方孔': 'square opening',
  '方形': 'square shape', '方格': 'square grid', '旋卷花形': 'spiral flower shape',
  '月亮花': 'moon-shaped flower', '枝状几何': 'branching geometry',
  '榕树': 'banyan tree', '歌舞队列': 'row of dancing figures',
  '环形花瓣': 'ring of petals', '盘曲躯体': 'coiled body', '盘龙': 'coiled dragon',
  '矩形': 'rectangle', '竹根': 'bamboo root shape', '线框': 'linear frame',
  '花卉': 'flowers', '花形': 'flower shape', '菱形': 'diamond shape', '菱格': 'diamond lattice',
  '蜘蛛': 'spider motif', '蜘蛛抽象形': 'abstract spider shape',
  '蝴蝶': 'butterfly', '蝴蝶抽象形': 'abstract butterfly shape', '螃蟹': 'crab motif',
  '连臂动作': 'figures joining arms', '铜钱花': 'coin-shaped flower', '马': 'horse',
  '鱼形': 'fish shape', '鱼形抽象纹': 'abstract fish motif', '鸟形': 'bird silhouette',
  '龙': 'dragon', '龙凤抽象形': 'abstract dragon and phoenix', '龙形': 'dragon shape',
  '龙形抽象纹': 'abstract dragon motif', '龙首': 'dragon head',
  '三角块': 'triangular blocks', '三角形': 'triangle', '三角放射': 'radial triangles',
  '三角纹': 'triangle motif', '三角边框': 'triangular border', '中心圆': 'central circle',
  '中心菱形': 'central diamond', '中心连接纹': 'central connecting motif',
  '交叉带': 'crossing bands', '八分区': 'eight sectors', '八瓣边框': 'eight-lobed frame',
  '八边形': 'octagon', '六瓣边框': 'six-lobed frame', '六角框': 'hexagonal frame',
  '内嵌小菱形': 'inset small diamonds', '几何折线': 'geometric zigzag lines',
  '几何环': 'geometric ring', '几何翼部': 'geometric wings', '几何躯干': 'geometric body',
  '几何边带': 'geometric border band', '分叉': 'forked branches', '十字形': 'cross shape',
  '卷云': 'curling cloud motif', '卷曲尾部': 'curled tail', '卷曲线': 'curled lines',
  '卷曲花瓣': 'curled petals', '卷曲足部': 'curled legs', '卷曲边缘': 'curled edge',
  '同心圆': 'concentric circles', '同心细环': 'thin concentric rings',
  '四角小菱形': 'small diamonds at four corners', '回折线': 'meandering angular lines',
  '回纹边框': 'meander border', '圆形底': 'circular ground', '圆形边框': 'circular frame',
  '圆形边缘': 'circular edge', '圆点': 'round dots', '圆环': 'circular ring',
  '外圈几何': 'outer geometric ring', '外圈放射线': 'outer radial lines',
  '多行排列': 'multiple rows', '小花': 'small flowers', '小花瓣': 'small petals',
  '小菱形': 'small diamonds', '尾部折线': 'zigzag tail', '彩色小方块': 'colored small squares',
  '彩色折线': 'colored zigzag lines', '放射枝叶': 'radial branches and leaves',
  '放射瓣': 'radial petals', '放射线': 'radial lines', '斜向边带': 'diagonal border band',
  '方形边框': 'square frame', '曲线': 'curved lines', '枝叶': 'branches and leaves',
  '横向边带': 'horizontal border band', '横向队列': 'horizontal row',
  '波浪线': 'wavy lines', '涡旋线': 'spiral lines', '短线边框': 'short-line border',
  '箭形花瓣': 'arrow-shaped petals', '线性肢体': 'linear limbs', '线性边饰': 'linear border',
  '细线边饰': 'fine-line border', '羽状线': 'feather-like lines', '花叶': 'flowers and leaves',
  '花枝': 'flowering branches', '花瓣': 'petals', '花瓣外缘': 'petal outlines',
  '菱形边带': 'diamond border band', '蟹足': 'crab legs', '触角': 'antennae',
  '边框': 'border', '锯齿环': 'zigzag ring', '锯齿线': 'zigzag line',
  '锯齿边饰': 'zigzag border', '鳞纹': 'scale pattern', '黑色三角': 'black triangles',
  '中心式': 'centered composition', '分区式': 'segmented composition',
  '单体式': 'isolated single motif', '同心圆式': 'concentric circular composition',
  '左右对称': 'bilateral symmetry', '带状连续': 'horizontal repeating band',
  '放射式': 'radial composition', '旋转式': 'rotational composition',
  '满铺式': 'all-over repeating pattern', '多轴对称': 'multiple axes of symmetry',
  '平移与镜像重复': 'translated and mirrored repeats', '平移重复': 'translation repeats',
  '旋转对称': 'rotational symmetry', '近似旋转对称': 'approximate rotational symmetry',
  '镜像重复': 'mirrored repeats', '非严格对称': 'loose asymmetry',
  '橙': 'orange', '浅粉': 'pale pink', '浅蓝': 'light blue', '深蓝': 'dark blue',
  '玫红': 'magenta', '白': 'white', '米白': 'ivory', '米黄': 'cream yellow',
  '粉': 'pink', '紫': 'purple', '红': 'red', '绿': 'green', '蓝': 'blue',
  '蓝绿': 'teal', '褐': 'brown', '金黄': 'golden yellow', '黄': 'yellow', '黑': 'black',
  '几何化': 'geometric stylization', '简洁': 'simple clean design',
  '简洁几何': 'minimal geometric design', '简约': 'minimal design',
  '高对比': 'high contrast', '黑色剪影': 'black silhouette',
  '线描': 'line drawing', '细线': 'fine linework', '织锦效果': 'brocade-like texture',
}

const STYLE_KEYWORDS = new Set(['几何化', '简洁', '简洁几何', '简约', '高对比', '黑色剪影'])
const TECHNIQUE_KEYWORDS = new Set(['线描', '细线', '织锦效果'])

type WeightedConcept = { concept: SemanticConcept; weight: number }

function annotatedConcept(pattern: Pattern, dimension: SemanticDimension, label: string, field: AnnotationField): SemanticConcept {
  const meaning = splitMeaning(pattern.meaning)
  const promptText = dimension === 'intention' ? '' : VISUAL_TERMS[label] ?? ''
  return {
    id: `${dimension}:${label}`,
    dimension,
    label,
    promptText,
    priority: dimension === 'subject' ? 3 : 2,
    enabled: Boolean(promptText),
    patternIds: [pattern.id],
    sourceIds: [...pattern.source_ids],
    evidence: dimension === 'intention' ? meaning.level as 'supported' | 'cautious' | 'neutral' : 'visual',
    annotations: [{ patternId: pattern.id, field, value: label, sourceIds: [...pattern.source_ids],
      evidence: dimension === 'intention' ? meaning.level as ConceptEvidence : 'visual' }],
  }
}

function patternConcepts(pattern: Pattern): WeightedConcept[] {
  const items: WeightedConcept[] = []
  const add = (dimension: SemanticDimension, label: string, weight: number, field: AnnotationField) => {
    if (label.trim()) items.push({ concept: annotatedConcept(pattern, dimension, label, field), weight })
  }
  pattern.main_elements.forEach(label => add('subject', label, 3, 'main_elements'))
  pattern.secondary_elements.forEach(label => add('subject', label, 1, 'secondary_elements'))
  add('composition', pattern.composition, 2, 'composition')
  add('composition', pattern.symmetry_repeat, 1.8, 'symmetry_repeat')
  pattern.colors.forEach(label => add('palette', label, 1, 'colors'))
  add('intention', splitMeaning(pattern.meaning).content, 0.6, 'meaning')
  pattern.generation_keywords.forEach(label => {
    if (STYLE_KEYWORDS.has(label)) add('style', label, 1, 'generation_keywords')
    if (TECHNIQUE_KEYWORDS.has(label)) add('technique', label, 1, 'generation_keywords')
  })
  return items
}

export function createInitialPlan(pattern: Pattern): SemanticPlan {
  const initialIds = new Set([
    ...pattern.main_elements.slice(0, 3).map(label => `subject:${label}`),
    `composition:${pattern.composition}`,
    `composition:${pattern.symmetry_repeat}`,
    ...pattern.colors.slice(0, 4).map(label => `palette:${label}`),
    `intention:${splitMeaning(pattern.meaning).content}`,
  ])
  const concepts = new Map<string, SemanticConcept>()
  for (const { concept } of patternConcepts(pattern)) {
    if (initialIds.has(concept.id) || concept.dimension === 'style' || concept.dimension === 'technique') {
      concepts.set(concept.id, concept)
    }
  }
  const defaults: SemanticConcept[] = [
    {
      id: 'user:dong-style', dimension: 'style', label: '侗绣风格',
      promptText: 'Dong embroidery pattern', priority: 2, enabled: true,
      patternIds: [], sourceIds: [], evidence: 'user',
    },
    {
      id: 'user:stitches', dimension: 'technique', label: '清晰针脚',
      promptText: 'crisp embroidery stitches', priority: 1, enabled: true,
      patternIds: [], sourceIds: [], evidence: 'user',
    },
  ]
  return { version: 1, concepts: [...concepts.values(), ...defaults], extraPrompt: '' }
}

export function buildKnowledgeGraph(patterns: Pattern[]): KnowledgeGraph {
  const graph: KnowledgeGraph = {
    patternCount: 0, conceptCount: 0, edgeCount: 0,
    patterns: new Map(), concepts: new Map(), adjacency: new Map(),
  }
  for (const pattern of patterns) {
    if (graph.patterns.has(pattern.id)) continue
    graph.patterns.set(pattern.id, pattern)
    const nodeId = `pattern:${pattern.id}`
    const connections = new Map<string, KnowledgeEdge>()
    for (const { concept, weight } of patternConcepts(pattern)) {
      const existing = graph.concepts.get(concept.id)
      if (existing) {
        existing.patternIds = [...new Set([...existing.patternIds, ...concept.patternIds])].sort()
        existing.sourceIds = [...new Set([...existing.sourceIds, ...concept.sourceIds])].sort()
        existing.annotations = [...(existing.annotations ?? []), ...(concept.annotations ?? [])]
        // Equal wording can carry different evidence labels across records.
        // Keep the least assertive source label when aggregating those records.
        if (concept.evidence === 'neutral' || existing.evidence === 'neutral') existing.evidence = 'neutral'
        else if (concept.evidence === 'cautious') existing.evidence = 'cautious'
      } else {
        graph.concepts.set(concept.id, concept)
        graph.adjacency.set(concept.id, [])
      }
      const oldEdge = connections.get(concept.id)
      connections.set(concept.id, { to: concept.id, weight: Math.max(oldEdge?.weight ?? 0, weight),
        relations: [...new Set([...(oldEdge?.relations ?? []), ...concept.annotations!.map(item => item.field)])],
        sourceIds: [...pattern.source_ids] })
    }
    graph.adjacency.set(nodeId, [...connections.values()])
    for (const [id, edge] of connections) {
      graph.adjacency.get(id)!.push({ ...edge, to: nodeId })
      graph.edgeCount += 1
    }
  }
  graph.patternCount = graph.patterns.size
  graph.conceptCount = graph.concepts.size
  return graph
}

function queryMatches(query: string, text: string): boolean {
  if (!query || !text) return false
  const haystack = text.normalize('NFKC').toLocaleLowerCase()
  const tokens = query.normalize('NFKC').toLocaleLowerCase().split(/[,，。；;、]+/u).map(token => token.trim()).filter(Boolean)
  const englishText = ` ${haystack.split(/[^a-z0-9]+/u).filter(Boolean).join(' ')} `
  return tokens.some(token => /^[a-z0-9\s-]+$/u.test(token)
    ? englishText.includes(` ${token.split(/[^a-z0-9]+/u).filter(Boolean).join(' ')} `)
    : haystack.includes(token) || token.includes(haystack))
}

export function canAssignParent(plan: SemanticPlan, conceptId: string, parentId: string): boolean {
  if (!parentId) return true
  const parent = plan.concepts.find(concept => concept.id === parentId)
  if (!parent || !parent.enabled || parent.dimension !== 'subject') return false
  const visited = new Set([conceptId])
  let current: SemanticConcept | undefined = parent
  while (current) {
    if (visited.has(current.id)) return false
    visited.add(current.id)
    current = plan.concepts.find(concept => concept.id === current?.parentId)
  }
  return true
}

export function isConceptActive(plan: SemanticPlan, concept: SemanticConcept): boolean {
  const visited = new Set<string>()
  let current: SemanticConcept | undefined = concept
  while (current) {
    if (!current.enabled || visited.has(current.id)) return false
    visited.add(current.id)
    if (!current.parentId) return true
    current = plan.concepts.find(item => item.id === current?.parentId)
  }
  return false
}

function recommendationReason(graph: KnowledgeGraph, concept: SemanticConcept, patternId: string, contextIds: Set<string>, query: string, queryIds: Set<string>): string {
  const dimension = DIMENSIONS.find(item => item.id === concept.dimension)!.label
  if (queryIds.has(concept.id)) return `匹配“${query}”的${dimension}标注，来源 ${concept.patternIds.slice(0, 3).join('、')}`
  for (const id of queryIds) {
    const matched = graph.concepts.get(id)!
    const sharedId = matched.patternIds.find(pattern => concept.patternIds.includes(pattern))
    if (sharedId) return `与检索命中“${matched.label}”共同标注于 ${sharedId}`
  }
  if (concept.patternIds.includes(patternId)) return `母纹 ${patternId} 的${dimension}标注`
  for (const id of contextIds) {
    const related = graph.concepts.get(id)
    const sharedId = related?.patternIds.find(id => concept.patternIds.includes(id))
    if (sharedId) return `与画布匹配的概念“${related!.label}”共同标注于 ${sharedId}`
  }
  return `来自 ${concept.patternIds.slice(0, 3).join('、')} 的${dimension}标注`
}

const GOAL_RELATION_WEIGHTS: Record<SemanticContext['goal'], Partial<Record<AnnotationField, number>>> = {
  balanced: {},
  heritage: { main_elements: 2, symmetry_repeat: 1.8, composition: 1.5, meaning: 0.5 },
  minimal: { generation_keywords: 2.2, composition: 1.5, secondary_elements: 0.6 },
  repeat: { symmetry_repeat: 2.5, composition: 1.8, secondary_elements: 1.4 },
}
const GOAL_TERMS: Record<SemanticContext['goal'], string[]> = {
  balanced: [], heritage: [], minimal: ['简洁', '简约', '单体式'],
  repeat: ['满铺式', '平移重复', '带状连续', '镜像重复'],
}

/** Positive lexical hints only; a local language proposal can disambiguate intent.
 * Negated segments are excluded instead of interpreting them as desired concepts.
 */
function positiveBrief(value: string) {
  return value.split(/[，,。；;！!\n]/u).filter(part => !/(不要|避免|不使用|去掉|去除|不含|without|\bno\b|\bnot\b)/iu.test(part)).join('，')
}

function traceRecommendation(graph: KnowledgeGraph, target: string, seeds: Map<string, number>, context: SemanticContext, factors: string[]): RecommendationTrace {
  // A shortest verifiable association path, not a claim about all walk contributions.
  const queue = [...seeds].sort((a, b) => b[1] - a[1]).map(([id]) => [id])
  const seen = new Set(queue.map(path => path[0]))
  let nodes: string[] = []
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const path = queue[cursor]
    if (path[path.length - 1] === target) { nodes = path; break }
    if (path.length > 6) continue
    for (const edge of graph.adjacency.get(path[path.length - 1]) ?? []) {
      if (!seen.has(edge.to)) { seen.add(edge.to); queue.push([...path, edge.to]) }
    }
  }
  const edges = nodes.slice(1).map((node, index) => graph.adjacency.get(nodes[index])!.find(edge => edge.to === node)!)
  return { algorithm: context.algorithm, goal: context.goal, nodes,
    relations: edges.map(edge => [...edge.relations]),
    sourceIds: [...new Set([...edges.flatMap(edge => edge.sourceIds), ...(graph.concepts.get(target)?.sourceIds ?? [])])], factors }
}

/** Exact normalized visit counts for L uniformly sampled from 1..maxLength.
 * Every traversed step counts once; the initial seed does not count. A dangling
 * node restarts from the normalized seed distribution on its next step.
 * P(L >= k) / E[L] = (maxLength - k + 1) / sum(1..maxLength).
 * The legacy aggregation averages the endpoint distributions of all lengths.
 */
export function finiteWalkVisitDistribution(
  adjacency: ReadonlyMap<string, readonly { to: string; weight: number }[]>,
  seedWeights: ReadonlyMap<string, number>,
  maxLength = 6,
  aggregation: 'uniform-length-cumulative' | 'mean-step' = 'uniform-length-cumulative',
): Map<string, number> {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new RangeError('Walk length must be a positive safe integer')
  const checkWeight = (weight: number) => {
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError('Walk weights must be finite and nonnegative')
    return weight
  }
  const seedTotal = [...seedWeights.values()].reduce((sum, weight) => sum + checkWeight(weight), 0)
  if (!Number.isFinite(seedTotal)) throw new RangeError('Seed weight sum must be finite')
  if (!seedTotal) return new Map()
  const seeds = new Map([...seedWeights].filter(([, weight]) => weight > 0).map(([id, weight]) => [id, weight / seedTotal]))
  const transitions = new Map<string, { to: string; weight: number }[]>()
  for (const [id, edges] of adjacency) {
    const total = edges.reduce((sum, edge) => sum + checkWeight(edge.weight), 0)
    if (!Number.isFinite(total)) throw new RangeError('Edge weight sum must be finite')
    transitions.set(id, edges.filter(edge => edge.weight > 0).map(edge => ({ to: edge.to, weight: edge.weight / total })))
  }
  const normalizer = aggregation === 'uniform-length-cumulative' ? maxLength * (maxLength + 1) / 2 : maxLength
  const visits = new Map<string, number>()
  let distribution = seeds
  for (let step = 1; step <= maxLength; step += 1) {
    const next = new Map<string, number>()
    let dangling = 0
    for (const [id, probability] of distribution) {
      const edges = transitions.get(id) ?? []
      if (!edges.length) dangling += probability
      for (const edge of edges) next.set(edge.to, (next.get(edge.to) ?? 0) + probability * edge.weight)
    }
    for (const [id, probability] of seeds) next.set(id, (next.get(id) ?? 0) + dangling * probability)
    const stepWeight = (aggregation === 'uniform-length-cumulative' ? maxLength - step + 1 : 1) / normalizer
    for (const [id, probability] of next) visits.set(id, (visits.get(id) ?? 0) + probability * stepWeight)
    distribution = next
  }
  return visits
}

/** The local context-walk-v2 method uses uniform random lengths 1..6 and
 * cumulative visits, evaluated by exact probability flow. Matching weights are
 * disclosed local choices because PromptTCP leaves its matching f unspecified.
 * The v1 endpoint average and 32-step restart remain available for saved plans.
 */
export function recommendConcepts(
  graph: KnowledgeGraph,
  patternId: string,
  plan: SemanticPlan,
  query: string,
  limit = 12,
): ConceptRecommendation[] {
  if (!graph.adjacency.size || limit <= 0) return []
  const context = contextFor(plan)
  const contextual = context.algorithm !== 'restart-v1'
  const brief = positiveBrief(context.brief)
  const goalTerms = contextual ? GOAL_TERMS[context.goal] : []
  const intentIds = new Set<string>()
  const seeds = new Map<string, number>()
  const selectedPriorities = new Map<string, number>()
  const selectedIds = new Set(plan.concepts.map(concept => concept.id))
  const addSeed = (id: string, weight: number) => {
    if (graph.adjacency.has(id)) seeds.set(id, (seeds.get(id) ?? 0) + weight)
  }
  addSeed(`pattern:${patternId}`, 3)
  const contextIds = new Set<string>()
  for (const concept of plan.concepts.filter(item => isConceptActive(plan, item))) {
    const matchedIds = new Set<string>()
    if (graph.concepts.has(concept.id)) matchedIds.add(concept.id)
    for (const related of graph.concepts.values()) {
      if (related.dimension === concept.dimension && (
        queryMatches(concept.label, related.label) || queryMatches(concept.promptText, related.promptText)
        || queryMatches(related.promptText, concept.promptText)
      )) matchedIds.add(related.id)
    }
    for (const id of matchedIds) {
      addSeed(id, concept.priority / Math.sqrt(matchedIds.size))
      if (contextual && context.focusConceptIds.includes(concept.id)) addSeed(id, 5 / Math.sqrt(matchedIds.size))
      selectedPriorities.set(id, Math.max(selectedPriorities.get(id) ?? 0, concept.priority))
      contextIds.add(id)
    }
  }
  const trimmedQuery = query.trim()
  const queryIds = new Set<string>()
  for (const concept of graph.concepts.values()) {
    if (queryMatches(trimmedQuery, concept.label) || queryMatches(trimmedQuery, concept.promptText)) {
      queryIds.add(concept.id)
      addSeed(concept.id, 4)
    }
    if (contextual && (goalTerms.includes(concept.label) || queryMatches(concept.label, brief) || queryMatches(concept.promptText, brief))) {
      intentIds.add(concept.id)
      addSeed(concept.id, 2)
    }
  }
  let matchedPatterns = 0
  for (const pattern of graph.patterns.values()) {
    if (queryMatches(trimmedQuery, `${pattern.id} ${pattern.name} ${pattern.visual_description}`)) {
      addSeed(`pattern:${pattern.id}`, 2)
      matchedPatterns += 1
    }
  }
  if (trimmedQuery && queryIds.size === 0 && matchedPatterns === 0) return []
  if (!seeds.size) return []
  const seedTotal = [...seeds.values()].reduce((sum, value) => sum + value, 0)
  const restart = new Map([...seeds].map(([id, value]) => [id, value / seedTotal]))
  const transitions = new Map<string, KnowledgeEdge[]>()
  for (const [id, edges] of graph.adjacency) {
    const biased = edges.map(edge => ({
      ...edge,
      weight: edge.weight * (1 + 0.25 * (selectedPriorities.get(edge.to) ?? 0)) * (queryIds.has(edge.to) ? 2 : 1)
        * (contextual && edge.relations.length ? Math.max(...edge.relations.map(relation => GOAL_RELATION_WEIGHTS[context.goal][relation] ?? 1)) : 1)
        * (intentIds.has(edge.to) ? 2 : 1)
        * (contextual && graph.concepts.get(edge.to)?.dimension === 'intention'
          && graph.concepts.get(edge.to)?.evidence !== 'supported' ? 0.4 : 1),
    }))
    const total = biased.reduce((sum, edge) => sum + edge.weight, 0)
    transitions.set(id, biased.map(edge => ({ ...edge, weight: edge.weight / total })))
  }
  let distribution = contextual
    ? finiteWalkVisitDistribution(transitions, seeds, 6, context.algorithm === 'context-walk-v2' ? 'uniform-length-cumulative' : 'mean-step')
    : restart
  const restartProbability = 0.2
  for (let step = 0; !contextual && step < 32; step += 1) {
    const next = new Map([...restart].map(([id, value]) => [id, value * restartProbability]))
    let dangling = 0
    for (const [id, probability] of distribution) {
      const edges = transitions.get(id) ?? []
      if (!edges.length) dangling += probability * (1 - restartProbability)
      for (const edge of edges) {
        next.set(edge.to, (next.get(edge.to) ?? 0) + probability * (1 - restartProbability) * edge.weight)
      }
    }
    for (const [id, value] of restart) next.set(id, (next.get(id) ?? 0) + dangling * value)
    distribution = next
  }
  return [...graph.concepts.values()]
    .filter(concept => !selectedIds.has(concept.id) && !context.excludedConceptIds.includes(concept.id) && (distribution.get(concept.id) ?? 0) > 0)
    .map(concept => {
      const factors = contextual ? [CREATIVE_GOALS.find(goal => goal.id === context.goal)!.label] : ['原有关系传播基线']
      if (context.algorithm === 'context-walk-v2') factors.push('均匀长度1至6，累计访问分数')
      if (context.algorithm === 'context-walk-v1') factors.push('长度1至6的终点概率均值（v1）')
      if (intentIds.has(concept.id)) factors.push('匹配创作目标或正向描述')
      if (context.focusConceptIds.length && contextual) factors.push('参考上一轮待改进条件')
      const trace = traceRecommendation(graph, concept.id, seeds, context, factors)
      return {
        concept: { ...structuredClone(concept), recommendation: structuredClone(trace) }, trace,
        score: distribution.get(concept.id) ?? 0,
        reason: recommendationReason(graph, concept, patternId, contextIds, trimmedQuery, queryIds),
      }
    })
    .sort((left, right) => right.score - left.score || left.concept.id.localeCompare(right.concept.id, 'zh-CN'))
    .slice(0, limit)
}
