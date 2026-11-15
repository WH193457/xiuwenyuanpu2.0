import { contextFor, isConceptActive, type SemanticPlan } from './knowledge'

export interface ConceptReview {
  candidateIndex: number
  conceptId: string
  status: 'met' | 'partial' | 'missed'
}

/** Human observations are scoped to one candidate. No automatic semantic claims. */
export function feedbackPlan(plan: SemanticPlan, reviews: ConceptReview[], candidateIndex: number): SemanticPlan {
  const next = structuredClone(plan)
  delete next.promptRealization
  const focus = new Set(reviews.filter(review => review.candidateIndex === candidateIndex && review.status !== 'met').map(review => review.conceptId))
  const activeIds = new Set(next.concepts.filter(item => isConceptActive(next, item)).map(item => item.id))
  next.concepts = next.concepts.map(item => focus.has(item.id) && activeIds.has(item.id) ? { ...item, priority: 3 } : item)
  next.context = { ...contextFor(next), focusConceptIds: [...focus].filter(id => activeIds.has(id)) }
  return next
}
