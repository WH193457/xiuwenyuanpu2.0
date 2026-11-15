import { useMemo } from 'react'
import type { CreationRecord } from '../creationHistory'
import { DIMENSIONS, type SemanticConcept } from '../knowledge'

function selectedImage(record: CreationRecord) {
  return record.result.candidates?.[record.selectedIndex]?.image ?? record.result.generatedImage
}

function selectedSeed(record: CreationRecord) {
  return record.result.candidates?.[record.selectedIndex]?.seed ?? record.result.seed
}

function describe(concept: SemanticConcept, concepts: SemanticConcept[]) {
  const parent = concepts.find(item => item.id === concept.parentId)
  return `${concept.label}${parent ? ` → ${parent.label}` : ''} · ${concept.enabled ? '启用' : '停用'} · ${['', '辅助', '常规', '重点'][concept.priority]}`
}

export function IterationComparison({ current, history, baselineId, onBaseline, disabled }: {
  current: CreationRecord
  history: CreationRecord[]
  baselineId: string
  onBaseline: (id: string) => void
  disabled: boolean
}) {
  const baseline = history.find(item => item.result.id === baselineId && item.result.id !== current.result.id)
  const changes = useMemo(() => {
    const before = baseline?.result.semanticPlan?.concepts ?? []
    const after = current.result.semanticPlan?.concepts ?? []
    return {
      added: after.filter(item => !before.some(old => old.id === item.id)),
      removed: before.filter(item => !after.some(next => next.id === item.id)),
      modified: after.filter(item => {
        const old = before.find(candidate => candidate.id === item.id)
        return old && (old.enabled !== item.enabled || old.priority !== item.priority || old.parentId !== item.parentId || old.promptText !== item.promptText)
      }), before, after,
    }
  }, [baseline, current])
  const alternatives = history.filter(item => item.result.id !== current.result.id)

  return <section className="iteration-comparison" aria-label="轮次对照">
    <div className="co-section-heading"><h2>轮次对照</h2></div>
    <label className="co-input-label">选择对照轮次<select aria-label="选择对照轮次" value={baseline?.result.id ?? ''} disabled={disabled || !alternatives.length} onChange={event => onBaseline(event.target.value)}>
      <option value="">选择一轮已保存的结果</option>
      {alternatives.map(item => <option key={item.result.id} value={item.result.id}>{item.result.pattern.id} · {new Date(item.result.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 种子{selectedSeed(item) ?? '—'}</option>)}
    </select></label>
    {!baseline ? <p className="co-help">完成下一轮后，可并排比较两轮图像、概念变化和实际提示词。</p> : <>
      <div className="co-comparison">
        <figure><img src={selectedImage(baseline)} alt="对照轮次的已选纹样" /><figcaption>对照轮次 · {baseline.result.pattern.id} · 种子 {selectedSeed(baseline) ?? '—'}</figcaption></figure>
        <figure><img src={selectedImage(current)} alt="当前轮次的已选纹样" /><figcaption>当前轮次 · {current.result.pattern.id} · 种子 {selectedSeed(current) ?? '—'}</figcaption></figure>
      </div>
      <p className="co-help">{selectedSeed(baseline) === selectedSeed(current) ? '两轮使用相同随机种子。' : '两轮随机种子不同，图像变化同时受到随机性的影响。'}
        {(baseline.result.model !== current.result.model || baseline.result.steps !== current.result.steps || baseline.result.guidance !== current.result.guidance || (baseline.result.loraScale ?? 1) !== (current.result.loraScale ?? 1)) && ' 模型、风格强度或采样参数也有变化，请结合实际参数判断。'}</p>
      <p className="co-help">风格强度 {baseline.result.loraScale ?? 1} → {current.result.loraScale ?? 1}</p>
      <div className="iteration-delta">
        <h3>概念变化</h3>
        {!changes.added.length && !changes.removed.length && !changes.modified.length && <p>概念设置相同。</p>}
        {changes.added.map(item => <p key={`add-${item.id}`}><strong>新增</strong> {describe(item, changes.after)}</p>)}
        {changes.removed.map(item => <p key={`remove-${item.id}`}><strong>移除</strong> {describe(item, changes.before)}</p>)}
        {changes.modified.map(item => <div key={item.id} className="iteration-change"><strong>调整 · {DIMENSIONS.find(dimension => dimension.id === item.dimension)?.label}</strong>
          <p>{describe(changes.before.find(old => old.id === item.id)!, changes.before)} → {describe(item, changes.after)}</p>
          <p className="co-help">{changes.before.find(old => old.id === item.id)?.promptText || '无英文描述'} → {item.promptText || '无英文描述'}</p>
        </div>)}
        {baseline.result.semanticPlan?.extraPrompt !== current.result.semanticPlan?.extraPrompt && <p><strong>补充描述</strong> {baseline.result.semanticPlan?.extraPrompt || '无'} → {current.result.semanticPlan?.extraPrompt || '无'}</p>}
      </div>
      <details><summary>对照两轮实际提示词</summary><h3>对照轮次</h3><p className="prompt-text">{baseline.result.prompt}</p><h3>当前轮次</h3><p className="prompt-text">{current.result.prompt}</p></details>
    </>}
  </section>
}
