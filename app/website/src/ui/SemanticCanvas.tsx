import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { canAssignParent, DIMENSIONS, RELATION_LABELS, isConceptActive, type ConceptRecommendation, type SemanticConcept, type SemanticDimension, type SemanticPlan } from '../knowledge'
import sourceCatalogue from '../data/sources.json'

const evidenceLabels = {
  visual: '视觉标注',
  supported: '资料支持',
  cautious: '谨慎表述',
  neutral: '中性设计意向',
  user: '自定义设计条件',
}

export function SourceReferences({ sourceIds }: { sourceIds: string[] }) {
  if (!sourceIds.length) return null
  return <div className="concept-source-catalogue">
    {sourceIds.map(id => {
      const source = sourceCatalogue.sources.find(item => item.id === id)
      if (!source) return <p key={id}>{id} · 来源信息待补充</p>
      return <details key={id} className="concept-details">
        <summary>{source.id} · {source.title}</summary>
        <p>{source.author} · {source.year} · {source.type}</p>
        <p>标注适用范围 {source.scope}</p>
        <a href={source.url} target="_blank" rel="noreferrer">打开资料原文 ↗</a>
      </details>
    })}
  </div>
}

function Provenance({ concept }: { concept: SemanticConcept }) {
  return <div className="concept-provenance">
    <p>{evidenceLabels[concept.evidence]}</p>
    {concept.patternIds.length > 0 && <div className="concept-source-links">
      <span>参考母纹</span>
      {concept.patternIds.map(id => <Link key={id} to={`/patterns/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">{id}</Link>)}
    </div>}
    <SourceReferences sourceIds={concept.sourceIds} />
    {concept.annotations?.length ? <details className="concept-details"><summary>逐条原始标注（{concept.annotations.length}）</summary>
      <p>原始标注与当前编辑条件分别保留，以下内容不随编辑改写。</p>
      {concept.annotations.map((row, index) => <p key={`${row.patternId}-${row.field}-${index}`}>
        <Link to={`/patterns/${row.patternId}`} target="_blank" rel="noreferrer">{row.patternId}</Link> · {RELATION_LABELS[row.field]} · {row.value}<br />
        {evidenceLabels[row.evidence]} · {row.sourceIds.join('、') || '未关联资料来源'}
      </p>)}
    </details> : null}
  </div>
}

interface SemanticCanvasProps {
  plan: SemanticPlan
  onChange: (plan: SemanticPlan) => void
  disabled?: boolean
}

function ConceptHierarchy({ plan }: { plan: SemanticPlan }) {
  const renderBranch = (concept: SemanticConcept, visited: Set<string>) => {
    if (visited.has(concept.id)) return null
    const next = new Set([...visited, concept.id])
    const children = plan.concepts.filter(item => item.parentId === concept.id)
    return <li key={concept.id} data-active={isConceptActive(plan, concept)}>
      <span>{concept.label} <small>{concept.priority === 3 ? '重点' : concept.priority === 2 ? '常规' : '辅助'}{!isConceptActive(plan, concept) ? ' · 暂停' : ''}</small></span>
      {children.length > 0 && <ul>{children.map(child => renderBranch(child, next))}</ul>}
    </li>
  }
  const roots = plan.concepts.filter(item => !item.parentId)
  return <details className="co-hierarchy"><summary>查看主体与条件层级</summary>
    <p className="co-help">下属条件随所属主体编排；暂停主体也会暂停下属条件。可在卡片中修改关联关系。</p>
    <ul>{roots.map(root => renderBranch(root, new Set()))}</ul>
  </details>
}

export function SemanticCanvas({ plan, onChange, disabled = false }: SemanticCanvasProps) {
  const [customName, setCustomName] = useState('')
  const [customEnglish, setCustomEnglish] = useState('')
  const [customDimension, setCustomDimension] = useState<SemanticDimension>('subject')
  const [formError, setFormError] = useState('')
  const [relationNotice, setRelationNotice] = useState('')

  const updateConcept = (id: string, change: Partial<SemanticConcept>) => {
    onChange({ ...plan, concepts: plan.concepts.map(concept => concept.id === id ? { ...concept, ...change } : concept) })
  }

  const removeConcept = (concept: SemanticConcept) => {
    const childCount = plan.concepts.filter(item => item.parentId === concept.id).length
    onChange({ ...plan, concepts: plan.concepts.filter(item => item.id !== concept.id).map(item =>
      item.parentId === concept.id ? { ...item, parentId: undefined } : item) })
    setRelationNotice(childCount ? `已移除“${concept.label}”，其${childCount}个关联条件已改为全局条件。` : `已移除“${concept.label}”。`)
  }

  const addCustom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled) return
    if (plan.concepts.length >= 24) {
      setFormError('最多保留24个概念，请先移除不需要的条件。')
      return
    }
    if (!customName.trim()) {
      setFormError('请填写概念名称或中文创作描述。')
      return
    }
    const concept: SemanticConcept = {
      id: `user:${crypto.randomUUID()}`,
      dimension: customDimension,
      label: customName.trim(),
      promptText: customEnglish.trim(),
      priority: 2,
      enabled: true,
      patternIds: [],
      sourceIds: [],
      evidence: 'user',
    }
    onChange({ ...plan, concepts: [...plan.concepts, concept] })
    setCustomName('')
    setCustomEnglish('')
    setFormError('')
  }

  return <section className="semantic-editor" aria-labelledby="semantic-title">
    <div className="co-section-heading"><h2 id="semantic-title">语义画布</h2><span>{plan.concepts.length}/24</span></div>
    <p className="co-help">勾选创作概念，将色彩、姿态等条件关联到具体主体。中文想法可通过本地模型整理，生成描述可展开修改。</p>
    <ConceptHierarchy plan={plan} />
    <div className="semantic-groups">
      {DIMENSIONS.map(dimension => {
        const concepts = plan.concepts.filter(concept => concept.dimension === dimension.id)
        return <section className="semantic-group" data-dimension={dimension.id} key={dimension.id} aria-label={dimension.label}>
          <h3>{dimension.label}</h3>
          {concepts.length === 0 && <p className="semantic-empty">可从知识推荐添加，或在下方自定义。</p>}
          <div className="semantic-concepts">
            {concepts.map(concept => <article className={`semantic-concept ${isConceptActive(plan, concept) ? 'is-enabled' : 'is-muted'}`} key={concept.id}
              data-parent={concept.parentId} style={concept.parentId ? { marginInlineStart: 12 } : undefined}>
              <div className="concept-topline">
                <label className="concept-toggle">
                  <input type="checkbox" checked={concept.enabled} disabled={disabled} onChange={event => updateConcept(concept.id, { enabled: event.target.checked })} />
                  <span>{concept.label}</span>
                </label>
                <button type="button" className="co-text-button concept-remove" disabled={disabled} aria-label={`移除${concept.label}`} onClick={() => removeConcept(concept)}>移除</button>
              </div>
              <label className="co-input-label">关联主体
                <select aria-label={`${concept.label}的关联主体`} value={concept.parentId ?? ''} disabled={disabled}
                  onChange={event => updateConcept(concept.id, { parentId: event.target.value || undefined })}>
                  <option value="">全局条件</option>
                  {concept.parentId && !canAssignParent(plan, concept.id, concept.parentId) &&
                    <option value={concept.parentId} disabled>{plan.concepts.find(item => item.id === concept.parentId)?.label ?? '关联主体已失效'} · 当前停用</option>}
                  {plan.concepts.filter(item => canAssignParent(plan, concept.id, item.id)).map(item =>
                    <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              {concept.parentId && <p className="concept-relation" style={{ margin: '4px 0', fontSize: 11, color: 'var(--cyan)' }}>
                ↳ 用户关联至“{plan.concepts.find(item => item.id === concept.parentId)?.label ?? concept.parentId}”
              </p>}
              <div className="concept-settings">
                <label>优先级
                  <select aria-label={`${concept.label}的优先级`} value={concept.priority} disabled={disabled} onChange={event => updateConcept(concept.id, { priority: Number(event.target.value) as 1 | 2 | 3 })}>
                    <option value={1}>辅助</option><option value={2}>常规</option><option value={3}>重点</option>
                  </select>
                </label>
                <span>{evidenceLabels[concept.evidence]}</span>
              </div>
              <details className="concept-details">
                <summary>{concept.promptText ? '生成描述与来源' : '补充英文描述'}</summary>
                <label className="co-input-label">概念名称或中文描述
                  <textarea aria-label={`${concept.label}的概念名称`} rows={2} maxLength={240} value={concept.label} disabled={disabled}
                    onChange={event => { if (event.target.value.trim()) updateConcept(concept.id, { label: event.target.value, evidence: 'user' }) }} />
                </label>
                <label className="co-input-label">生成描述（英文）
                  <textarea aria-label={`${concept.label}的英文生成描述`} rows={2} maxLength={240} value={concept.promptText} disabled={disabled} placeholder="例如 paired butterfly wings" onChange={event => updateConcept(concept.id, { promptText: event.target.value, evidence: 'user' })} />
                </label>
                <Provenance concept={concept} />
              </details>
              {concept.enabled && !isConceptActive(plan, concept) && <p className="concept-warning">关联主体已停用，该条件将随主体暂停。</p>}
              {concept.enabled && !concept.promptText.trim() && <p className="concept-warning">可用本地模型整理为生成描述，也可展开手动补充。</p>}
            </article>)}
          </div>
        </section>
      })}
    </div>
    {relationNotice && <p className="co-help" role="status">{relationNotice}</p>}
    <details className="semantic-custom">
      <summary>添加自定义概念</summary>
      <form onSubmit={addCustom}>
        <fieldset disabled={disabled || plan.concepts.length >= 24}>
          <div className="custom-concept-row">
            <label className="co-input-label">维度<select value={customDimension} onChange={event => setCustomDimension(event.target.value as SemanticDimension)}>{DIMENSIONS.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
            <label className="co-input-label">概念名称或中文描述<textarea aria-label="概念名称" value={customName} maxLength={240} rows={2} required placeholder="例如 两只红色蝴蝶相向排列，周围留白" onChange={event => setCustomName(event.target.value)} /></label>
          </div>
          <label className="co-input-label">英文生成描述<input aria-label="英文生成描述" value={customEnglish} maxLength={240} placeholder="可选，可先填写中文概念后用模型整理" onChange={event => setCustomEnglish(event.target.value)} /></label>
          <button className="button secondary" type="submit">加入画布</button>
        </fieldset>
        {plan.concepts.length >= 24 && <p className="co-help">画布已达到24个概念。</p>}
        {formError && <p className="co-error" role="alert">{formError}</p>}
      </form>
    </details>
  </section>
}

interface KnowledgeRecommendationsProps {
  recommendations: ConceptRecommendation[]
  query: string
  onQuery: (query: string) => void
  onAdd: (concept: SemanticConcept) => void
  onDismiss?: (conceptId: string) => void
  disabled?: boolean
  counts: { patternCount: number; conceptCount: number; edgeCount: number }
}

export function KnowledgeRecommendations({ recommendations, query, onQuery, onAdd, onDismiss, disabled = false, counts }: KnowledgeRecommendationsProps) {
  return <aside className="knowledge-panel" aria-labelledby="knowledge-title">
    <div className="co-section-heading"><h2 id="knowledge-title">知识推荐</h2></div>
    <p className="co-help">{counts.patternCount}件母纹 · {counts.conceptCount}个概念 · {counts.edgeCount}条标注关系</p>
    <label className="co-input-label">检索相关概念<input type="search" value={query} disabled={disabled} maxLength={120} placeholder="蝴蝶、对称、blue…" onChange={event => onQuery(event.target.value)} /></label>
    <p className="co-help">推荐随创作方向、正向意图关键词和画布更新。关系来自同一母纹的标注，不代表文化含义已得到证实。</p>
    <div className="knowledge-recommendations">
      {recommendations.map(({ concept, reason, trace }) => <article className="knowledge-recommendation" key={concept.id}>
        <p className="recommendation-dimension">{DIMENSIONS.find(item => item.id === concept.dimension)?.label}</p>
        <h3>{concept.label}</h3>
        <p className="recommendation-reason">{reason}</p>
        <p className="recommendation-factors">{trace.factors.join(' · ')}</p>
        <details className="concept-details"><summary>查看依据</summary>
          <ol className="recommendation-path" aria-label="推荐关联路径">{trace.nodes.map((node, index) => <li key={`${node}-${index}`}>
            {node.startsWith('pattern:') ? <Link to={`/patterns/${node.slice(8)}`} target="_blank" rel="noreferrer">母纹 {node.slice(8)}</Link> : node.slice(node.indexOf(':') + 1)}
            {trace.relations[index] && <small>经{trace.relations[index].map(field => RELATION_LABELS[field]).join('、')}关联</small>}
          </li>)}</ol>
          <p>展示可核对的最短关联路径，排序还综合其他路径。{{ 'context-walk-v2': '采用随机长度游走的累计访问概率。', 'context-walk-v1': '采用均匀长度终点分布。', 'restart-v1': '采用原有推荐基线。' }[trace.algorithm]}</p>
          <Provenance concept={concept} />{concept.promptText && <p className="concept-english">{concept.promptText}</p>}</details>
        <button type="button" className="co-text-button recommendation-add" disabled={disabled} onClick={() => onAdd(concept)}>加入画布 <span aria-hidden="true">＋</span></button>
        {onDismiss && <button type="button" className="co-text-button" disabled={disabled} onClick={() => onDismiss(concept.id)}>本方案暂不推荐</button>}
      </article>)}
      {recommendations.length === 0 && <p className="co-help">{query.trim() ? `“${query.trim()}”暂无匹配的可推荐概念，可调整检索词或添加自定义条件。` : '暂无可添加的关联概念，可调整检索词或自定义条件。'}</p>}
    </div>
  </aside>
}
