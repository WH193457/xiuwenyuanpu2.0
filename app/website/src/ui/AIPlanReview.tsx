import type { AIPlanProposal, PlanAssistance } from '../domain'
import { DIMENSIONS } from '../knowledge'

export function AIPlanReview({ proposal, kind, onAccept, onDismiss, disabled }: {
  proposal: AIPlanProposal
  kind: PlanAssistance['kind']
  onAccept: () => void
  onDismiss: () => void
  disabled: boolean
}) {
  return <section className="ai-plan-review" aria-label="AI整理建议">
    <div className="co-section-heading"><h2>{{ vision: '参考图分析建议', language: '中文意图整理建议', composition: '整张画布编排建议' }[kind]}</h2><span>{proposal.model} · {proposal.elapsedSeconds.toFixed(1)}秒</span></div>
    <p className="co-help">核对主体、属性归属及英文含义，采纳后进入提示词编排。最终采用情况可通过预览查看。</p>
    {proposal.semanticPlan.promptRealization && <div className="ai-proposal-concepts">{proposal.semanticPlan.promptRealization.groups.map(group => <article key={group.rootId}>
      <h3>{group.conceptIds.map(id => proposal.semanticPlan.concepts.find(concept => concept.id === id)?.label ?? '补充描述').join(' · ')}</h3>
      <p>{group.text}</p>
      <small>{group.origin === 'preserved' ? '保留原有单项英文条件' : '本机模型编排'}</small>
    </article>)}</div>}
    <details open={kind !== 'composition'}><summary>查看逐项条件与来源关系</summary>
    <div className="ai-proposal-concepts">{proposal.semanticPlan.concepts.map(concept => <article key={concept.id}>
      <span>{DIMENSIONS.find(dimension => dimension.id === concept.dimension)?.label}</span><h3>{concept.label}</h3>
      {(!concept.promptText || !concept.label.includes(concept.promptText)) && <p>{concept.promptText || '保留为参考说明'}</p>}
      {concept.parentId && <small>关联主体 {proposal.semanticPlan.concepts.find(parent => parent.id === concept.parentId)?.label}</small>}
    </article>)}</div>
    {proposal.semanticPlan.extraPrompt && <p className="prompt-text">{proposal.semanticPlan.extraPrompt}</p>}</details>
    {proposal.warnings.length > 0 && <ul className="co-warnings">{proposal.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    <div className="co-actions"><button className="button primary" type="button" disabled={disabled} onClick={onAccept}>采纳并更新画布</button><button className="button secondary" type="button" disabled={disabled} onClick={onDismiss}>关闭建议</button></div>
  </section>
}
