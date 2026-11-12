/**
 * 门禁：宿主集成流程（假 ctx，事件形状对齐 host 0.2.2-rc.1 源码实读）。
 * 断言链路：turn/end → snapshot 读取 → decide → compactNow / agents.create(seed配方)。
 * 运行: node test-flow.mjs —— 全绿 exit 0。
 */
import assert from 'node:assert/strict'
import { apply } from './lib/index.js'

const T = []
const test = (name, fn) => T.push([name, fn])
const tick = () => new Promise((r) => setImmediate(r))

// 真实事件形状锚点（dsh-session-main.js / KNOWN_SESSION_EVENT_TYPES 实读）
function mkEvents(n) {
  const events = []
  let seq = 0
  for (let t = 0; t < n; t++) {
    events.push({ seq: seq++, type: 'turn/start', time: 1000 + t, data: { turn: t } })
    events.push({ seq: seq++, type: 'step/start', time: 1001 + t, data: { turn: t, step: 0 } })
    events.push({ seq: seq++, type: 'assistant/message', time: 1002 + t, data: { turn: t, step: 0, message: { role: 'assistant', content: [] }, usage: { inputTokens: 5000, outputTokens: 10 } } })
    events.push({ seq: seq++, type: 'step/end', time: 1003 + t, data: { turn: t, step: 0 } })
    events.push({ seq: seq++, type: 'turn/end', time: 1004 + t, data: { turn: t } })
  }
  return events
}

function makeHarness({ view = {}, overrides = {}, config, extraSvc = {} } = {}) {
  const events = mkEvents(3)
  const boundary = events.filter((e) => e.type === 'turn/end').at(-1).seq
  const session = {
    id: 'session-s1',
    seq: events.length,
    header: { version: 4, id: 'session-s1', createdAt: 1, cwd: 'D:\\ws', isSeeded: false },
    snapshotEvents: () => events,
  }
  const agent = { id: session.id, session }
  const calls = { compactNow: [], create: [], followup: [] }
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    agents: { get: (id) => (id === session.id ? agent : undefined), create: async (opts) => { calls.create.push(opts); return { agent: { id: opts.sessionId, session: {} } } }, ...overrides.agents },
    sessionProjections: { snapshot: (s, keys) => ({ asOfSeq: s.seq, values: { contextPressure: view } }) , ...overrides.sessionProjections },
    compaction: { compactNow: async (a) => { calls.compactNow.push(a.id); return { shadowedSeqs: [0, 1], shadowedTokenCount: 4000, summarySeq: 2 } }, ...overrides.compaction },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }), ...overrides.agentDefaultModel },
    commands: { register: (d) => { ctx.__cmd = d } },
    effect: (fn) => fn(),
    on: (type, listener) => { ctx.__listener = [type, listener]; return () => {} },
    get: () => undefined,
    ...extraSvc,
  }
  apply(ctx, config)
  return { ctx, session, agent, calls, logs, events, boundary }
}

test('wire: 挂 session/event 与 /escalation 命令', () => {
  const h = makeHarness()
  assert.equal(h.ctx.__listener[0], 'session/event')
  assert.equal(h.ctx.__cmd.name, 'escalation')
})

test('idle: 低占用 turn/end 无任何动作', async () => {
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 3000, projectedTokens: 3000 } })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  assert.equal(h.calls.compactNow.length, 0)
  assert.equal(h.calls.create.length, 0)
})

test('non-turn-end 事件不触发评估', async () => {
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 } })
  h.ctx.__listener[1](h.session, { type: 'step/end', data: {} })
  await tick(); await tick()
  assert.equal(h.calls.compactNow.length, 0)
  assert.equal(h.calls.create.length, 0)
})

test('L1: ratio=0.75 → compactNow 一次，不 create', async () => {
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 7500, projectedTokens: 7500 } })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  assert.deepEqual(h.calls.compactNow, ['session-s1'])
  assert.equal(h.calls.create.length, 0)
  // 第二次触发已计额度：compact 额度 2 → 还能再压一次
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 1 } })
  await tick(); await tick()
  assert.equal(h.calls.compactNow.length, 2)
})

test('L2: ratio=0.95 → 直接升级，seed 配方对齐 controller', async () => {
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 } })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  assert.equal(h.calls.compactNow.length, 0, 'L2 不先压缩')
  assert.equal(h.calls.create.length, 1)
  const opts = h.calls.create[0]
  assert.match(opts.sessionId, /^session-/)
  assert.notEqual(opts.sessionId, 'session-s1')
  assert.equal(opts.inheritedEventCount, h.boundary + 1)
  // seed = 完整前缀 + end-seed 哨兵（buildForkSeed: seq=boundary+1, data.inherited=true）
  assert.equal(opts.seed.length, h.boundary + 2)
  const sentinel = opts.seed[h.boundary + 1]
  assert.equal(sentinel.type, 'session/end-seed')
  assert.equal(sentinel.seq, h.boundary + 1)
  assert.deepEqual(sentinel.data, { inherited: true })
  assert.equal(sentinel.time, h.events[h.boundary].time)
  assert.equal(opts.meta.cwd, 'D:\\ws')
  assert.equal(opts.meta.isSeeded, true)
  assert.equal(opts.meta.parentSession, undefined, '同级：meta 不设 parentSession')
  assert.equal(opts.parentAgent, undefined, '同级：不建立子所有权')
  assert.deepEqual(opts.agentOptions, { provider: 'p', model: 'm' })
})

test('升级后不再评估（让位分支）', async () => {
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 } })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  assert.equal(h.calls.create.length, 1)
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 1 } })
  await tick(); await tick()
  assert.equal(h.calls.create.length, 1, '已升级会话不重复 fork')
})

test('compact busy → 下轮重试不误计数', async () => {
  let first = true
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 7500, projectedTokens: 7500 },
    overrides: { compaction: { compactNow: async () => { if (first) { first = false; const e = new Error('busy'); e.code = 'busy'; throw e } return { shadowedSeqs: [], shadowedTokenCount: 0, summarySeq: 9 } } } },
  })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 1 } })
  await tick(); await tick()
  assert.equal(h.calls.create.length, 0, '额度未被 busy 消耗')
})

test('无 compaction 引擎 → L1 也转升级路径（bili gate 共存降级）', async () => {
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 7500, projectedTokens: 7500 },
    overrides: { compaction: undefined },
  })
  h.ctx.compaction = undefined
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  // 第一轮 L1：compactNow 缺失 → rec.compactions 置满 → 记日志
  const second = h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 1 } })
  await tick(); await tick()
  assert.equal(h.calls.create.length, 1, '压缩不可用时最终走升级')
})

test('度量缺失（投影不可用）→ fail-closed 零动作', async () => {
  const h = makeHarness({ overrides: { sessionProjections: undefined } })
  h.ctx.sessionProjections = undefined
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  assert.equal(h.calls.compactNow.length, 0)
  assert.equal(h.calls.create.length, 0)
})

test('subagent origin 会话跳过', async () => {
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 } })
  h.session.header.origin = 'subagent'
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  assert.equal(h.calls.create.length, 0)
})

test('env 配置注入生效（DSH_ESCALATION_CONFIG）', async () => {
  process.env.DSH_ESCALATION_CONFIG = JSON.stringify({ thresholdRatio1: 0.3, thresholdRatio2: 0.95 })
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 3500, projectedTokens: 3500 } })
  delete process.env.DSH_ESCALATION_CONFIG
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  assert.deepEqual(h.calls.compactNow, ['session-s1'], 'L1=0.3 时 35% 即触发压缩')
})

test('非法 env JSON → 警告日志且默认策略仍运行', async () => {
  process.env.DSH_ESCALATION_CONFIG = '{not json'
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 7500, projectedTokens: 7500 } })
  delete process.env.DSH_ESCALATION_CONFIG
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  assert.equal(h.calls.compactNow.length, 1)
  assert.ok(h.logs.some(([l, m]) => l === 'warn' && m.includes('DSH_ESCALATION_CONFIG')))
})

test('autoContinue=false（显式关闭）不投递续作消息', async () => {
  process.env.DSH_ESCALATION_CONFIG = JSON.stringify({ autoContinue: false })
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 } })
  delete process.env.DSH_ESCALATION_CONFIG
  let followed = 0
  h.calls.create = []
  h.ctx.agents.create = async (opts) => { h.calls.create.push(opts); return { agent: { id: opts.sessionId, followup: () => { followed++ } } } }
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(h.calls.create.length, 1)
  assert.equal(followed, 0)
})

test('autoContinue=true 投递续作消息（user role + text 内容 + escalation source）', async () => {
  process.env.DSH_ESCALATION_CONFIG = JSON.stringify({ autoContinue: true })
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 } })
  delete process.env.DSH_ESCALATION_CONFIG
  const followed = []
  h.ctx.agents.create = async (opts) => { h.calls.create.push(opts); return { agent: { id: opts.sessionId, followup: (m) => followed.push(m) } } }
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(followed.length, 1)
  const msg = followed[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.content[0].type, 'text')
  assert.ok(msg.content[0].text.length > 0)
  assert.equal(msg.source.kind, 'session-escalation')
  assert.equal(msg.source.parentSessionId, 'session-s1')
  assert.equal(msg.source.boundarySeq, h.boundary)
  assert.ok(typeof msg.id === 'string' && msg.id.length > 0)
  assert.ok(Object.isFrozen(msg), '消息 deep-frozen（对齐 createMessage 契约）')
})

test('续作投递抛错不影响升级成功（分支已建好）', async () => {
  process.env.DSH_ESCALATION_CONFIG = JSON.stringify({ autoContinue: true })
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 } })
  delete process.env.DSH_ESCALATION_CONFIG
  h.ctx.agents.create = async (opts) => { h.calls.create.push(opts); return { agent: { id: opts.sessionId, followup: () => { throw new Error('boom') } } } }
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(h.calls.create.length, 1)
  assert.ok(h.logs.some(([l, m]) => l === 'warn' && m.includes('续作投递失败')))
})

// ---- v0.3 配置化 + 命名（宿主 config 管线对齐 cordis.js:244-250 / :359-365）----
test('Config schema: 真 schemastery + 语义层，合法输入同步返回 {value}', async () => {
  const { Config } = await import('./lib/index.js')
  const std = Config['~standard']
  assert.deepEqual(Object.keys(std).sort(), ['validate', 'vendor', 'version'])
  // 宿主设置面的硬门禁：必须有 toJSON 且 vendor 是 schemastery（否则 entry 被丢弃）
  assert.equal(typeof Config.toJSON, 'function', 'dsh-settings 要求 Config.toJSON 存在')
  assert.equal(std.vendor, 'schemastery', 'loader isSchemastery 判据是 vendor 字符串')
  assert.equal(Config.type, 'object')
  assert.equal(Object.keys(Config.dict).length, 11, '11 个字段全部进 schema')
  const r = std.validate({ thresholdRatio1: 0.5, nameTemplate: '{parent}#{n}' })
  assert.equal(r instanceof Promise, false, 'cordis 拒绝异步校验（TypeError）')
  assert.equal(r.issues, undefined)
  // volatile 字段返回活引用（{get()}）—— 由 apply 侧 deref 摊平
  assert.equal(typeof r.value.thresholdRatio1.get, 'function', 'volatile 字段是活引用')
  assert.equal(r.value.thresholdRatio1.get(), 0.5)
  assert.equal(r.value.nameTemplate.get(), '{parent}#{n}')
})
test('Config schema: 类型/区间由真 schema 拦，跨字段与模板由语义层拦', async () => {
  const { Config } = await import('./lib/index.js')
  const v = (input) => Config['~standard'].validate(input)
  // 类型 / 区间 —— 真 schemastery 负责，issues 带 path
  const r1 = v({ thresholdRatio1: 5 })
  assert.ok(Array.isArray(r1.issues) && r1.issues.length === 1)
  assert.deepEqual(r1.issues[0].path, ['thresholdRatio1'])
  assert.match(r1.issues[0].message, /thresholdRatio1.*0\.99/)
  const r2 = v({ enabled: 'yes' })
  assert.deepEqual(r2.issues[0].path, ['enabled'])
  const r3 = v({ maxCompactPerSession: 1.5 })
  assert.deepEqual(r3.issues[0].path, ['maxCompactPerSession'])
  // 跨字段（ratio2 >= ratio1）与模板占位符 —— 真 schema 不管，由语义层兜住
  const r4 = v({ nameTemplate: '{nope}' })
  assert.match(r4.issues[0].message, /unknown placeholder/)
  const r5 = v({ nameTemplate: '   ' })
  assert.match(r5.issues[0].message, /must not be empty/)
  const r6 = v({ thresholdRatio1: 0.9, thresholdRatio2: 0.5 })
  assert.match(r6.issues[0].message, /thresholdRatio2/)
  // 非对象输入：真 schema 报 "expected object"，语义层不介入
  assert.match(v('nope').issues[0].message, /expected object/)
  // undefined/null 取默认值（真 schema 会填满全部字段）
  const d = v(undefined)
  assert.equal(d.issues, undefined)
  assert.deepEqual(Object.keys(d.value).sort(), [
    'archiveParentOnEscalate', 'autoContinue', 'continuePrompt', 'enabled', 'maxChainDepth', 'maxCompactPerSession',
    'maxEscalatePerSession', 'nameTemplate', 'renameOnEscalate', 'thresholdRatio1', 'thresholdRatio2',
  ])
})
test('宿主 config 生效并优先于 env（逐键合并）', async () => {
  process.env.DSH_ESCALATION_CONFIG = JSON.stringify({ thresholdRatio1: 0.3, maxCompactPerSession: 9 })
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 5000, projectedTokens: 5000 }, config: { thresholdRatio1: 0.4 } })
  delete process.env.DSH_ESCALATION_CONFIG
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick()
  // host 的 0.4 覆盖 env 的 0.3；50% ≥ 40% → 压缩；env 的 maxCompact=9 仍生效（只压一次）
  assert.deepEqual(h.calls.compactNow, ['session-s1'])
  assert.equal(h.calls.create.length, 0)
  const panel = h.ctx.__cmd.handler({ agent: { session: h.session } })
  assert.match(panel.text, /配置来源: host\+env/)
})
test('宿主 config 非法 → warn 且插件停用（fail-closed）', async () => {
  // 绕过 cordis 直接喂非法值，验证应用层自身也 fail-closed
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 }, config: { thresholdRatio1: 1.2 } })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick()
  assert.equal(h.calls.create.length, 0)
  assert.ok(h.logs.some(([l, m]) => l === 'warn' && m.includes('配置非法')))
})
test('未知配置键 → warn 忽略，不污染策略', async () => {
  const h = makeHarness({ config: { bogusKey: 1 } })
  assert.ok(h.logs.some(([l, m]) => l === 'warn' && m.includes('bogusKey')))
  const panel = h.ctx.__cmd.handler({ agent: { session: h.session } })
  assert.match(panel.text, /配置来源: default/, '未知键不计入 host 来源')
})
test('命名默认模板渲染 {parent}-续{n} 并落到 sessionTitle.rename', async () => {
  const renames = []
  const childSession = { id: 'child-x', snapshotEvents: () => [] }
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 },
    extraSvc: {
      sessionTitle: {
        get: () => ({ title: '重构插件' }),
        rename: (s, t) => { renames.push([s, t]); return { title: t } },
      },
      sessions: { get: (id) => (id.startsWith('session-') && id !== 'session-s1' ? { ...childSession, id } : undefined) },
    },
  })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(renames.length, 1)
  assert.equal(renames[0][1], '重构插件-续1', '默认模板 = {parent}-续{n}')
  assert.equal(renames[0][0].id, h.calls.create[0].sessionId, 'rename 拿到的是分支会话本体')
})
test('自定义命名模板：{date}{time}{uuid8}{parentId} 全部渲染', async () => {
  const renames = []
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 },
    config: { nameTemplate: '[{date} {time}] {parent} #{n} {uuid8}' },
    extraSvc: {
      sessionTitle: { get: () => ({ title: 'P' }), rename: (s, t) => { renames.push(t); return { title: t } } },
      sessions: { get: (id) => (id !== 'session-s1' && id.startsWith('session-') ? { id } : undefined) },
    },
  })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  const id = h.calls.create[0].sessionId
  assert.equal(renames.length, 1)
  assert.match(renames[0], /^\[\d{8} \d{6}\] P #1 [0-9a-f]{8}$/)
  assert.ok(renames[0].includes(id.replace(/^session-/, '').slice(0, 8)), 'uuid8 来自 childId')
})
test('renameOnEscalate=false → 不调用 rename', async () => {
  const renames = []
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 },
    config: { renameOnEscalate: false },
    extraSvc: {
      sessionTitle: { get: () => ({ title: 'P' }), rename: (s, t) => { renames.push(t); return { title: t } } },
      sessions: { get: (id) => (id !== 'session-s1' ? { id } : undefined) },
    },
  })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(h.calls.create.length, 1)
  assert.equal(renames.length, 0)
})
test('sessionTitle 缺席 → 跳过命名且分支照常建立', async () => {
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 } })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(h.calls.create.length, 1, '命名缺失不阻断分支')
  assert.ok(h.logs.some(([l, m]) => l === 'info' && m.includes('sessionTitle 服务缺席')))
})
test('rename 抛错 → 只 warn，分支与续作照常', async () => {
  const followed = []
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 },
    extraSvc: {
      sessionTitle: { get: () => ({ title: 'P' }), rename: () => { throw new Error('not live in this store') } },
      sessions: { get: (id) => (id !== 'session-s1' ? { id } : undefined) },
    },
  })
  h.ctx.agents.create = async (opts) => { h.calls.create.push(opts); return { agent: { id: opts.sessionId, followup: (m) => followed.push(m) } } }
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(h.calls.create.length, 1)
  assert.equal(followed.length, 1)
  assert.ok(h.logs.some(([l, m]) => l === 'warn' && m.includes('分支命名失败')))
})
test('子会话未进 store → 跳过命名（不瞎 rename 别的对象）', async () => {
  const renames = []
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 },
    extraSvc: {
      sessionTitle: { get: () => ({ title: 'P' }), rename: (s, t) => { renames.push(t); return { title: t } } },
      sessions: { get: () => undefined },
    },
  })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(h.calls.create.length, 1)
  assert.equal(renames.length, 0)
  assert.ok(h.logs.some(([l, m]) => l === 'info' && m.includes('尚未进入 store')))
})

// ---- v0.4.1 旧会话归档（宿主 workspaceRegistry.archiveSession 原生能力；用户拍板默认开启 + stopActivity:true）----
test('归档: 默认开启 → 升级成功后 archiveSession(parent,{stopActivity:true}) 恰一次', async () => {
  const archives = []
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 },
    extraSvc: { workspaceRegistry: { archiveSession: async (id, opts) => { archives.push([id, opts]) } } },
  })
  const followed = []
  h.ctx.agents.create = async (opts) => { h.calls.create.push(opts); return { agent: { id: opts.sessionId, followup: (m) => followed.push(m) } } }
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(h.calls.create.length, 1, '升级照常建立分支')
  assert.equal(followed.length, 1, '续作照常投递')
  assert.deepEqual(archives, [['session-s1', { stopActivity: true }]], '归档恰一次且参数对齐宿主 API')
  assert.ok(h.logs.some(([l, m]) => l === 'info' && m.includes('旧会话已归档: session-s1')), '归档成功日志留痕')
})
test('归档: archiveSession 抛错（活动会话拒绝等）→ 只 warn，升级链路不受影响', async () => {
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 },
    extraSvc: { workspaceRegistry: { archiveSession: async () => { const e = new Error('workspace active'); e.code = 'WorkspaceActiveSessionError'; throw e } } },
  })
  const followed = []
  h.ctx.agents.create = async (opts) => { h.calls.create.push(opts); return { agent: { id: opts.sessionId, followup: (m) => followed.push(m) } } }
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(h.calls.create.length, 1, '归档失败不影响升级')
  assert.equal(followed.length, 1, '归档失败不影响续作')
  assert.ok(h.logs.some(([l, m]) => l === 'warn' && m.includes('归档旧会话 session-s1 被拒')), 'warn 留痕')
  assert.ok(!h.logs.some(([, m]) => m.includes('升级失败')), '不得走升级失败路径')
})
test('归档: workspaceRegistry 缺席 → info 降级，升级照常，面板显示归档引擎缺席', async () => {
  const h = makeHarness({ view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 } })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(h.calls.create.length, 1, '归档能力缺席不阻断升级')
  assert.ok(h.logs.some(([l, m]) => l === 'info' && m.includes('archiveSession 缺席')), '降级日志留痕')
  const out = h.ctx.__cmd.handler({ agent: { session: h.session } })
  assert.match(out.text, /归档引擎: 缺席/)
})
test('归档: archiveParentOnEscalate=false → 不调用 archiveSession', async () => {
  const archives = []
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 9500, projectedTokens: 9500 },
    config: { archiveParentOnEscalate: false },
    extraSvc: { workspaceRegistry: { archiveSession: async (id, opts) => { archives.push([id, opts]) } } },
  })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: {} })
  await tick(); await tick(); await tick()
  assert.equal(h.calls.create.length, 1)
  assert.equal(archives.length, 0, '开关关闭绝不归档')
})
test('面板显示配置来源、命名模板与 sessionTitle 就绪度', async () => {
  const h = makeHarness({ config: { thresholdRatio1: 0.5 }, extraSvc: { sessionTitle: { rename: () => ({}) } } })
  const out = h.ctx.__cmd.handler({ agent: { session: h.session } })
  assert.match(out.text, /v0\.4\.1/)
  assert.match(out.text, /配置来源: host/)
  assert.match(out.text, /配置面: 插件管理页可编辑/)
  assert.match(out.text, /\{parent\}-续\{n\}/)
  assert.match(out.text, /sessionTitle=就绪/)
  assert.match(out.text, /archiveParentOnEscalate=true/)
  assert.match(out.text, /归档引擎: 缺席/)
  assert.match(out.text, /需重载插件才生效/)
})

test('volatile 解引用: cordis 传入 {get()} 活引用时阈值仍按数值判定', async () => {
  const { Config } = await import('./lib/index.js')
  // 完全复刻 cordis 的真实传参路径：resolveConfig → Config['~standard'].validate
  // 返回的 value 里 volatile 字段是活引用（{get()}），不是数字。
  const validated = Config['~standard'].validate({ thresholdRatio1: 0.4, thresholdRatio2: 0.8 })
  assert.equal(validated.issues, undefined)
  const liveConfig = validated.value
  assert.equal(typeof liveConfig.thresholdRatio1.get, 'function', '前提：宿主传进来的确实是活引用')
  assert.notEqual(typeof liveConfig.thresholdRatio1, 'number', '前提：不是裸数字')

  // 50% 占用：若 apply 没解引用，阈值是对象 → 比较恒 false → 不压缩（静默失效）
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 5000, projectedTokens: 5000 },
    config: liveConfig,
  })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  assert.deepEqual(h.calls.compactNow, ['session-s1'], '50% ≥ 40% → 必须压缩（证明阈值已被解引用）')

  const panel = h.ctx.__cmd.handler({ agent: { session: h.session } })
  assert.match(panel.text, /阈值 L1=0\.4 L2=0\.8/, '面板也必须显示解引用后的数值')
})

test('volatile 解引用: 活引用改动后，同一 apply 实例读到新值（热更新载体）', async () => {
  const { Config } = await import('./lib/index.js')
  const liveConfig = Config['~standard'].validate({ thresholdRatio1: 0.4 }).value
  // 低占用：40% 阈值下 30% 不该动作
  const h = makeHarness({
    view: { contextWindow: 10000, pressureTokens: 3000, projectedTokens: 3000 },
    config: liveConfig,
  })
  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 0 } })
  await tick(); await tick()
  assert.equal(h.calls.compactNow.length, 0, '30% < 40% → 不压缩')

  // loader _commitVolatile 就是往这个引用里写（cordis_loader.js:395-419）。
  // 这里模拟同一次写入：ref 变了，但 apply 捕获的仍是同一个 ref 对象。
  const ref = liveConfig.thresholdRatio1
  const write = Object.getOwnPropertySymbols(ref).find((s) => String(s).includes('volatile.write'))
  assert.notEqual(write, undefined, 'volatile 引用上应带 cosmokit.volatile.write 符号')
  ref[write]?.({ value: 0.2 })

  h.ctx.__listener[1](h.session, { type: 'turn/end', data: { turn: 1 } })
  await tick(); await tick()
  assert.deepEqual(h.calls.compactNow, ['session-s1'], '阈值被热改成 20% 后，30% 占用应触发压缩')
})

let failed = 0
for (const [name, fn] of T) {
  try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, '\n ', e.message) }
}
console.log(`${T.length - failed}/${T.length} passed`)
process.exit(failed === 0 ? 0 : 1)
