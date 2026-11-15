import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export { finiteWalkVisitDistribution, contextFor } from './src/knowledge'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { finiteWalkVisitDistribution, contextFor } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const edge = (to, weight = 1) => ({ to, weight })
const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`)
const checkDistribution = (actual, expected) => {
  close([...actual.values()].reduce((sum, value) => sum + value, 0), 1)
  for (const id of new Set([...actual.keys(), ...Object.keys(expected)])) close(actual.get(id) ?? 0, expected[id] ?? 0)
}

const chain = new Map([['A', [edge('B')]], ['B', [edge('C')]], ['C', [edge('C')]]])
const seedA = new Map([['A', 1]])
// L = 1, 2, 3 produces visits B; B,C; B,C,C. Both nodes occur 3/6 times.
checkDistribution(finiteWalkVisitDistribution(chain, seedA, 3), { B: 1 / 2, C: 1 / 2 })
checkDistribution(finiteWalkVisitDistribution(chain, seedA, 3, 'mean-step'), { B: 1 / 3, C: 2 / 3 })
checkDistribution(finiteWalkVisitDistribution(chain, seedA, 6), { B: 2 / 7, C: 5 / 7 })
checkDistribution(finiteWalkVisitDistribution(chain, seedA, 1), { B: 1 })
const cycle = new Map([['A', [edge('B')]], ['B', [edge('A')]]])
checkDistribution(finiteWalkVisitDistribution(cycle, seedA, 6), { A: 3 / 7, B: 4 / 7 })
const branching = new Map([['A', [edge('B'), edge('C', 3)]], ['B', [edge('A')]], ['C', [edge('C')]]])
checkDistribution(finiteWalkVisitDistribution(branching, seedA, 2), { A: 1 / 12, B: 1 / 6, C: 3 / 4 })
const dangling = new Map([['A', [edge('B')]], ['B', []]])
checkDistribution(finiteWalkVisitDistribution(dangling, seedA, 2), { A: 1 / 3, B: 2 / 3 })
checkDistribution(finiteWalkVisitDistribution(new Map([['A', [edge('B', 0)]]]), seedA), { A: 1 })
checkDistribution(finiteWalkVisitDistribution(new Map(), new Map([['A', 3], ['B', 1]])), { A: 3 / 4, B: 1 / 4 })
assert.equal(finiteWalkVisitDistribution(chain, new Map()).size, 0)
assert.equal(finiteWalkVisitDistribution(chain, new Map([['A', 0]])).size, 0)
assert.throws(() => finiteWalkVisitDistribution(chain, seedA, 0), RangeError)
assert.throws(() => finiteWalkVisitDistribution(chain, seedA, 1.5), RangeError)
assert.throws(() => finiteWalkVisitDistribution(chain, seedA, Infinity), RangeError)
assert.throws(() => finiteWalkVisitDistribution(chain, seedA, Number.MAX_SAFE_INTEGER + 1), RangeError)
assert.throws(() => finiteWalkVisitDistribution(chain, new Map([['A', -1]])), RangeError)
assert.throws(() => finiteWalkVisitDistribution(new Map([['A', [edge('B', NaN)]]]), seedA), RangeError)
assert.throws(() => finiteWalkVisitDistribution(new Map([['A', [edge('B', -1)]]]), seedA), RangeError)

// The independent sampler draws a length, chooses a seed, then counts each visit.
// It shares no transition or propagation code with the exact implementation.
const sampleGraph = new Map([
  ['A', [edge('B', 2), edge('C')]], ['B', [edge('A'), edge('D')]],
  ['C', [edge('C'), edge('D', 2)]], ['D', []],
])
const seedWeights = new Map([['A', 3], ['C', 1]])
const before = JSON.stringify([...sampleGraph])
const exact = finiteWalkVisitDistribution(sampleGraph, seedWeights, 6)
let state = 20261109
const random = () => {
  state ^= state << 13
  state ^= state >>> 17
  state ^= state << 5
  return (state >>> 0) / 4294967296
}
const choose = options => {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0)
  let draw = random() * total
  for (const [id, weight] of options) {
    draw -= weight
    if (draw < 0) return id
  }
  return options.at(-1)[0]
}
const counts = new Map()
const walks = 300000
let totalVisits = 0
for (let run = 0; run < walks; run += 1) {
  const length = 1 + Math.floor(random() * 6)
  let node = choose([...seedWeights])
  for (let step = 0; step < length; step += 1) {
    const edges = sampleGraph.get(node) ?? []
    node = choose(edges.length ? edges.map(item => [item.to, item.weight]) : [...seedWeights])
    counts.set(node, (counts.get(node) ?? 0) + 1)
    totalVisits += 1
  }
}
const empirical = new Map([...counts].map(([id, count]) => [id, count / totalVisits]))
const maxAbsoluteError = Math.max(...[...exact].map(([id, probability]) => Math.abs(probability - (empirical.get(id) ?? 0))))
assert.ok(maxAbsoluteError < 0.003, `Monte Carlo distribution differs by ${maxAbsoluteError}`)
close([...exact.values()].reduce((sum, value) => sum + value, 0), 1)
assert.deepEqual(finiteWalkVisitDistribution(sampleGraph, seedWeights), exact)
assert.equal(JSON.stringify([...sampleGraph]), before, 'Probability calculation must preserve graph input')
assert.equal(contextFor({ version: 1, concepts: [], extraPrompt: '' }).algorithm, 'context-walk-v2')
for (const algorithm of ['context-walk-v1', 'restart-v1']) {
  assert.equal(contextFor({ context: { algorithm } }).algorithm, algorithm, 'Saved method selection must be retained')
}

const report = {
  type: 'finite-walk-numerical-verification', createdAt: new Date().toISOString(),
  algorithm: 'context-walk-v2', maxLength: 6,
  lengthDistribution: 'uniform-integer-1-through-6',
  visitRule: 'Count all visited nodes after transitions, excluding the initial seed. Restart from seeds after a dangling node.',
  exactStepWeights: [6, 5, 4, 3, 2, 1].map(value => value / 21),
  sampler: { method: 'xorshift32', seed: 20261109, walks, totalVisits },
  exact: Object.fromEntries(exact), empirical: Object.fromEntries(empirical), maxAbsoluteError,
  interpretation: 'Numerical implementation verification. Image quality and user outcomes require separate experiments.',
}
await mkdir(new URL('../test-results', import.meta.url), { recursive: true })
await writeFile(new URL('../test-results/finite-walk-verification.json', import.meta.url), JSON.stringify(report, null, 2))
console.log(`Finite walk passed analytic chain/cycle/branch/dangling fixtures, weight validation, saved methods and ${walks} deterministic samples. Maximum probability error ${maxAbsoluteError.toFixed(6)}.`)
