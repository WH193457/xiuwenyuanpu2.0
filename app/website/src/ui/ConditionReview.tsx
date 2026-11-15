import type { PlanCheck } from '../domain'
import type { CreationRecord } from '../creationHistory'
import type { ConceptReview } from '../iterationFeedback'
import { isConceptActive } from '../knowledge'

export function PlanChecks({ checks, labels }: { checks: PlanCheck[]; labels: Map<string, string> }) {
  if (!checks.length) return null
  return <div className="co-plan-checks" aria-label="生成条件检查">
    <h3>生成条件检查</h3>
    <p className="co-help">检查编排关系、资料标记与条件取舍。文化内容仍需查阅原文核实。</p>
    {checks.map((check, index) => <div className="co-plan-check" data-severity={check.severity} key={`${check.code}-${index}`}>
      <p>{check.message}</p><small>{check.conceptIds.map(id => labels.get(id) ?? id).join(' · ')}</small>
    </div>)}
  </div>
}

export function ConditionReview({ record, disabled, onReview, onContinue }: {
  record: CreationRecord
  disabled: boolean
  onReview: (conceptId: string, status: ConceptReview['status'] | '') => void
  onContinue: () => void
}) {
  const plan = record.result.semanticPlan
  if (!plan || record.result.mode !== 'lora') return null
  const candidate = record.result.candidates?.[record.selectedIndex]
  const reviews = (record.reviews ?? []).filter(item => item.candidateIndex === record.selectedIndex)
  const pending = reviews.filter(item => item.status !== 'met').length
  const concepts = plan.concepts.filter(item => isConceptActive(plan, item))
  const applied = new Set(record.result.appliedConceptIds ?? [])
  return <section className="co-condition-review" aria-label="逐项核对生成结果">
    <div className="co-section-heading"><h3>逐项核对 · 候选 {record.selectedIndex + 1}</h3><span>已核对 {reviews.length}/{concepts.length}</span></div>
    <p className="co-help">请对照这张候选判断。每张图分别保存，未核对的项目保持空白。下一轮可提高未满足条件的优先级，并据此调整知识推荐。</p>
    {candidate?.structureMetrics?.length ? <div className="co-structure-metrics">
      <h4>图像结构参考</h4>
      {candidate.structureMetrics.map(metric => <p key={metric.kind}><strong>{metric.label} · {(metric.score * 100).toFixed(1)}%</strong><br />{metric.note}</p>)}
      <p>这些数值反映像素差异，不是生成成功率或文化准确率。</p>
    </div> : null}
    <div className="co-review-grid">{concepts.map(concept => <label className="co-review-item" key={concept.id}>
      <span>{concept.label}<small>{applied.has(concept.id) ? '已进入提示词' : '本轮未确认采用，请查看条件记录'}</small></span>
      <select aria-label={`核对${concept.label}`} disabled={disabled} value={reviews.find(item => item.conceptId === concept.id)?.status ?? ''}
        onChange={event => onReview(concept.id, event.target.value as ConceptReview['status'] | '')}>
        <option value="">未核对</option><option value="met">已满足</option><option value="partial">部分满足</option><option value="missed">未满足</option>
      </select>
    </label>)}</div>
    <button className="button secondary" type="button" disabled={disabled || pending === 0} onClick={onContinue}>根据核对结果调整下一轮{pending ? `（${pending}项）` : ''}</button>
    <p className="co-help">调整以本轮保存的条件和当前候选种子为起点。优先级影响提示词取舍，图像是否改善需继续比较。</p>
  </section>
}
