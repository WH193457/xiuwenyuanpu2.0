import { z } from 'zod'
import { GenerationProfileSchema, PatternElementSchema, PatternSchema, PlanAssistanceSchema, ReferenceImageSchema, SemanticPlanSchema, PlanCheckSchema, StructureMetricSchema, type GenerationProfile, type GenerationResult, type PatternElement, type PlanAssistance, type ReferenceImage } from './domain'
import type { SemanticPlan } from './knowledge'
import type { ConceptReview } from './iterationFeedback'
import { ReferenceConditioningSchema, ReferenceEditorSchema, ReferencePreparationSchema, type ReferenceEditor } from './domain'
import { upgradeLegacyReferenceEditor } from './referenceConditioning'

export interface CreationRecord {
  result: GenerationResult
  selectedIndex: number
  note: string
  parentId?: string
  reviews?: ConceptReview[]
}

const DATABASE_NAME = 'xiuwen-creations-v1'
const STORE_NAME = 'creations'
const HISTORY_LIMIT = 12
const ImageReferenceSchema = z.string().min(1).max(12 * 1024 * 1024)
const GenerationResultSchema = z.object({
  id: z.string().min(1).max(256),
  createdAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
  pattern: PatternSchema,
  element: PatternElementSchema.optional(),
  referenceImage: ReferenceImageSchema.optional(),
  referenceConditioning: ReferenceConditioningSchema.optional(),
  referencePreparation: ReferencePreparationSchema.optional(),
  assistance: PlanAssistanceSchema.optional(),
  loraScale: z.number().min(0).max(1).optional(),
  generationProfile: GenerationProfileSchema.optional(),
  generationPolicy: z.record(z.string(), z.unknown()).optional(),
  composition: z.string(),
  palette: z.string(),
  intention: z.string(),
  carrier: z.string(),
  generatedImage: ImageReferenceSchema.optional(),
  candidates: z.array(z.object({
    image: ImageReferenceSchema,
    seed: z.number().finite().int(),
    path: z.string().optional(),
    structureMetrics: z.array(StructureMetricSchema).max(3).optional(),
    denoisingSteps: z.number().int().nonnegative().optional(),
  })).max(4).optional(),
  prompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  mode: z.enum(['demo', 'lora']).optional(),
  semanticPlan: SemanticPlanSchema.optional(),
  parentResultId: z.string().min(1).max(256).optional(),
  seed: z.number().finite().int().optional(),
  model: z.string().optional(),
  baseModel: z.string().optional(),
  steps: z.number().finite().int().positive().optional(),
  guidance: z.number().finite().optional(),
  width: z.number().finite().int().positive().optional(),
  height: z.number().finite().int().positive().optional(),
  inferenceSeconds: z.number().finite().nonnegative().optional(),
  conditioningModel: z.object({ name: z.string(), revision: z.string() }).nullable().optional(),
  postprocessing: z.string().optional(),
  compilerVersion: z.string().optional(),
  fixedPromptPrefix: z.string().optional(),
  appliedConceptIds: z.array(z.string().max(256)).max(64).optional(),
  omittedConceptIds: z.array(z.string().max(256)).max(64).optional(),
  metadataPath: z.string().optional(),
  warnings: z.array(z.string()).max(256).optional(),
  promptTokenCount: z.number().finite().int().nonnegative().optional(),
  tokenLimit: z.number().finite().int().positive().optional(),
  conceptDispositions: z.array(z.object({ id: z.string(), status: z.enum(['applied', 'omitted']), reason: z.string() })).max(64).optional(),
  planChecks: z.array(PlanCheckSchema).max(256).optional(),
})

const CreationRecordSchema = z.object({
  result: GenerationResultSchema,
  selectedIndex: z.number().finite().int().default(0),
  note: z.string().max(20_000).default(''),
  parentId: z.string().min(1).max(256).optional(),
  reviews: z.array(z.object({ candidateIndex: z.number().int().min(0).max(3), conceptId: z.string().min(1).max(256),
    status: z.enum(['met', 'partial', 'missed']) })).max(192).optional(),
})

function parseRecord(value: unknown): CreationRecord | undefined {
  const parsed = CreationRecordSchema.safeParse(value)
  if (!parsed.success) return undefined
  const record = parsed.data
  const candidateCount = record.result.candidates?.length ?? 0
  record.selectedIndex = Math.min(Math.max(0, record.selectedIndex), Math.max(0, candidateCount - 1))
  if (record.reviews) record.reviews = record.reviews.filter((review, index, all) =>
    review.candidateIndex < candidateCount && record.result.semanticPlan?.concepts.some(concept => concept.id === review.conceptId)
    && !all.slice(index + 1).some(item => item.candidateIndex === review.candidateIndex && item.conceptId === review.conceptId))
  return record
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前环境无法使用本地创作记录，请导出本次创作记录。'))
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2)
    let blocked = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'result.id' })
        store.createIndex('createdAt', 'createdAtTimestamp')
      }
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts')
    }
    request.onsuccess = () => {
      const database = request.result
      if (blocked) {
        database.close()
        return
      }
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => reject(new Error('无法打开本地创作记录，请检查浏览器存储权限。', { cause: request.error }))
    request.onblocked = () => {
      blocked = true
      reject(new Error('本地创作记录正在被其他页面占用，请关闭其他项目页面后重试。'))
    }
  })
}

export async function listCreations(): Promise<CreationRecord[]> {
  const database = await openDatabase()
  return new Promise<CreationRecord[]>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).getAll()
    transaction.oncomplete = () => {
      const records = (request.result as unknown[])
        .map(parseRecord)
        .filter((record): record is CreationRecord => record !== undefined)
        .sort((left, right) => Date.parse(right.result.createdAt) - Date.parse(left.result.createdAt))
      resolve(records.slice(0, HISTORY_LIMIT))
    }
    transaction.onabort = () => {
      reject(new Error('读取本地创作记录失败，请稍后重试。', { cause: transaction.error }))
    }
  }).finally(() => database.close())
}

export async function saveCreation(record: CreationRecord): Promise<void> {
  const validated = parseRecord(record)
  if (!validated) throw new Error('创作记录格式不完整，无法保存。')
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    // The update and pruning share one transaction, including concurrent saves from other tabs.
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => {
      reject(new Error('本地创作记录保存失败，请检查可用存储空间并导出本次记录。', { cause: transaction.error }))
    }
    try {
      const store = transaction.objectStore(STORE_NAME)
      store.put({ ...validated, createdAtTimestamp: Date.parse(validated.result.createdAt) })
      const cursorRequest = store.index('createdAt').openCursor(null, 'prev')
      let kept = 0
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) return
        if (parseRecord(cursor.value) && kept < HISTORY_LIMIT) {
          kept += 1
        } else {
          cursor.delete()
        }
        cursor.continue()
      }
    } catch (error) {
      transaction.abort()
      reject(new Error('本地创作记录保存失败，请检查可用存储空间并导出本次记录。', { cause: error }))
    }
  }).finally(() => database.close())
}

function externalImageReference(value: string | undefined) {
  return value?.startsWith('data:') || value?.startsWith('blob:') ? undefined : value
}

export function creationManifest(record: CreationRecord): object {
  const validated = parseRecord(record)
  if (!validated) throw new Error('创作记录格式不完整，无法导出。')
  const result = GenerationResultSchema.parse(validated.result)
  const selectedCandidate = result.candidates?.[validated.selectedIndex]
  const pattern = result.pattern
  return {
    format: 'xiuwen-creation',
    version: 1,
    id: result.id,
    createdAt: result.createdAt,
    parentId: validated.parentId ?? result.parentResultId,
    mode: result.mode,
    assistance: result.assistance,
    referenceConditioning: result.referenceConditioning,
    referencePreparation: result.referencePreparation,
    reference: {
      ...pattern,
      image: externalImageReference(pattern.image),
      thumbnail: externalImageReference(pattern.thumbnail),
      element: result.element && {
        ...result.element,
        image: externalImageReference(result.element.image),
      },
      uploadedImage: result.referenceImage && {
        id: result.referenceImage.id, name: result.referenceImage.name, width: result.referenceImage.width,
        height: result.referenceImage.height, analysisModel: result.referenceImage.analysisModel, sha256: result.referenceImage.sha256,
      },
    },
    conditions: {
      composition: result.composition,
      palette: result.palette,
      intention: result.intention,
      carrier: result.carrier,
      semanticPlan: result.semanticPlan,
      appliedConceptIds: result.appliedConceptIds,
      omittedConceptIds: result.omittedConceptIds,
      conceptDispositions: result.conceptDispositions,
      planChecks: result.planChecks,
    },
    prompt: result.prompt,
    negativePrompt: result.negativePrompt,
    fixedPromptPrefix: result.fixedPromptPrefix,
    runtime: {
      model: result.model,
      baseModel: result.baseModel,
      steps: result.steps,
      guidance: result.guidance,
      width: result.width,
      height: result.height,
      seed: result.seed ?? result.candidates?.[0]?.seed,
      count: result.candidates?.length,
      inferenceSeconds: result.inferenceSeconds,
      conditioningModel: result.conditioningModel,
      postprocessing: result.postprocessing,
      compilerVersion: result.compilerVersion,
      promptTokenCount: result.promptTokenCount,
      tokenLimit: result.tokenLimit,
      loraScale: result.loraScale,
      generationProfile: result.generationProfile ?? 'standard',
      generationPolicy: result.generationPolicy,
      metadataPath: result.metadataPath,
    },
    warnings: result.warnings ?? [],
    selectedIndex: validated.selectedIndex,
    selectedCandidate: selectedCandidate && {
      seed: selectedCandidate.seed,
      path: selectedCandidate.path,
      image: externalImageReference(selectedCandidate.image),
      denoisingSteps: selectedCandidate.denoisingSteps,
    },
    candidates: result.candidates?.map(candidate => ({
      seed: candidate.seed,
      path: candidate.path,
      image: externalImageReference(candidate.image),
      structureMetrics: candidate.structureMetrics,
      denoisingSteps: candidate.denoisingSteps,
    })),
    image: externalImageReference(result.generatedImage),
    note: validated.note,
    reviews: validated.reviews,
  }
}

export interface CreationDraft {
  version: 1
  patternId: string
  plan: SemanticPlan
  element?: PatternElement
  referenceImage?: ReferenceImage
  assistance?: PlanAssistance
  loraScale?: number
  generationProfile?: GenerationProfile
  referenceEditor?: ReferenceEditor
  carrier: string
  seed: string
  brief: string
  parentId?: string
  resultId?: string
  updatedAt: string
}

const CreationDraftSchema: z.ZodType<CreationDraft> = z.object({
  version: z.literal(1), patternId: z.string().min(1), plan: SemanticPlanSchema,
  element: PatternElementSchema.optional(), referenceImage: ReferenceImageSchema.optional(),
  assistance: PlanAssistanceSchema.optional(), loraScale: z.number().min(0).max(1).optional(),
  generationProfile: GenerationProfileSchema.optional(),
  referenceEditor: ReferenceEditorSchema.optional(),
  carrier: z.string(), seed: z.string().max(20), brief: z.string().max(1000),
  parentId: z.string().optional(), resultId: z.string().optional(),
  updatedAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
})

export async function loadDraft(): Promise<CreationDraft | undefined> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction('drafts', 'readonly')
      const request = transaction.objectStore('drafts').get('current')
      transaction.oncomplete = () => {
        database.close()
        const parsed = CreationDraftSchema.safeParse(request.result)
        if (parsed.success && parsed.data.referenceEditor) parsed.data.referenceEditor = upgradeLegacyReferenceEditor(parsed.data.referenceEditor)
        resolve(parsed.success ? parsed.data : undefined)
      }
      transaction.onabort = () => { database.close(); reject(new Error('草稿读取失败。')) }
    } catch (error) { database.close(); reject(new Error('草稿读取失败。', { cause: error })) }
  })
}

export async function saveDraft(draft: CreationDraft): Promise<void> {
  const validated = CreationDraftSchema.parse(draft)
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction | undefined
    try {
      transaction = database.transaction('drafts', 'readwrite')
      const store = transaction.objectStore('drafts')
      const previous = store.get('current')
      previous.onsuccess = () => {
        try {
          const old = CreationDraftSchema.safeParse(previous.result)
          if (!old.success || Date.parse(old.data.updatedAt) <= Date.parse(validated.updatedAt)) store.put(validated, 'current')
        } catch (error) {
          transaction?.abort()
          database.close()
          reject(new Error('草稿保存失败，请检查浏览器可用空间。', { cause: error }))
        }
      }
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(new Error('草稿保存失败，请检查浏览器可用空间。')) }
    } catch (error) {
      transaction?.abort()
      database.close()
      reject(new Error('草稿保存失败，请检查浏览器可用空间。', { cause: error }))
    }
  })
}
