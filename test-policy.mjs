/**
 * 门禁：policy.js 全分支穷举。断言与预期完全相等（禁子集）。
 * 运行: node test-policy.mjs —— 全绿 exit 0；任一断言失败 exit 1。
 */
import assert from 'node:assert/strict'
import { DEFAULTS, resolveConfig, decide, renderName, validateNameTemplate, NAME_PLACEHOLDERS } from './lib/policy.js'

const cfg = resolveConfig({})
const T = []
const test = (name, fn) => T.push([name, fn])

// ---- resolveConfig fail-closed ----
test('config: defaults frozen', () => {
  assert.equal(cfg.thresholdRatio1, 0.70)
  assert.equal(cfg.thresholdRatio2, 0.90)
  assert.equal(cfg.maxCompactPerSession, 2)
  assert.equal(cfg.maxEscalatePerSession, 1)
  assert.equal(cfg.autoContinue, true, '升级后自动续作是需求本意 (m00255)，默认开')
  assert.equal(Object.isFrozen(cfg), true)
})
test('config: bad ratios throw', () => {
  assert.throws(() => resolveConfig({ thresholdRatio1: 0 }), /thresholdRatio1/)
  assert.throws(() => resolveConfig({ thresholdRatio1: 1 }), /thresholdRatio1/)
  assert.throws(() => resolveConfig({ thresholdRatio1: 0.9, thresholdRatio2: 0.8 }), /thresholdRatio2/)
  assert.throws(() => resolveConfig({ maxCompactPerSession: -1 }), /maxCompactPerSession/)
  assert.throws(() => resolveConfig({ maxCompactPerSession: 1.5 }), /maxCompactPerSession/)
})

// ---- decide: 边界表（ratio 恰在阈值上/下） ----
const obs = (o) => ({ occupancy: null, contextWindow: null, compactionsDone: 0, escalationsDone: 0, chainDepth: 0, agentIdle: true, ...o })
test('decision: disabled', () => {
  assert.deepEqual(decide(obs({ occupancy: 9500, contextWindow: 10000 }), resolveConfig({ enabled: false })),
    { action: 'none', reason: 'disabled', ratio: null })
})
test('decision: unknown occupancy fails closed', () => {
  assert.deepEqual(decide(obs({ occupancy: null, contextWindow: 10000 }), cfg), { action: 'none', reason: 'unknown-occupancy', ratio: null })
  assert.deepEqual(decide(obs({ occupancy: 5000, contextWindow: null }), cfg), { action: 'none', reason: 'unknown-occupancy', ratio: null })
  assert.deepEqual(decide(obs({ occupancy: 5000, contextWindow: 0 }), cfg), { action: 'none', reason: 'unknown-occupancy', ratio: null })
})
test('decision: busy fails closed even at 99%', () => {
  assert.deepEqual(decide(obs({ occupancy: 9900, contextWindow: 10000, agentIdle: false }), cfg),
    { action: 'none', reason: 'agent-busy', ratio: null })
})
test('decision: below L1 exact boundary', () => {
  assert.deepEqual(decide(obs({ occupancy: 6999, contextWindow: 10000 }), cfg),
    { action: 'none', reason: 'below-l1', ratio: 0.6999 })
})
test('decision: at L1 boundary → compact', () => {
  assert.deepEqual(decide(obs({ occupancy: 7000, contextWindow: 10000 }), cfg),
    { action: 'compact', reason: 'l1-threshold', ratio: 0.7 })
})
test('decision: L1..L2 mid → compact first', () => {
  assert.deepEqual(decide(obs({ occupancy: 8500, contextWindow: 10000 }), cfg),
    { action: 'compact', reason: 'l1-threshold', ratio: 0.85 })
})
test('decision: at L2 boundary → escalate (skips compact)', () => {
  assert.deepEqual(decide(obs({ occupancy: 9000, contextWindow: 10000 }), cfg),
    { action: 'escalate', reason: 'l2-threshold', ratio: 0.9 })
})
test('decision: compact budget exhausted while above L1 → escalate', () => {
  assert.deepEqual(decide(obs({ occupancy: 7500, contextWindow: 10000, compactionsDone: 2 }), cfg),
    { action: 'escalate', reason: 'compact-budget-exhausted-while-above-l1', ratio: 0.75 })
})
test('decision: escalate budget exhausted → none', () => {
  assert.deepEqual(decide(obs({ occupancy: 9500, contextWindow: 10000, escalationsDone: 1 }), cfg),
    { action: 'none', reason: 'escalate-budget-exhausted', ratio: 0.95 })
  assert.deepEqual(decide(obs({ occupancy: 7500, contextWindow: 10000, compactionsDone: 2, escalationsDone: 1 }), cfg),
    { action: 'none', reason: 'compact-budget-exhausted', ratio: 0.75 })
})
test('decision: chain depth cap', () => {
  assert.deepEqual(decide(obs({ occupancy: 9500, contextWindow: 10000, chainDepth: 16 }), cfg),
    { action: 'none', reason: 'escalate-budget-exhausted', ratio: 0.95 })
})
test('decision: escalate with maxEscalatePerSession=0 → none at L2', () => {
  const c2 = resolveConfig({ maxEscalatePerSession: 0 })
  assert.deepEqual(decide(obs({ occupancy: 9500, contextWindow: 10000 }), c2),
    { action: 'none', reason: 'escalate-budget-exhausted', ratio: 0.95 })
})

// ---- 命名模板（v0.3 新增）----
test('naming: 默认模板与冻结', () => {
  assert.equal(cfg.nameTemplate, '{parent}-续{n}')
  assert.equal(cfg.renameOnEscalate, true)
})
test('naming: 占位符全集渲染', () => {
  assert.deepEqual([...NAME_PLACEHOLDERS].sort(), ['date', 'n', 'parent', 'parentId', 'time', 'uuid8'])
  assert.equal(
    renderName('{parent}-续{n}@{date}{time}/{uuid8}', { parent: 'P', n: 2, date: '20260101', time: '093000', uuid8: 'deadbeef' }),
    'P-续2@20260101093000/deadbeef')
})
test('naming: 未提供的占位符原样保留（renderName 是纯函数）', () => {
  assert.equal(renderName('{parent}-{nope}', { parent: 'P' }), 'P-{nope}')
})
test('naming: 模板校验 fail-closed', () => {
  assert.throws(() => resolveConfig({ nameTemplate: '' }), /must not be empty/)
  assert.throws(() => resolveConfig({ nameTemplate: '   ' }), /must not be empty/)
  assert.throws(() => resolveConfig({ nameTemplate: 123 }), /must be a string/)
  assert.throws(() => resolveConfig({ nameTemplate: '{unknown}' }), /unknown placeholder/)
  assert.throws(() => resolveConfig({ nameTemplate: '{parent}{oops}' }), /\{oops\}/)
  assert.throws(() => validateNameTemplate('{parentId}{bad1}{bad2}'), /\{bad1\}, \{bad2\}/)
  // 合法模板不抛
  assert.equal(validateNameTemplate('{parent}-{n}'), undefined)
  assert.equal(validateNameTemplate('续作 {date}'), undefined)
})
test('naming: 布尔开关类型校验', () => {
  assert.throws(() => resolveConfig({ autoContinue: 'true' }), /autoContinue must be a boolean/)
  assert.throws(() => resolveConfig({ renameOnEscalate: 1 }), /renameOnEscalate must be a boolean/)
  assert.throws(() => resolveConfig({ enabled: null }), /enabled must be a boolean/)
  assert.throws(() => resolveConfig({ continuePrompt: 42 }), /continuePrompt must be a string/)
})

let failed = 0
for (const [name, fn] of T) {
  try { fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, '\n ', e.message) }
}
console.log(`${T.length - failed}/${T.length} passed`)
process.exit(failed === 0 ? 0 : 1)
