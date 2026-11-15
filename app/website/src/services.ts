import { PatternElementSchema, PatternSchema, Sam3HealthSchema, Sam3ResponseSchema, type EvaluationRecord, type EvaluationRepository, type GenerationPreview, type GenerationRequest, type GenerationResult, type GenerationService, type Pattern, type PatternElement, type PatternRepository, type SegmentationService } from './domain'
import { appConfig } from './config'
import { AIPlanResponseSchema, GenerationProfileSchema, PlanCheckSchema, StructureMetricSchema, type AIPlanProposal, type ConceptDisposition, type GenerationCandidate, type GenerationHealth, type GenerationProfile, type ReferenceImage } from './domain'
import { isConceptActive, type SemanticPlan } from './knowledge'
import { ReferenceConditioningSchema, ReferencePreparationSchema, type ReferencePreparation, type ReferencePreparationRequest } from './domain'

const PatternListSchema = PatternSchema.array()
const ElementListSchema = PatternElementSchema.array()

export class JsonPatternRepository implements PatternRepository {
  private patternsPromise?: Promise<Pattern[]>
  private elementsPromise?: Promise<PatternElement[]>

  list() {
    this.patternsPromise ??= fetch('/data/patterns.json').then((response) => {
      if (!response.ok) throw new Error('纹样数据未能加载')
      return response.json()
    }).then((data) => PatternListSchema.parse(data))
    return this.patternsPromise
  }

  async get(id: string) {
    return (await this.list()).find((pattern) => pattern.id === id.toUpperCase())
  }

  elements() {
    this.elementsPromise ??= fetch('/data/elements.json').then((response) => {
      if (!response.ok) throw new Error('纹样元数据未能加载')
      return response.json()
    }).then((data) => ElementListSchema.parse(data))
    return this.elementsPromise
  }

  async elementsForPattern(id: string) {
    const pattern = await this.get(id)
    if (!pattern) return []
    const ids = new Set(pattern.element_ids)
    return (await this.elements()).filter((element) => ids.has(element.id) || element.pattern_id === id)
  }
}

export class DemoGenerationService implements GenerationService {
  async health(): Promise<GenerationHealth> {
    return { status: 'ok', model_state: 'demo', runtime_available: true }
  }

  async refine(): Promise<AIPlanProposal> {
    throw new Error('本机语言整理需要启用LoRA服务连接。')
  }

  async compose(): Promise<AIPlanProposal> {
    throw new Error('整图语义编排需要启用LoRA服务连接。')
  }

  async analyzeReference(): Promise<AIPlanProposal> {
    throw new Error('本机读图需要启用LoRA服务连接。')
  }

  async prepareReference(): Promise<ReferencePreparation> {
    throw new Error('结构与配色参考需要连接本机生成服务。')
  }

  async preview(request: GenerationRequest): Promise<GenerationPreview> {
    const terms = [...(request.semanticPlan?.concepts ?? [])]
      .filter(concept => request.semanticPlan && isConceptActive(request.semanticPlan, concept) && concept.promptText.trim())
      .sort((a, b) => b.priority - a.priority)
      .map(concept => concept.promptText.trim())
    return {
      prompt: ['dongzu', ...terms, request.semanticPlan?.extraPrompt].filter(Boolean).join(', '),
      negativePrompt: '',
      semanticPlan: request.semanticPlan,
      warnings: ['当前为演示模式，画面采用原有素材。'],
      compilerVersion: 'demo-plan-v1',
      generationProfile: request.generationProfile ?? 'standard',
    }
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    if (!appConfig.enableDemo) throw new Error('本地创生演示已关闭，请配置真实 GenerationService。')
    await new Promise((resolve) => window.setTimeout(resolve, 900))
    const preview = await this.preview(request)
    return {
      ...request,
      ...preview,
      id: `DEMO-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      mode: 'demo',
      generatedImage: request.element?.image ?? request.pattern.image,
    }
  }
}

/** 调用本地 LoRA 服务；失败时可选回退 Demo */
export class HttpLoraGenerationService implements GenerationService {
  private payload(request: GenerationRequest) {
    return {
      pattern_id: request.pattern.id,
      pattern_name: request.pattern.name,
      category: request.pattern.category,
      composition: request.composition,
      palette: request.palette,
      intention: request.intention,
      carrier: request.carrier,
      keywords: request.pattern.generation_keywords,
      semantic_plan: request.semanticPlan,
      seed: request.seed,
      element_id: request.element?.id,
      parent_result_id: request.parentResultId,
      reference_id: request.referenceImage?.id,
      reference_name: request.referenceImage?.name,
      assistance: request.assistance,
      lora_scale: request.loraScale,
      generation_profile: request.generationProfile ?? 'standard',
      reference_conditioning: request.referenceConditioning,
      width: request.referencePreparation?.settings.width,
      height: request.referencePreparation?.settings.height,
      steps: 30,
      guidance: 7.2,
      count: 3,
    }
  }

  private async request(path: string, init?: RequestInit, timeoutMs = 300_000) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${appConfig.loraApiBaseUrl}${path}`, { ...init, signal: controller.signal })
      const body = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(body.error ?? `LoRA 服务返回 ${response.status}`)
      return body
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('LoRA 生成超时，请确认生成服务已启动且 GPU 空闲。')
      }
      if (error instanceof TypeError) {
        throw new Error('未连接到 LoRA 生成服务。请先运行 scripts/start-lora.ps1（端口 8001）。')
      }
      throw error
    } finally {
      window.clearTimeout(timeout)
    }
  }

  async health() {
    return this.request('/lora/health', undefined, 5_000) as Promise<GenerationHealth>
  }

  private async propose(path: string, payload: object): Promise<AIPlanProposal> {
    const body = AIPlanResponseSchema.parse(await this.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }, 300_000))
    return { semanticPlan: body.semantic_plan, model: body.model,
      elapsedSeconds: body.elapsed_seconds, warnings: body.warnings ?? [], reference: body.reference }
  }

  refine(plan: SemanticPlan, brief: string) {
    return this.propose('/lora/refine', { semantic_plan: plan, brief })
  }

  compose(plan: SemanticPlan) {
    return this.propose('/lora/compose', { semantic_plan: plan })
  }

  analyzeReference(image: ReferenceImage) {
    return this.propose('/lora/analyze-reference', { image_data_url: image.image })
  }

  async prepareReference(request: ReferencePreparationRequest): Promise<ReferencePreparation> {
    return ReferencePreparationSchema.parse(await this.request('/lora/prepare-reference', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    }, 60_000))
  }

  private confirmedReference(request: GenerationRequest, value: unknown) {
    if (!request.referenceConditioning && value == null) return undefined
    const actual = ReferenceConditioningSchema.safeParse(value)
    if (!actual.success || !request.referenceConditioning
      || JSON.stringify(actual.data) !== JSON.stringify(ReferenceConditioningSchema.parse(request.referenceConditioning))) {
      throw new Error('生成服务返回的结构参考与已采用配置不一致，请重新准备后重试。')
    }
    return actual.data
  }

  async preview(request: GenerationRequest): Promise<GenerationPreview> {
    const body = await this.request('/lora/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.payload(request)),
    }, 300_000) as {
      prompt: string
      negative_prompt: string
      semantic_plan?: GenerationRequest['semanticPlan']
      warnings?: string[]
      compiler_version: string
      prompt_token_count?: number
      token_limit?: number
      fixed_prompt_prefix?: string
      applied_concept_ids?: string[]
      omitted_concept_ids?: string[]
      concept_dispositions?: ConceptDisposition[]
      lora_scale?: number
      plan_checks?: unknown[]
      generation_profile?: GenerationProfile
      generation_policy?: Record<string, unknown>
      reference_conditioning?: unknown
      reference_preparation?: Record<string, unknown>
    }
    return {
      prompt: body.prompt,
      negativePrompt: body.negative_prompt,
      semanticPlan: body.semantic_plan,
      warnings: body.warnings ?? [],
      compilerVersion: body.compiler_version,
      promptTokenCount: body.prompt_token_count,
      tokenLimit: body.token_limit,
      fixedPromptPrefix: body.fixed_prompt_prefix,
      appliedConceptIds: body.applied_concept_ids,
      omittedConceptIds: body.omitted_concept_ids,
      conceptDispositions: body.concept_dispositions,
      planChecks: PlanCheckSchema.array().parse(body.plan_checks ?? []),
      generationProfile: GenerationProfileSchema.parse(body.generation_profile ?? 'standard'),
      generationPolicy: body.generation_policy,
      referenceConditioning: this.confirmedReference(request, body.reference_conditioning),
      referencePreparation: request.referencePreparation && { ...request.referencePreparation, metadata: body.reference_preparation },
    }
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const body = await this.request('/lora/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.payload(request)),
    }) as {
      id: string
      image_data_url?: string
      prompt?: string
      negative_prompt?: string
      created_at?: string
      candidates?: GenerationCandidate[]
      semantic_plan?: GenerationRequest['semanticPlan']
      seed?: number
      model?: string
      base_model?: string
      steps?: number
      guidance?: number
      width?: number
      height?: number
      inference_seconds?: number
      conditioning_model?: GenerationResult['conditioningModel']
      postprocessing?: string
      compiler_version?: string
      warnings?: string[]
      metadata_path?: string
      fixed_prompt_prefix?: string
      applied_concept_ids?: string[]
      omitted_concept_ids?: string[]
      prompt_token_count?: number
      token_limit?: number
      concept_dispositions?: ConceptDisposition[]
      lora_scale?: number
      plan_checks?: unknown[]
      generation_profile?: GenerationProfile
      generation_policy?: Record<string, unknown>
      reference_conditioning?: unknown
      reference_preparation?: Record<string, unknown>
    }

    const candidates = (body.candidates ?? []).filter((item) => item.image).map(item => ({ ...item,
      structureMetrics: StructureMetricSchema.array().parse(item.structureMetrics ?? []) }))
    const firstImage = candidates[0]?.image ?? body.image_data_url
    if (!firstImage) throw new Error('LoRA 服务未返回生成图像。')

    return {
      ...request,
      id: body.id || `LORA-${Date.now()}`,
      createdAt: body.created_at || new Date().toISOString(),
      generatedImage: firstImage,
      candidates: candidates.length ? candidates : [{ image: firstImage, seed: 0 }],
      prompt: body.prompt,
      negativePrompt: body.negative_prompt,
      mode: 'lora',
      semanticPlan: body.semantic_plan ?? request.semanticPlan,
      seed: body.seed,
      model: body.model,
      baseModel: body.base_model,
      steps: body.steps,
      guidance: body.guidance,
      width: body.width,
      height: body.height,
      inferenceSeconds: body.inference_seconds,
      conditioningModel: body.conditioning_model,
      postprocessing: body.postprocessing,
      compilerVersion: body.compiler_version,
      warnings: body.warnings,
      metadataPath: body.metadata_path,
      fixedPromptPrefix: body.fixed_prompt_prefix,
      appliedConceptIds: body.applied_concept_ids,
      omittedConceptIds: body.omitted_concept_ids,
      promptTokenCount: body.prompt_token_count,
      tokenLimit: body.token_limit,
      conceptDispositions: body.concept_dispositions,
      loraScale: body.lora_scale ?? request.loraScale,
      planChecks: PlanCheckSchema.array().parse(body.plan_checks ?? []),
      generationProfile: GenerationProfileSchema.parse(body.generation_profile ?? 'standard'),
      generationPolicy: body.generation_policy,
      referenceConditioning: this.confirmedReference(request, body.reference_conditioning),
      referencePreparation: request.referencePreparation && { ...request.referencePreparation, metadata: body.reference_preparation },
    }
  }
}

export class LocalEvaluationRepository implements EvaluationRepository {
  private readonly key = 'xiuwen-evaluations-v1'

  async list(): Promise<EvaluationRecord[]> {
    try { return JSON.parse(localStorage.getItem(this.key) ?? '[]') } catch { return [] }
  }

  async save(record: Omit<EvaluationRecord, 'id' | 'createdAt'>): Promise<EvaluationRecord> {
    const next = { ...record, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
    const all = await this.list()
    localStorage.setItem(this.key, JSON.stringify([next, ...all].slice(0, 20)))
    return next
  }
}

export class HttpSegmentationService implements SegmentationService {
  private async request(path: string, init?: RequestInit, timeoutMs = 5_000) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${appConfig.apiBaseUrl}${path}`, { ...init, signal: controller.signal })
      const body = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(body.error ?? `本地 SAM3 服务返回 ${response.status}`)
      return body
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('本地 SAM3 响应超时，请检查启动窗口。')
      if (error instanceof TypeError) throw new Error('未连接到本地 SAM3 服务，请用项目根目录的一键启动脚本运行网站。')
      throw error
    } finally {
      window.clearTimeout(timeout)
    }
  }

  async health() {
    return Sam3HealthSchema.parse(await this.request('/sam3/health'))
  }

  async segment(patternId: string, box: number[], mode: 'single' | 'motif' = 'single') {
    return Sam3ResponseSchema.parse(await this.request('/sam3/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern_id: patternId, box, mode }),
    }, 120_000))
  }
}

const demoGeneration = new DemoGenerationService()
const loraGeneration = new HttpLoraGenerationService()

/** 默认走本地 LoRA；关闭 VITE_ENABLE_LORA 时回退 Demo */
export const generationService: GenerationService = appConfig.enableLora
  ? loraGeneration
  : demoGeneration

export const patternRepository = new JsonPatternRepository()
export const evaluationRepository = new LocalEvaluationRepository()
export const segmentationService = new HttpSegmentationService()
