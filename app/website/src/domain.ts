import { z } from 'zod'
import type { SemanticPlan } from './knowledge'

export const PatternSchema = z.object({
  id: z.string(),
  image: z.string(),
  thumbnail: z.string().optional(),
  original_file: z.string(),
  name: z.string(),
  category: z.string(),
  main_elements: z.array(z.string()),
  secondary_elements: z.array(z.string()),
  composition: z.string(),
  symmetry_repeat: z.string(),
  colors: z.array(z.string()),
  visual_description: z.string(),
  meaning: z.string(),
  source_ids: z.array(z.string()),
  element_ids: z.array(z.string()),
  generation_keywords: z.array(z.string()),
})

export const PatternElementSchema = z.object({
  id: z.string(),
  pattern_id: z.string(),
  image: z.string(),
  name: z.string(),
  type: z.string(),
  position: z.string(),
  use: z.string(),
  crop_box: z.array(z.number()),
})

export type Pattern = z.infer<typeof PatternSchema>
export type PatternElement = z.infer<typeof PatternElementSchema>

const AnnotationFieldSchema = z.enum(['main_elements', 'secondary_elements', 'composition', 'symmetry_repeat', 'colors', 'meaning', 'generation_keywords'])
const EvidenceSchema = z.enum(['visual', 'supported', 'cautious', 'neutral', 'user'])
const GoalSchema = z.enum(['balanced', 'heritage', 'minimal', 'repeat'])
const AlgorithmSchema = z.enum(['context-walk-v2', 'context-walk-v1', 'restart-v1'])
const ConceptIdsSchema = z.array(z.string().min(1).max(256)).max(256)

export const SemanticPlanSchema: z.ZodType<SemanticPlan> = z.object({
  version: z.literal(1),
  concepts: z.array(z.object({
    id: z.string().min(1).max(256),
    dimension: z.enum(['subject', 'composition', 'palette', 'intention', 'style', 'technique']),
    label: z.string().min(1).max(512),
    promptText: z.string().max(2048),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    enabled: z.boolean(),
    parentId: z.string().max(256).optional(),
    patternIds: z.array(z.string().max(256)).max(80),
    sourceIds: z.array(z.string().max(256)).max(256),
    evidence: EvidenceSchema,
    annotations: z.array(z.object({ patternId: z.string().max(256), field: AnnotationFieldSchema,
      value: z.string().max(512), sourceIds: z.array(z.string().max(256)).max(100), evidence: EvidenceSchema })).max(160).optional(),
    recommendation: z.object({ algorithm: AlgorithmSchema, goal: GoalSchema,
      nodes: z.array(z.string().max(256)).max(7), relations: z.array(z.array(AnnotationFieldSchema).max(7)).max(6),
      sourceIds: z.array(z.string().max(256)).max(100), factors: z.array(z.string().max(256)).max(8) }).optional(),
  })).max(48),
  extraPrompt: z.string().max(1000),
  extraPromptTranslation: z.object({ sourceText: z.string().max(1000), text: z.string().min(1).max(1000), model: z.string().min(1).max(256) }).optional(),
  promptRealization: z.object({
    version: z.literal(1), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), model: z.string().min(1).max(256),
    groups: z.array(z.object({ rootId: z.string().min(1).max(256), conceptIds: ConceptIdsSchema,
      text: z.string().min(1).max(512), origin: z.enum(['model', 'preserved']).optional() })).max(49),
  }).optional(),
  context: z.object({ goal: GoalSchema, algorithm: AlgorithmSchema, brief: z.string().max(600),
    focusConceptIds: ConceptIdsSchema, excludedConceptIds: ConceptIdsSchema }).optional(),
})

export const PlanCheckSchema = z.object({ code: z.string(), severity: z.enum(['warning', 'info']),
  conceptIds: z.array(z.string()), message: z.string() })
export type PlanCheck = z.infer<typeof PlanCheckSchema>
export const StructureMetricSchema = z.object({ kind: z.enum(['mirror_lr', 'rotate_180', 'tile_edges']),
  label: z.string(), score: z.number().finite().min(0).max(1), conceptIds: z.array(z.string()),
  reliable: z.boolean(), note: z.string() })
export type StructureMetric = z.infer<typeof StructureMetricSchema>

export const ReferenceImageSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(256),
  image: z.string().max(12 * 1024 * 1024).regex(/^data:image\/(png|jpeg|webp);base64,/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  analysisModel: z.string().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})
export type ReferenceImage = z.infer<typeof ReferenceImageSchema>

const ReferenceColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const ReferenceDataUrlSchema = z.string().max(12 * 1024 * 1024).regex(/^data:image\/png;base64,/)
export const ReferenceSettingsSchema = z.object({
  crop: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]),
  mask_mode: z.enum(['dark', 'light', 'saturated', 'alpha']), threshold: z.number().int().min(0).max(255),
  palette_mode: z.enum(['source', 'solid']), foreground_color: ReferenceColorSchema, background_color: ReferenceColorSchema,
  layout: z.enum(['centered', 'horizontal-band', 'preserve']), margin: z.number().min(0.05).max(0.3),
  width: z.number().int().min(384).max(768).multipleOf(8), height: z.number().int().min(384).max(768).multipleOf(8),
  texture_mode: z.enum(['source', 'stitched']).default('source'),
})
export type ReferenceSettings = z.infer<typeof ReferenceSettingsSchema>
export type ReferencePreparationRequest = ReferenceSettings & (
  { pattern_id: string } | { element_id: string } | { image_data_url: string; image_name: string }
)
export const ReferenceConditioningSchema = z.object({
  reference_id: z.string().regex(/^CTRL-[a-f0-9]{32}$/), reference_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  method: z.enum(['canny-img2img', 'img2img']), strength: z.number().min(0.25).max(0.85),
  control_scale: z.number().min(0).max(2), embroidery_detail: z.boolean(),
})
export type ReferenceConditioning = z.infer<typeof ReferenceConditioningSchema>
export const ReferencePreparationSchema = z.object({
  reference_id: z.string().regex(/^CTRL-[a-f0-9]{32}$/), reference_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.object({ kind: z.enum(['pattern', 'element', 'upload']), id: z.string().optional(), name: z.string(),
    pattern_id: z.string().optional(), width: z.number().int().positive(), height: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  settings: ReferenceSettingsSchema, init_image: ReferenceDataUrlSchema, control_image: ReferenceDataUrlSchema,
  mask_image: ReferenceDataUrlSchema, warnings: z.array(z.string()),
  material: z.object({ version: z.string().min(1), noise_seed: z.number().int().nonnegative() }).optional(),
  uploadedImage: ReferenceImageSchema.optional(), metadata: z.record(z.string(), z.unknown()).optional(),
})
export type ReferencePreparation = z.infer<typeof ReferencePreparationSchema>
export const ReferenceEditorSchema = z.object({
  enabled: z.boolean(), source: z.enum(['pattern', 'element', 'upload']), upload: ReferenceImageSchema.optional(),
  settings: ReferenceSettingsSchema,
  method: z.enum(['canny-img2img', 'img2img']), strength: z.number().min(0.25).max(0.85),
  controlScale: z.number().min(0).max(2), embroideryDetail: z.boolean(),
  preparation: ReferencePreparationSchema.optional(), preparedKey: z.string().max(2048).optional(),
  acceptedKey: z.string().max(4096).optional(), conditioning: ReferenceConditioningSchema.optional(),
})
export type ReferenceEditor = z.infer<typeof ReferenceEditorSchema>

export interface GenerationHealth {
  status: string
  model_state: string
  runtime_available?: boolean
  compiler_version?: string
  message?: string | null
  active_task?: 'generation' | 'language' | 'vision' | null
  queued_tasks?: number
  language?: { available: boolean; model: string; model_state?: string }
  vision?: { available: boolean; model: string; model_state?: string }
  reference_conditioning?: { available: boolean; model?: string; message?: string }
}

export interface AIPlanProposal {
  semanticPlan: SemanticPlan
  model: string
  elapsedSeconds: number
  warnings: string[]
  reference?: { id: string; sha256: string; width: number; height: number }
}

export const AIPlanResponseSchema = z.object({
  semantic_plan: SemanticPlanSchema,
  model: z.string().min(1),
  elapsed_seconds: z.number().finite().nonnegative(),
  warnings: z.array(z.string()).default([]),
  reference: z.object({
    id: z.string().min(1).max(256),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).optional(),
})

export const PlanAssistanceSchema = z.object({
  model: z.string(), kind: z.enum(['language', 'vision', 'composition']), elapsedSeconds: z.number().finite().nonnegative(), createdAt: z.string(),
})
export type PlanAssistance = z.infer<typeof PlanAssistanceSchema>

export const GenerationProfileSchema = z.enum(['standard', 'subject-fidelity'])
export type GenerationProfile = z.infer<typeof GenerationProfileSchema>

export interface ConceptDisposition {
  id: string
  status: 'applied' | 'omitted'
  reason: string
}

export interface PatternRepository {
  list(): Promise<Pattern[]>
  get(id: string): Promise<Pattern | undefined>
  elements(): Promise<PatternElement[]>
  elementsForPattern(id: string): Promise<PatternElement[]>
}

export interface GenerationRequest {
  pattern: Pattern
  element?: PatternElement
  composition: string
  palette: string
  intention: string
  carrier: string
  semanticPlan?: SemanticPlan
  seed?: number
  parentResultId?: string
  referenceImage?: ReferenceImage
  assistance?: PlanAssistance
  loraScale?: number
  generationProfile?: GenerationProfile
  referenceConditioning?: ReferenceConditioning
  referencePreparation?: ReferencePreparation
}

export interface GenerationPreview {
  prompt: string
  negativePrompt: string
  semanticPlan?: SemanticPlan
  warnings: string[]
  compilerVersion: string
  promptTokenCount?: number
  tokenLimit?: number
  fixedPromptPrefix?: string
  appliedConceptIds?: string[]
  omittedConceptIds?: string[]
  conceptDispositions?: ConceptDisposition[]
  planChecks?: PlanCheck[]
  generationProfile?: GenerationProfile
  generationPolicy?: Record<string, unknown>
  referenceConditioning?: ReferenceConditioning
  referencePreparation?: ReferencePreparation
}

export interface GenerationCandidate {
  image: string
  seed: number
  path?: string
  structureMetrics?: StructureMetric[]
  denoisingSteps?: number
}

export interface GenerationResult extends GenerationRequest {
  id: string
  createdAt: string
  /** LoRA 生成图（data URL 或可访问路径） */
  generatedImage?: string
  candidates?: GenerationCandidate[]
  prompt?: string
  negativePrompt?: string
  mode?: 'demo' | 'lora'
  model?: string
  baseModel?: string
  steps?: number
  guidance?: number
  width?: number
  height?: number
  inferenceSeconds?: number
  compilerVersion?: string
  warnings?: string[]
  metadataPath?: string
  fixedPromptPrefix?: string
  appliedConceptIds?: string[]
  omittedConceptIds?: string[]
  promptTokenCount?: number
  tokenLimit?: number
  conceptDispositions?: ConceptDisposition[]
  planChecks?: PlanCheck[]
  generationPolicy?: Record<string, unknown>
  conditioningModel?: { name: string; revision: string } | null
  postprocessing?: string
}

export interface GenerationService {
  health(): Promise<GenerationHealth>
  refine(plan: SemanticPlan, brief: string): Promise<AIPlanProposal>
  compose(plan: SemanticPlan): Promise<AIPlanProposal>
  analyzeReference(image: ReferenceImage): Promise<AIPlanProposal>
  prepareReference(request: ReferencePreparationRequest): Promise<ReferencePreparation>
  preview(request: GenerationRequest): Promise<GenerationPreview>
  generate(request: GenerationRequest): Promise<GenerationResult>
}

export const Sam3HealthSchema = z.object({
  service: z.string(),
  status: z.enum(['ok', 'error']),
  model_state: z.enum(['cold', 'loading', 'ready', 'error']),
  patterns: z.number(),
  local_only: z.boolean(),
  model_load_seconds: z.number().optional(),
  message: z.string().optional(),
})

export const Sam3CandidateSchema = z.object({
  rank: z.number(),
  source: z.enum(['sam3', 'hybrid', 'foreground']),
  score: z.number(),
  fit: z.number(),
  status: z.enum(['pass', 'review']),
  bbox_xyxy: z.array(z.number()).length(4),
  bbox_norm: z.array(z.number()).length(4),
  metrics: z.object({
    model_score: z.number(),
    selection_fit: z.number(),
    bbox_iou_with_prompt: z.number(),
    mask_inside_prompt: z.number(),
    prompt_coverage: z.number(),
    mask_to_prompt_area: z.number(),
    mask_pixels: z.number(),
      foreground_agreement: z.number(),
      foreground_coverage: z.number(),
      background_leakage: z.number(),
    prior_reliability: z.number(),
    source: z.enum(['sam3', 'hybrid', 'foreground']),
    auto_status: z.enum(['pass', 'review']),
  }),
  preview_data_url: z.string(),
  cutout_data_url: z.string(),
  filename: z.string(),
})

export const Sam3ResponseSchema = z.object({
  pattern_id: z.string(),
  image_size: z.array(z.number()).length(2),
  prompt_box: z.array(z.number()).length(4),
  mode: z.enum(['single', 'motif']),
  foreground_prior: z.object({
    prior_reliability: z.number(),
    border_background: z.number(),
    foreground_fraction: z.number(),
  }),
  threshold_used: z.number(),
  inference_seconds: z.number(),
  candidates: Sam3CandidateSchema.array(),
})

export const Sam3SelectionSchema = z.object({
  patternId: z.string(),
  patternName: z.string(),
  candidate: Sam3CandidateSchema,
  createdAt: z.string(),
})

export type Sam3Health = z.infer<typeof Sam3HealthSchema>
export type Sam3Candidate = z.infer<typeof Sam3CandidateSchema>
export type Sam3Response = z.infer<typeof Sam3ResponseSchema>
export type Sam3Selection = z.infer<typeof Sam3SelectionSchema>

export interface SegmentationService {
  health(): Promise<Sam3Health>
  segment(patternId: string, box: number[], mode?: 'single' | 'motif'): Promise<Sam3Response>
}

export interface EvaluationRecord {
  id: string
  workName: string
  scores: number[]
  note: string
  createdAt: string
}

export interface EvaluationRepository {
  list(): Promise<EvaluationRecord[]>
  save(record: Omit<EvaluationRecord, 'id' | 'createdAt'>): Promise<EvaluationRecord>
}

export const PRODUCT_CARRIERS = [
  'mug', 'tote', 'tee', 'poster', 'cushion', 'scarf', 'notebook', 'vase',
  'tumbler', 'coaster', 'bookmark', 'fan', 'phonecase', 'pouch',
] as const
export type ProductCarrier = typeof PRODUCT_CARRIERS[number]

export type ProductColor = 'ivory' | 'indigo' | 'terracotta' | `#${string}`

export interface ProductAppearance {
  scale: number
  offsetX: number
  offsetY: number
  rotation: number
  repeat: boolean
  removeBackground: boolean
  color: ProductColor
  detailColor: ProductColor | 'auto'
}

export interface WorkshopSession {
  patternId: string
  patternName: string
  textureUrl: string
  carrier: ProductCarrier
  appearance?: ProductAppearance
  source: 'create' | 'library' | 'sam3'
  createdAt: string
}

export interface MarbleWorldAssets {
  thumbnailUrl?: string
  panoUrl?: string
  meshGlbUrl?: string
  worldMarbleUrl?: string
  caption?: string
}

export interface MarbleWorld {
  id: string
  displayName: string
  status: 'mock' | 'queued' | 'ready' | 'error'
  mode: 'mock' | 'live'
  prompt: string
  assets: MarbleWorldAssets
  message?: string
  createdAt: string
}

export interface MarbleGenerateRequest {
  displayName: string
  textPrompt: string
  imageUri?: string
}

export interface MarbleService {
  isLive(): boolean
  generateMuseum(request: MarbleGenerateRequest): Promise<MarbleWorld>
  getWorld(id: string): Promise<MarbleWorld>
}

export function splitMeaning(meaning: string) {
  const match = meaning.match(/^\[([^\]]+)\]\s*(.*)$/)
  const label = match?.[1] ?? '中性设计意向'
  const content = match?.[2] ?? meaning
  const level = label.includes('谨慎') ? 'cautious' : label.includes('资料支持') ? 'supported' : 'neutral'
  return { label, content, level }
}
