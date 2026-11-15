import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData, useSearchParams } from 'react-router'
import { Sam3SelectionSchema, splitMeaning, type AIPlanProposal, type GenerationHealth, type GenerationPreview, type GenerationProfile, type GenerationRequest, type Pattern, type PatternElement, type PlanAssistance, type ProductCarrier, type ReferenceImage, type Sam3Selection, type WorkshopSession } from '../domain'
import { buildKnowledgeGraph, contextFor, CREATIVE_GOALS, createInitialPlan, isConceptActive, recommendConcepts, type SemanticContext, type SemanticConcept, type SemanticPlan } from '../knowledge'
import { creationManifest, listCreations, loadDraft, saveCreation, saveDraft, type CreationDraft, type CreationRecord } from '../creationHistory'
import { saveWorkshopSession } from '../workshopSession'
import { PRODUCT_CATALOG } from '../productCatalog'
import { generationService } from '../services'
import { KnowledgeRecommendations, SemanticCanvas, SourceReferences } from './SemanticCanvas'
import { AIPlanReview } from './AIPlanReview'
import { IterationComparison } from './IterationComparison'
import { ConditionReview, PlanChecks } from './ConditionReview'
import { feedbackPlan, type ConceptReview } from '../iterationFeedback'
import { initialReferenceEditor, isReferenceAccepted, referenceEditorFromResult } from '../referenceConditioning'
import { readReferenceFile } from '../referenceImage'
import { ReferenceConditioningPanel } from './ReferenceConditioningPanel'
import type { ReferenceEditor } from '../domain'
import './create.css'

const carrierMap: Record<string, ProductCarrier> = {
  '海报': 'poster', '包装': 'tote', '织物配饰': 'tee',
  ...Object.fromEntries(PRODUCT_CATALOG.map(product => [product.label, product.id])),
}

const generationProfileLabels: Record<GenerationProfile, string> = {
  'subject-fidelity': '主体与构图优先',
  standard: '原有风格模式',
}

function downloadManifest(record: CreationRecord) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(creationManifest(record), null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${record.result.id}-创作记录.json`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function conditionLabel(plan: SemanticPlan, dimension: SemanticConcept['dimension']) {
  return plan.concepts.filter(concept => concept.dimension === dimension && isConceptActive(plan, concept)).map(concept => concept.label).join('、')
}

export function CreatePage() {
  const { patterns, elements } = useLoaderData() as { patterns: Pattern[]; elements: PatternElement[] }
  const [params] = useSearchParams()
  const requestedId = params.get('patterns')?.split(',')[0] ?? 'DX060'
  const initialPattern = patterns.find(pattern => pattern.id === requestedId) ?? patterns[0]
  const sam3Selection = useMemo<Sam3Selection | undefined>(() => {
    if (params.get('sam3') !== '1') return undefined
    try { return Sam3SelectionSchema.parse(JSON.parse(sessionStorage.getItem('xiuwen-sam3-selection-v1') ?? 'null')) } catch { return undefined }
  }, [params])
  const graph = useMemo(() => buildKnowledgeGraph(patterns), [patterns])
  const [patternId, setPatternId] = useState(initialPattern.id)
  const pattern = patterns.find(item => item.id === patternId) ?? initialPattern
  const [plan, setPlan] = useState<SemanticPlan>(() => createInitialPlan(initialPattern))
  const [query, setQuery] = useState('')
  const [elementId, setElementId] = useState(sam3Selection?.patternId === initialPattern.id ? 'SAM3-TEMP' : '')
  const [restoredElement, setRestoredElement] = useState<PatternElement>()
  const [carrier, setCarrier] = useState('装裱画')
  const [seed, setSeed] = useState('')
  const [generating, setGenerating] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<GenerationPreview>()
  const [previewKey, setPreviewKey] = useState('')
  const [record, setRecord] = useState<CreationRecord>()
  const [history, setHistory] = useState<CreationRecord[]>([])
  const [parentId, setParentId] = useState<string>()
  const [error, setError] = useState('')
  const [storageNotice, setStorageNotice] = useState('')
  const [notice, setNotice] = useState('')
  const [savingRecord, setSavingRecord] = useState(false)
  const [draftReady, setDraftReady] = useState(false)
  const [draftStatus, setDraftStatus] = useState('正在读取草稿…')
  const [brief, setBrief] = useState('')
  const [referenceImage, setReferenceImage] = useState<ReferenceImage>()
  const [assistance, setAssistance] = useState<PlanAssistance>()
  const [loraScale, setLoraScale] = useState(0.35)
  const [generationProfile, setGenerationProfile] = useState<GenerationProfile>('subject-fidelity')
  const [referenceEditor, setReferenceEditor] = useState(initialReferenceEditor)
  const [preparingReference, setPreparingReference] = useState(false)
  const [pendingReference, setPendingReference] = useState<ReferenceImage>()
  const [proposal, setProposal] = useState<{ value: AIPlanProposal; kind: PlanAssistance['kind']; sourceKey: string }>()
  const [assisting, setAssisting] = useState<PlanAssistance['kind']>()
  const [health, setHealth] = useState<GenerationHealth>()
  const [healthError, setHealthError] = useState('')
  const [serviceState, setServiceState] = useState<'checking' | 'online' | 'offline'>('checking')
  const [baselineId, setBaselineId] = useState('')
  const active = useRef(true)
  const pendingDraft = useRef<CreationDraft | undefined>(undefined)
  const proposalPanel = useRef<HTMLDivElement>(null)
  const assistanceKey = JSON.stringify({ patternId, plan, brief, elementId, referenceId: referenceImage?.id })

  useEffect(() => {
    if (!proposal) return
    if (proposal.sourceKey !== assistanceKey) {
      setProposal(undefined)
      setPendingReference(undefined)
      setNotice('创作条件已变化，之前的模型建议已关闭，请按当前条件重新整理或分析。')
      return
    }
    proposalPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [proposal, assistanceKey])

  useEffect(() => {
    active.current = true
    let reading = true
    Promise.allSettled([listCreations(), loadDraft()]).then(([recordsResult, draftResult]) => {
      if (!reading) return
      const records = recordsResult.status === 'fulfilled' ? recordsResult.value : []
      setHistory(records)
      if (recordsResult.status === 'rejected') setStorageNotice('此浏览器暂时无法读取创作历史，生成后可导出创作记录。')
      const draft = draftResult.status === 'fulfilled' ? draftResult.value : undefined
      if (draft && patterns.some(item => item.id === draft.patternId) && (!params.has('patterns') || draft.patternId === initialPattern.id) && params.get('sam3') !== '1') {
        setPatternId(draft.patternId)
        setPlan(draft.plan)
        setRestoredElement(draft.element)
        setElementId(draft.element?.id ?? '')
        setReferenceImage(draft.referenceImage)
        setAssistance(draft.assistance)
        setLoraScale(draft.loraScale ?? 1)
        setGenerationProfile(draft.generationProfile ?? 'standard')
        setReferenceEditor(draft.referenceEditor ?? initialReferenceEditor())
        setCarrier(draft.carrier)
        setSeed(draft.seed)
        setBrief(draft.brief)
        setParentId(draft.parentId)
        const savedResult = records.find(item => item.result.id === draft.resultId)
        setRecord(savedResult)
        if (savedResult) persistWorkshop(savedResult)
        setDraftStatus('已恢复上次草稿')
      } else setDraftStatus(draftResult.status === 'rejected' ? '草稿存储暂不可用' : '草稿自动保存')
      setDraftReady(true)
    })
    return () => {
      reading = false
      active.current = false
      if (pendingDraft.current) void saveDraft(pendingDraft.current).catch(() => undefined)
    }
  }, [])

  const refreshHealth = useCallback(async () => {
    try {
      const next = await generationService.health()
      if (!active.current) return
      setHealth(next)
      setServiceState('online')
      setHealthError('')
    } catch (reason) {
      if (!active.current) return
      setServiceState('offline')
      setHealthError(reason instanceof Error ? reason.message : '无法连接本机模型服务。')
    }
  }, [])

  useEffect(() => {
    void refreshHealth()
    const timer = window.setInterval(() => void refreshHealth(), 15_000)
    return () => window.clearInterval(timer)
  }, [refreshHealth])

  const sam3Element: PatternElement | undefined = sam3Selection?.patternId === pattern.id ? {
    id: 'SAM3-TEMP', pattern_id: pattern.id, image: sam3Selection.candidate.cutout_data_url,
    name: '本次智能拆解元', type: 'SAM3 临时纹样元', position: '用户框选区域',
    use: '创作视觉参考', crop_box: sam3Selection.candidate.bbox_xyxy,
  } : undefined
  const referenceSnapshot = restoredElement?.pattern_id === pattern.id ? restoredElement : sam3Element
  const availableElements = [...(referenceSnapshot ? [referenceSnapshot] : []), ...elements.filter(item =>
    item.id !== referenceSnapshot?.id && (pattern.element_ids.includes(item.id) || item.pattern_id === pattern.id))]
  const currentElement = availableElements.find(item => item.id === elementId)
  useEffect(() => {
    if (!draftReady) return
    const draft: CreationDraft = {
      version: 1, patternId, plan, element: currentElement, referenceImage, assistance, loraScale, generationProfile, referenceEditor, carrier, seed, brief,
      parentId, resultId: record?.result.id, updatedAt: new Date().toISOString(),
    }
    pendingDraft.current = draft
    setDraftStatus('正在保存草稿…')
    const timer = window.setTimeout(() => {
      void saveDraft(pendingDraft.current ?? draft).then(() => { if (active.current) setDraftStatus('草稿已保存') })
        .catch(() => { if (active.current) setDraftStatus('草稿保存失败，请保留当前页面并导出生成记录') })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [draftReady, patternId, plan, elementId, restoredElement, referenceImage, assistance, loraScale, generationProfile, referenceEditor, carrier, seed, brief, parentId, record?.result.id])
  const activePlan = useMemo(() => ({ ...plan, context: { ...contextFor(plan), brief } }), [plan, brief])
  const recommendations = useMemo(() => recommendConcepts(graph, patternId, activePlan, query, 6), [graph, patternId, activePlan, query])
  const updateContext = (change: Partial<SemanticContext>) => setPlan({ ...activePlan, promptRealization: undefined, context: { ...activePlan.context, ...change } })
  const meaning = splitMeaning(pattern.meaning)
  const referenceAccepted = isReferenceAccepted(referenceEditor, patternId, currentElement)
  const referenceBlocked = referenceEditor.enabled && (!referenceAccepted || !health?.reference_conditioning?.available)
  const referenceConditioning = referenceEditor.enabled && referenceAccepted ? referenceEditor.conditioning : undefined
  const referencePreparation = referenceConditioning ? referenceEditor.preparation : undefined
  const generationKey = (currentPlan: SemanticPlan, profile: GenerationProfile) => JSON.stringify({ patternId, generationProfile: profile,
    referenceConditioning, referencePending: referenceEditor.enabled && !referenceAccepted, plan: { ...currentPlan, extraPromptTranslation: undefined } })
  const draftKey = generationKey(activePlan, generationProfile)
  const busy = generating || previewing || savingRecord || preparingReference || Boolean(assisting) || !draftReady
  const compatibleService = health?.compiler_version === 'dong-semantic-plan-6' || health?.model_state === 'demo'
  const canGenerate = serviceState === 'online' && health?.runtime_available !== false && compatibleService && !referenceBlocked

  const makeRequest = (): GenerationRequest => {
    if (referenceBlocked) throw new Error('请准备并采用当前结构参考，或关闭结构与配色参考后生成。')
    if (seed.trim() && (!/^\d+$/.test(seed.trim()) || !Number.isSafeInteger(Number(seed)) || Number(seed) > 4_294_967_295)) {
      throw new Error('随机种子请输入0至4294967295之间的整数，或留空自动选择。')
    }
    return {
      pattern, element: currentElement, semanticPlan: activePlan,
      composition: conditionLabel(plan, 'composition'), palette: conditionLabel(plan, 'palette'),
      intention: conditionLabel(plan, 'intention'), carrier,
      seed: seed.trim() ? Number(seed) : undefined,
      parentResultId: parentId,
      referenceImage,
      assistance,
      loraScale,
      generationProfile,
      referenceConditioning,
      referencePreparation,
    }
  }

  const selectPattern = (id: string) => {
    const next = patterns.find(item => item.id === id)
    if (!next) return
    setPatternId(id)
    setElementId('')
    setRestoredElement(undefined)
    setReferenceImage(undefined)
    setReferenceEditor(initialReferenceEditor())
    setAssistance(undefined)
    setPendingReference(undefined)
    setProposal(undefined)
    setPlan(createInitialPlan(next))
    setBrief('')
    setQuery('')
    setParentId(undefined)
    setPreview(undefined)
    setError('')
    setNotice(referenceEditor.enabled || referenceEditor.preparation ? '已切换母纹并清除旧结构参考，请按新母纹重新准备。' : '已根据母纹标注建立初始画布。')
  }

  const refinePlan = async () => {
    setError('')
    setAssisting('language')
    try {
      const value = await generationService.refine(activePlan, brief)
      if (active.current) setProposal({ value, kind: 'language', sourceKey: assistanceKey })
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : '本机语言整理失败。')
    } finally {
      if (active.current) { setAssisting(undefined); void refreshHealth() }
    }
  }

  const composePlan = async () => {
    setError('')
    setAssisting('composition')
    try {
      const value = await generationService.compose(activePlan)
      if (active.current) setProposal({ value, kind: 'composition', sourceKey: assistanceKey })
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : '整图语义编排失败。')
    } finally {
      if (active.current) { setAssisting(undefined); void refreshHealth() }
    }
  }

  const analyzeImage = async (uploaded?: File) => {
    setError('')
    setAssisting('vision')
    try {
      let reference = referenceImage
      if (uploaded) reference = await readReferenceFile(uploaded)
      if (!reference) {
        const response = await fetch(currentElement?.image ?? pattern.image)
        if (!response.ok) throw new Error('当前参考图读取失败。')
        const blob = await response.blob()
        reference = await readReferenceFile(new File([blob], `${currentElement?.id ?? pattern.id}.webp`, { type: blob.type }))
      }
      const value = await generationService.analyzeReference(reference)
      if (!active.current) return
      if (!value.reference) throw new Error('参考图分析缺少图像记录，请重试。')
      setPendingReference({ ...reference, ...value.reference, analysisModel: value.model })
      setProposal({ value, kind: 'vision', sourceKey: assistanceKey })
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : '本机参考图分析失败。')
    } finally {
      if (active.current) { setAssisting(undefined); void refreshHealth() }
    }
  }

  const savePlanDraft = async (nextPlan: SemanticPlan, changes: Partial<CreationDraft> = {}) => {
    const nextDraft: CreationDraft = {
      version: 1, patternId, plan: nextPlan, element: currentElement, referenceImage, assistance, loraScale, generationProfile, referenceEditor,
      carrier, seed, brief, parentId, resultId: record?.result.id, updatedAt: new Date().toISOString(), ...changes,
    }
    pendingDraft.current = nextDraft
    await saveDraft(nextDraft)
  }

  const acceptReference = async (next: ReferenceEditor) => {
    setSavingRecord(true)
    try {
      await savePlanDraft(activePlan, { referenceEditor: next })
      if (active.current) {
        setReferenceEditor(next)
        setDraftStatus('草稿已保存')
      }
    } finally {
      if (active.current) setSavingRecord(false)
    }
  }

  const acceptProposal = async () => {
    if (!proposal || proposal.sourceKey !== assistanceKey) return
    const nextPlan = { ...proposal.value.semanticPlan, context: activePlan.context }
    const nextAssistance = { model: proposal.value.model, kind: proposal.kind, elapsedSeconds: proposal.value.elapsedSeconds, createdAt: new Date().toISOString() }
    setSavingRecord(true)
    try {
      await savePlanDraft(nextPlan, { assistance: nextAssistance,
        ...(proposal.kind === 'vision' ? { referenceImage: pendingReference, element: undefined, parentId: undefined, referenceEditor: initialReferenceEditor() } : {}) })
    } catch {
      if (active.current) setStorageNotice('模型建议已采纳，草稿保存失败，请在生成后导出创作记录。')
    } finally {
      if (active.current) setSavingRecord(false)
    }
    if (!active.current) return
    setPlan(nextPlan)
    setAssistance(nextAssistance)
    if (proposal.kind === 'vision') {
      setReferenceImage(pendingReference)
      setReferenceEditor(initialReferenceEditor())
      setElementId('')
      setParentId(undefined)
    }
    setPreview(undefined)
    setProposal(undefined)
    setPendingReference(undefined)
    setNotice(proposal.kind === 'vision' && (referenceEditor.enabled || referenceEditor.preparation)
      ? '已采纳读图建议并清除旧结构参考，请按当前参考图重新准备。' : '已采纳本机模型建议，可继续编辑概念与关系。')
  }

  const addConcept = (concept: SemanticConcept) => {
    const exists = plan.concepts.some(item => item.id === concept.id)
    if (!exists && plan.concepts.length >= 24) {
      setError('画布最多保留24个概念，请先移除不需要的概念。')
      return
    }
    const next = { ...concept, enabled: true }
    setPlan({ ...plan, promptRealization: undefined, concepts: exists ? plan.concepts.map(item => item.id === concept.id ? next : item) : [...plan.concepts, next] })
    setError('')
    setNotice(`已添加 ${concept.label}`)
  }

  const persistWorkshop = (next: CreationRecord) => {
    if (!active.current) return false
    const result = next.result
    const image = result.candidates?.[next.selectedIndex]?.image ?? result.generatedImage ?? result.element?.image ?? result.pattern.image
    const session: WorkshopSession = {
      patternId: result.pattern.id, patternName: result.pattern.name, textureUrl: image,
      carrier: carrierMap[result.carrier] ?? 'poster', source: result.mode === 'lora' ? 'create' : result.element?.id === 'SAM3-TEMP' ? 'sam3' : 'create',
      createdAt: result.createdAt,
    }
    try {
      saveWorkshopSession(session)
      return true
    } catch {
      setStorageNotice('当前纹样未能传递到文创页面，请检查浏览器存储空间或权限，并下载纹样与创作记录。')
      return false
    }
  }

  const persistRecord = async (next: CreationRecord) => {
    if (active.current) setSavingRecord(true)
    try {
      await saveCreation(next)
      const saved = await listCreations()
      if (active.current) {
        setHistory(saved)
        setStorageNotice('')
      }
      return true
    } catch {
      if (active.current) setStorageNotice('创作结果已显示，浏览器历史保存失败。请导出记录并下载当前纹样。')
      return false
    } finally { if (active.current) setSavingRecord(false) }
  }

  const previewPrompt = async () => {
    setError('')
    setPreviewing(true)
    try {
      const next = await generationService.preview(makeRequest())
      if (!active.current) return
      setPreview(next)
      const actualProfile = next.generationProfile ?? 'standard'
      setGenerationProfile(actualProfile)
      if (next.semanticPlan) setPlan(next.semanticPlan)
      setPreviewKey(generationKey(next.semanticPlan ?? activePlan, actualProfile))
      try { await savePlanDraft(next.semanticPlan ?? activePlan, { generationProfile: actualProfile }) } catch {
        if (active.current) setStorageNotice('提示词已编排，草稿保存失败，请保留当前页面。')
      }
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : '提示词预览失败。')
    } finally { if (active.current) setPreviewing(false) }
  }

  const generate = async () => {
    setError('')
    setGenerating(true)
    try {
      const result = await generationService.generate(makeRequest())
      const next: CreationRecord = { result, selectedIndex: 0, note: '', parentId }
      const saved = await persistRecord(next)
      if (!active.current) return
      setRecord(next)
      const actualProfile = result.generationProfile ?? 'standard'
      setGenerationProfile(actualProfile)
      if (result.semanticPlan) setPlan(result.semanticPlan)
      setParentId(result.id)
      setSeed(String(result.candidates?.[0]?.seed ?? result.seed ?? ''))
      setBaselineId(next.parentId ?? '')
      setPreview({ prompt: result.prompt ?? '', negativePrompt: result.negativePrompt ?? '', semanticPlan: result.semanticPlan,
        warnings: result.warnings ?? [], compilerVersion: result.compilerVersion ?? 'legacy', promptTokenCount: result.promptTokenCount, tokenLimit: result.tokenLimit,
        appliedConceptIds: result.appliedConceptIds, omittedConceptIds: result.omittedConceptIds, conceptDispositions: result.conceptDispositions,
        planChecks: result.planChecks, generationProfile: actualProfile, generationPolicy: result.generationPolicy,
        referenceConditioning: result.referenceConditioning, referencePreparation: result.referencePreparation })
      setPreviewKey(generationKey(result.semanticPlan ?? activePlan, actualProfile))
      persistWorkshop(next)
      // Commit the result pointer before enabling controls. A quick reload after
      // generation must not depend on the debounced editor autosave.
      const completedDraft: CreationDraft = { version: 1, patternId, plan: result.semanticPlan ?? activePlan, element: currentElement,
        referenceImage, assistance, loraScale, generationProfile: actualProfile, referenceEditor, carrier, brief,
        seed: String(result.candidates?.[0]?.seed ?? result.seed ?? ''), parentId: result.id, resultId: result.id,
        updatedAt: new Date().toISOString() }
      pendingDraft.current = completedDraft
      try { await saveDraft(completedDraft) } catch {
        if (active.current) setDraftStatus('本轮草稿更新失败，可从创作历史恢复或导出记录')
      }
      setNotice(saved ? '生成完成，已记录本轮条件。可以修改画布继续生成。' : '生成完成，请导出本轮记录以保留创作条件。')
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : '创生失败，请检查本地生成服务。')
    } finally { if (active.current) setGenerating(false) }
  }

  const restore = (saved: CreationRecord) => {
    if (!patterns.some(item => item.id === saved.result.pattern.id)) {
      setError('这条记录的母纹已不在当前资料库中。')
      return
    }
    setRecord(saved)
    setPatternId(saved.result.pattern.id)
    setPlan(saved.result.semanticPlan ?? createInitialPlan(saved.result.pattern))
    setBrief(saved.result.semanticPlan?.context?.brief ?? '')
    setElementId(saved.result.element?.id ?? '')
    setRestoredElement(saved.result.element)
    setReferenceImage(saved.result.referenceImage)
    setAssistance(saved.result.assistance)
    setLoraScale(saved.result.loraScale ?? 1)
    setGenerationProfile(saved.result.generationProfile ?? 'standard')
    setReferenceEditor(referenceEditorFromResult(saved.result))
    setCarrier(saved.result.carrier)
    const candidateSeed = saved.result.candidates?.[saved.selectedIndex]?.seed ?? saved.result.seed
    setSeed(candidateSeed === undefined ? '' : String(candidateSeed))
    setParentId(saved.result.id)
    setPreview(undefined)
    setError('')
    setQuery('')
    setProposal(undefined)
    setPendingReference(undefined)
    setBaselineId(saved.parentId ?? '')
    persistWorkshop(saved)
    setNotice('已恢复本轮条件和所选候选的随机种子，可在画布中继续修改。')
  }

  const chooseCandidate = async (index: number) => {
    if (!record?.result.candidates?.[index]) return
    const next = { ...record, selectedIndex: index }
    setRecord(next)
    if (parentId === next.result.id) setSeed(String(next.result.candidates![index].seed))
    await persistRecord(next)
    persistWorkshop(next)
  }

  const reviewConcept = async (conceptId: string, status: ConceptReview['status'] | '') => {
    if (!record) return
    const reviews = (record.reviews ?? []).filter(item => item.candidateIndex !== record.selectedIndex || item.conceptId !== conceptId)
    if (status) reviews.push({ candidateIndex: record.selectedIndex, conceptId, status })
    const next = { ...record, reviews }
    setRecord(next)
    await persistRecord(next)
  }

  const continueFromFeedback = () => {
    if (!record?.result.semanticPlan) return
    const nextPlan = feedbackPlan(record.result.semanticPlan, record.reviews ?? [], record.selectedIndex)
    restore(record)
    setPlan(nextPlan)
    setNotice(`已按当前候选的核对结果提高${nextPlan.context?.focusConceptIds.length ?? 0}项条件的优先级，相关知识推荐也已更新。请预览后再生成比较。`)
    document.getElementById('semantic-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const result = record?.result
  const candidates = result?.candidates?.length ? result.candidates : result?.generatedImage ? [{ image: result.generatedImage, seed: result.seed ?? 0 }] : []
  const selectedCandidate = candidates[record?.selectedIndex ?? 0]

  return <div className="page-wrap co-create">
    <header className="page-title-block split-title"><div><p className="eyebrow">KNOWLEDGE-DRIVEN CO-CREATION</p><h1>数字绣案</h1></div>
      <p>从有出处的母纹出发，编排主体、结构、色彩与设计意向。查看生成条件，比较候选，再带着记录继续创作。</p></header>

    <p className="co-draft-status" role="status">{draftStatus}</p>
    <section className="co-context-bar" aria-label="创作方向与推荐">
      <div><label className="co-input-label">创作方向<select aria-label="创作方向" disabled={busy} value={activePlan.context.goal}
        onChange={event => updateContext({ goal: event.target.value as SemanticContext['goal'] })}>
        {CREATIVE_GOALS.map(goal => <option key={goal.id} value={goal.id}>{goal.label}</option>)}
      </select></label><p className="co-help">{CREATIVE_GOALS.find(goal => goal.id === activePlan.context.goal)?.hint}。方向与中文意图先影响推荐，采纳的概念才进入生成条件。</p>
      <details className="concept-details"><summary>推荐对照设置</summary>
        <label className="co-input-label">推荐方法<select aria-label="推荐方法" disabled={busy} value={activePlan.context.algorithm}
          onChange={event => updateContext({ algorithm: event.target.value as SemanticContext['algorithm'] })}>
          <option value="context-walk-v2">上下文游走 · 累计访问</option><option value="context-walk-v1">均匀终点分布（对照）</option><option value="restart-v1">原有关系传播（对照）</option>
        </select></label>
        <p>固定标注数据，比较两种推荐的差异；排序分数不代表文化准确率。</p>
        {activePlan.context.excludedConceptIds.length > 0 && <button type="button" className="co-text-button" disabled={busy}
          onClick={() => updateContext({ excludedConceptIds: [] })}>恢复暂不推荐的概念（{activePlan.context.excludedConceptIds.length}）</button>}
      </details></div>
      <div><label className="co-input-label">用中文描述创作意图<textarea aria-label="用中文描述创作意图" value={brief} maxLength={600} rows={3} disabled={busy}
        onChange={event => { setBrief(event.target.value); setPlan({ ...plan, promptRealization: undefined }) }} placeholder="例如保留对称的蝴蝶主体，强调红蓝配色和清晰轮廓。" /></label>
        <button type="button" className="button secondary" disabled={busy || serviceState !== 'online' || !compatibleService || !health?.language?.available} onClick={refinePlan}>{assisting === 'language' ? '本机Qwen正在整理…' : '用本机模型整理意图'}</button>
        <p className="co-help">推荐会匹配正向关键词；复杂意图可由本机模型整理为英文条件，检查并采纳后生效。</p>
      </div>
    </section>
    <div className="co-workspace">
      <section className="co-source" aria-label="参考母纹">
        <h2>创作起点</h2>
        <label className="co-input-label">关联母纹资料<select aria-label="选择母纹" value={patternId} onChange={event => selectPattern(event.target.value)} disabled={busy}>
          {patterns.map(item => <option key={item.id} value={item.id}>{item.id} · {item.name}</option>)}
        </select></label>
        <img className="co-reference-image" src={referenceImage?.image ?? currentElement?.image ?? pattern.image} alt={referenceImage?.name ?? currentElement?.name ?? pattern.name} />
        <h3>{referenceImage?.name ?? currentElement?.name ?? pattern.name}</h3><p className="co-help">{referenceImage ? `已采纳本机读图建议 · ${referenceImage.analysisModel ?? '视觉参考'}` : currentElement ? currentElement.use : pattern.visual_description}</p>
        <button type="button" className="button secondary co-analyze-button" onClick={() => void analyzeImage()} disabled={busy || serviceState !== 'online' || !compatibleService || !health?.vision?.available}>分析这张参考图</button>
        <label className="co-input-label">上传参考图<input aria-label="上传参考图" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || serviceState !== 'online' || !compatibleService || !health?.vision?.available}
          onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void analyzeImage(file) }} /></label>
        <p className="co-help">本机分析主体、构图与颜色，确认建议后进入画布。PNG、JPEG或WebP，最大5MB。</p>
        <details className="co-source-evidence"><summary>{meaning.label} · 查看文化说明</summary><p>{meaning.content}</p>
          <SourceReferences sourceIds={pattern.source_ids} />
          <Link className="co-text-button" to={`/patterns/${pattern.id}`} target="_blank" rel="noreferrer">打开母纹资料</Link>
        </details>
        <fieldset className="co-fieldset" disabled={busy}><legend>纹样元参考</legend>
          <div className="co-elements">{availableElements.map(element => <button type="button" key={element.id} aria-pressed={element.id === elementId}
            onClick={() => {
              setElementId(element.id === elementId ? '' : element.id); setReferenceImage(undefined); setProposal(undefined); setPendingReference(undefined)
              setReferenceEditor(initialReferenceEditor())
              if (referenceEditor.enabled || referenceEditor.preparation) setNotice('纹样元已变化，旧结构参考已清除，请重新准备并采用。')
            }}>
            <img src={element.image} alt="" /><span>{element.name}</span>
          </button>)}</div>
          <p className="co-help">{availableElements.length ? '纹样元用于视觉对照，生成描述可在语义画布中编辑。' : '可前往析纹台提取独立纹样元。'}</p>
        </fieldset>
        <Link className="co-text-button" to={`/deconstruct?pattern=${pattern.id}`}>打开智能析纹台 →</Link>
      </section>

      <SemanticCanvas plan={activePlan} onChange={next => setPlan({ ...next, promptRealization: undefined })} disabled={busy} />
      <KnowledgeRecommendations recommendations={recommendations} query={query} onQuery={setQuery}
        onAdd={addConcept} onDismiss={id => updateContext({ excludedConceptIds: [...new Set([...activePlan.context.excludedConceptIds, id])] })} disabled={busy} counts={graph} />
    </div>

    <ReferenceConditioningPanel pattern={pattern} element={currentElement} value={referenceEditor} onChange={setReferenceEditor}
      onAccept={acceptReference} onBusy={setPreparingReference} available={serviceState === 'online' && Boolean(health?.reference_conditioning?.available)} disabled={busy} />

    <section className="co-generation" aria-label="生成设置">
      <div className="co-section-heading"><h2>提示词与生成</h2><span>SD1.5 · 侗绣 LoRA</span></div>
      <div className="co-service-status" data-state={serviceState} role="status">
        <div><strong>{serviceState === 'checking' ? '正在连接本机服务' : serviceState === 'offline' ? '本机服务未连接' : health?.runtime_available === false ? '生成权重未就绪' : `本机服务已连接 · ${health?.model_state === 'ready' ? '生成模型已加载' : '模型按需加载'}`}</strong>
          <p>{serviceState === 'offline' ? healthError : `语言整理${health?.language?.available ? '可用' : '未就绪'} · 参考图分析${health?.vision?.available ? '可用' : '未就绪'}`}</p>
          {serviceState === 'online' && !compatibleService && <p className="concept-warning">当前生成服务版本较旧，请关闭原生成服务并重新运行 scripts/start-lora.ps1，以保留新的推荐依据和核对记录。</p>}
          {serviceState === 'online' && health?.active_task && <p>本机正在{({ generation: '生成图像', language: '整理语言', vision: '分析参考图' })[health.active_task]}{health.queued_tasks ? `，另有${health.queued_tasks}项任务等待` : ''}。</p>}
          {(serviceState === 'offline' || health?.runtime_available === false) && <p>请运行项目中的 scripts/start-lora.ps1，再重试连接。</p>}
        </div><button type="button" className="co-text-button" onClick={() => void refreshHealth()}>重试连接</button>
      </div>
      <fieldset disabled={busy} className="co-fieldset co-generation-fields">
        <div><label className="co-input-label">补充描述（中文 / English）<textarea aria-label="补充描述（中文 / English）" value={plan.extraPrompt} maxLength={500} rows={3}
          onChange={event => setPlan({ ...plan, extraPrompt: event.target.value, extraPromptTranslation: undefined, promptRealization: undefined })} placeholder="中文、英文或混合均可，例如：米白色背景，保留 red butterfly，边缘留白" /></label>
          <p className="co-help">中文或中英混合内容会在预览、生成时由本机模型自动翻译。原文会保留，可在实际提示词中核对译文；纯英文可直接使用。</p></div>
        <div className="co-generation-options">
          <label className="co-input-label">生成策略<select aria-label="生成策略" value={generationProfile}
            onChange={event => setGenerationProfile(event.target.value as GenerationProfile)}>
            {Object.entries(generationProfileLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="co-input-label">应用载体<select aria-label="应用载体" value={carrier} onChange={event => setCarrier(event.target.value)}>
            {!PRODUCT_CATALOG.some(product => product.label === carrier) && <option value={carrier}>{carrier}</option>}
            {PRODUCT_CATALOG.map(product => <option key={product.id} value={product.label}>{product.label}</option>)}</select></label>
          <label className="co-input-label">随机种子<input aria-label="随机种子" inputMode="numeric" value={seed} maxLength={10} onChange={event => setSeed(event.target.value)} placeholder="留空自动选择" /></label>
          <button className="co-text-button" type="button" onClick={() => setSeed('')}>下一轮重新随机</button>
          <label className="co-input-label">侗绣风格强度 {loraScale.toFixed(2)}<input aria-label="侗绣风格强度" type="range" min="0" max="1" step="0.05" value={loraScale} onChange={event => setLoraScale(Number(event.target.value))} /></label>
          <p className="co-help">强度控制LoRA对图像的影响，0使用基础模型。可固定种子比较不同强度下的主体与纹理。</p>
          <p className="co-help">每轮3张候选，512 × 512，30步。生成后沿用已选候选的种子，方便比较条件调整。</p>
        </div>
      </fieldset>
      <div className="co-actions"><button type="button" className="button secondary" onClick={composePlan} disabled={busy || serviceState !== 'online' || !compatibleService || !health?.language?.available}>用本机模型编排整张画布</button>
        <button type="button" className="button secondary" onClick={previewPrompt} disabled={busy || serviceState !== 'online' || !compatibleService || referenceBlocked}>{previewing ? '正在编排…' : '预览实际提示词'}</button>
        <button type="button" className="button primary" onClick={generate} disabled={busy || !canGenerate}>{generating ? '正在生成三张候选…' : '生成三张候选'}</button></div>
      {plan.promptRealization && <p className="co-help">已采纳整图编排 · {plan.promptRealization.model}。修改条件后可重新编排。<button type="button" className="co-text-button" disabled={busy} onClick={() => setPlan({ ...plan, promptRealization: undefined })}>恢复逐项编排</button></p>}
      <p className="co-live" role="status" aria-live="polite">{generating ? '本机正在准备条件并生成图像，中文补充描述会先自动翻译。' : previewing ? '正在编排提示词，中文补充描述会先由本机模型翻译。' : assisting === 'vision' ? '正在本机分析参考图，完成后可检查并采纳建议。' : assisting === 'language' ? '正在本机整理中文意图，完成后可检查并采纳建议。' : assisting === 'composition' ? '本机模型正在结合主体关系、优先级和创作意图编排描述。' : notice}</p>
      {error && <p role="alert" className="co-error">{error}</p>}
      {preview && <div className="prompt-preview"><div className="co-section-heading"><h3>编排后的提示词</h3><span>{previewKey === draftKey ? '对应当前条件' : '条件已修改，请重新预览'}</span></div>
        <p className="prompt-text">{preview.prompt}</p>
        {preview.semanticPlan?.extraPromptTranslation && <details className="concept-dispositions"><summary>查看补充描述原文与译文</summary>
          <p>原文 · {preview.semanticPlan.extraPromptTranslation.sourceText}</p>
          <p>译文 · {preview.semanticPlan.extraPromptTranslation.text}</p>
          <p>本机翻译 · {preview.semanticPlan.extraPromptTranslation.model}</p>
        </details>}
        <PlanChecks checks={preview.planChecks ?? []} labels={new Map((preview.semanticPlan?.concepts ?? []).map(concept => [concept.id, concept.label]))} />
        {preview.warnings.length > 0 && <ul className="co-warnings">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        <details><summary>负向提示词与编排信息</summary><p className="prompt-text">{preview.negativePrompt || '无'}</p>
          <p>{generationProfileLabels[preview.generationProfile ?? 'standard']}</p>
          <p>{preview.compilerVersion}{preview.promptTokenCount !== undefined ? ` · ${preview.promptTokenCount}/${preview.tokenLimit ?? '—'} tokens` : ''}</p></details>
        {preview.conceptDispositions && <details className="concept-dispositions"><summary>逐项查看条件采用情况</summary>{preview.conceptDispositions.map(item => <p key={item.id}>
          <strong>{plan.concepts.find(concept => concept.id === item.id)?.label ?? item.id}</strong> · {item.status === 'applied' ? '已采用' : '已省略'} · {item.reason}</p>)}</details>}
      </div>}
    </section>

    {proposal && <div ref={proposalPanel}><AIPlanReview proposal={proposal.value} kind={proposal.kind} disabled={busy} onAccept={acceptProposal}
      onDismiss={() => { setProposal(undefined); setPendingReference(undefined) }} /></div>}

    {record && result && <section className="co-results" aria-label="本轮创作结果">
      <div className="co-section-heading"><h2>{result.mode === 'demo' ? '素材应用演示' : '本轮生成结果'}</h2><span>{new Date(result.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 北京时间</span></div>
      <div className="co-comparison"><figure><img src={result.referencePreparation?.init_image ?? result.referenceImage?.image ?? result.element?.image ?? result.pattern.image} alt="本轮参考纹样" /><figcaption>{result.referencePreparation ? `结构与配色底图 · ${result.referencePreparation.source.name}` : `参考 · ${result.referenceImage?.name ?? result.pattern.id}`}</figcaption></figure>
        <figure><img src={selectedCandidate?.image} alt="当前选中的创作结果" /><figcaption>候选 {record.selectedIndex + 1} · 种子 {selectedCandidate?.seed ?? '—'}</figcaption></figure></div>
      <div className="co-candidates" aria-label="选择生成候选">{candidates.map((candidate, index) => <button key={index} type="button" aria-pressed={index === record.selectedIndex}
        disabled={busy} onClick={() => void chooseCandidate(index)}><img src={candidate.image} alt={`候选${index + 1}`} /><span>候选 {index + 1} · {candidate.seed}</span></button>)}</div>
      <details className="co-result-conditions"><summary>查看本轮实际条件与参数</summary><p className="prompt-text">{result.prompt}</p>
        <p>{generationProfileLabels[result.generationProfile ?? 'standard']} · {result.model ?? '本地演示'} · 强度 {result.loraScale ?? 1} · {result.steps ?? '—'} 步 · guidance {result.guidance ?? '—'} · {result.inferenceSeconds ?? '—'} 秒</p>
        {result.referenceConditioning && <p>结构参考 · {result.referenceConditioning.method === 'canny-img2img' ? '轮廓约束与参考图重绘' : '参考图重绘'} · 重绘强度 {result.referenceConditioning.strength} · 轮廓强度 {result.referenceConditioning.control_scale} · {result.referenceConditioning.embroidery_detail ? '增强针线质感' : '沿用画布质感条件'}</p>}
        {result.referencePreparation && <p>参考材质 · {result.referencePreparation.settings.texture_mode === 'stitched' ? '针线材质引导' : '沿用参考纹理'}{result.referencePreparation.material ? ` · ${result.referencePreparation.material.version}` : ''}</p>}
        {selectedCandidate?.denoisingSteps !== undefined && <p>当前候选实际去噪 {selectedCandidate.denoisingSteps} 步</p>}
        {result.conditioningModel && <p>轮廓模型 · {result.conditioningModel.name} · {result.conditioningModel.revision}</p>}
        {result.assistance && <p>本轮模型辅助 {result.assistance.model} · {{ vision: '参考图分析', language: '意图整理', composition: '整图编排' }[result.assistance.kind]}</p>}
        {result.warnings?.map((warning, index) => <p key={index} className="concept-warning">{warning}</p>)}
        {result.semanticPlan && <p>进入提示词的概念 {result.semanticPlan.concepts.filter(concept => result.appliedConceptIds ? result.appliedConceptIds.includes(concept.id) : concept.enabled).map(concept => concept.label).join('、') || '无'}</p>}
      </details>
      <ConditionReview record={record} disabled={busy} onReview={(id, status) => void reviewConcept(id, status)} onContinue={continueFromFeedback} />
      <label className="co-input-label">迭代批注<textarea aria-label="迭代批注" value={record.note} maxLength={2000} rows={3} disabled={busy}
        onChange={event => setRecord({ ...record, note: event.target.value })} placeholder="记录值得保留的结构，以及下一轮要修改的部分…" /></label>
      <div className="co-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void persistRecord(record)}>{savingRecord ? '正在保存…' : '保存批注'}</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => restore(record)}>以本轮条件继续</button>
        <button type="button" className="button secondary" onClick={() => downloadManifest(record)}>导出创作记录</button>
        <a className="button secondary" href={selectedCandidate?.image} download={`${result.id}-${record.selectedIndex + 1}.png`}>下载当前纹样</a>
        <Link className="button primary" to={`/workshop?pattern=${result.pattern.id}&carrier=${carrierMap[result.carrier] ?? 'poster'}&source=session`} onClick={event => { if (!persistWorkshop(record)) event.preventDefault() }}>进入文创 3D 贴图</Link>
        <Link className="co-text-button" to={`/museum?pattern=${result.pattern.id}&carrier=${carrierMap[result.carrier] ?? 'poster'}&source=session`} onClick={event => { if (!persistWorkshop(record)) event.preventDefault() }}>进入博物馆展陈 →</Link>
      </div>
    </section>}

    {record && <IterationComparison current={record} history={history} baselineId={baselineId} onBaseline={setBaselineId} disabled={busy} />}

    <section className="co-history" aria-label="创作历史"><div className="co-section-heading"><h2>创作历史</h2><span>当前浏览器保存最近12轮</span></div>
      {storageNotice && <p className="co-error" role="status">{storageNotice}</p>}
      {history.length ? <div className="co-history-grid">{history.map(saved => {
        const image = saved.result.candidates?.[saved.selectedIndex]?.image ?? saved.result.generatedImage
        return <button type="button" key={saved.result.id} disabled={busy} aria-pressed={record?.result.id === saved.result.id} onClick={() => restore(saved)}>
          <img src={image} alt={`${saved.result.pattern.id}历史作品`} /><span><strong>{saved.result.pattern.id} · {saved.result.mode === 'demo' ? '演示' : '生成'}</strong>
            <small>{new Date(saved.result.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</small><small>{saved.note || '点击恢复条件并继续创作'}</small></span>
        </button>
      })}</div> : <p className="co-help">完成第一轮生成后，可在这里恢复条件、查看批注并继续迭代。</p>}
    </section>
  </div>
}
