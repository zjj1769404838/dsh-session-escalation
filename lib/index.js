/**
 * @zjjlivingfree/dsh-session-escalation — 两级阈值会话治理（宿主集成层）
 *
 * 第一级：占用比 ≥ thresholdRatio1 → ctx.compaction.compactNow(agent)
 * 第二级：占用比 ≥ thresholdRatio2（或压缩额度耗尽仍 ≥ ratio1）→
 *         按宿主 controller.fork 的真实配方（api-session-controller.js:756-816,
 *         host 0.2.2-rc.1 实读）在最后一个已完成 turn 处建立继承分支：
 *         ctx.agents.create({sessionId?, seed, inheritedEventCount, meta, agentOptions, setup})
 *
 * 度量来源：token-meter 的 contextPressure 投影（dsh-token-meter.js:449-497 实读）
 *   occupancy = view.projectedTokens ?? view.pressureTokens ?? null
 *   window    = view.contextWindow ?? null
 *   读取     = ctx.sessionProjections.snapshot(session, ['contextPressure'])  (:232 实读)
 *
 * 触发时机：每个已提交的 `turn/end` 事件后（KNOWN_SESSION_EVENT_TYPES:136 实读）。
 * compactNow 非空闲会抛 busy（dsh-command-compact.js:20-42），捕获后退避到下一 turn。
 *
 * 每个宿主触点都做能力探测；缺失即记录并跳过（fail-closed），绝不假装成功。
 * 策略判定全部在 lib/policy.js（纯函数，独立门禁）。
 *
 * 配置（v0.3 起正式配置化）：
 *   1) 宿主 config —— cordis 把校验后的配置作为 apply 第二参数传入
 *      （cordis.js:359-365 `runtime.callback(this.ctx, config)`，:244-250 走
 *      `Config["~standard"].validate`）。可在 cordis.patch.yml 的 `config:` 下写。
 *   2) 环境变量 DSH_ESCALATION_CONFIG（JSON）—— 只补宿主没给的键（逐键兜底）。
 *   逐键优先级：宿主 config > env > DEFAULTS。
 *   注意：apply 内捕获的 cfg 是闭包常量，热改配置后需重载插件才生效。
 */
import { resolveConfig, decide, DEFAULTS, renderName } from './policy.js'
import { createConfig } from './config-schema.js'

const name = '@zjjlivingfree/dsh-session-escalation'
// 真机回归（fiber failed: cannot get property "commands" without inject）：
// DSH 对未声明服务的属性访问直接抛 —— commands/agents/sessionProjections 必须
// 显式 inject（bili-native 同款 inject 先例）。其余服务走 svc(ctx.get+try 兜底)：
// ctx.get → _getImpl 只查 store、不校验 inject（cordis.js:1350-1356 实读），
// 故 sessions / sessionTitle / compaction 等可选服务不必进 inject ——
// 进了反而会在宿主未挂载时让 fiber failed。
const inject = ['commands', 'agents', 'sessionProjections']

const ORIGIN_SKIP = new Set(['subagent'])
const VERSION = '0.4.1'

/** 可选服务解析：controller 同款 `ctx.get(name)` 优先（api-session-controller.js
 *  :265/:1641 实读），属性访问兜底且包裹 try —— 未 compose 的服务属性访问可能抛。 */
function svc(ctx, key) {
  try {
    const got = ctx.get?.(key)
    if (got !== undefined) return got
  } catch { /* 探测失败 → 走属性兜底 */ }
  try {
    return ctx[key]
  } catch {
    return undefined
  }
}

/** 续作消息工厂：宿主在载（desktop 真机路径）→ 动态 import 真实
 *  createUserMessage（dsh-automation lib/index.js:21575/21764 同款用法先例）；
 *  独立门禁离线 → 逐字节镜像 createMessage（dsh-llm@1604 实读：
 *  deepFreeze(structuredClone({...input, id: uuid}))）。两条路径产出同一形状。 */
let userMessageFactory = null
async function resolveCreateUserMessage() {
  if (userMessageFactory !== null) return userMessageFactory
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage === 'function') {
      userMessageFactory = mod.createUserMessage
      return userMessageFactory
    }
  } catch { /* 离线门禁 / 解析失败 → 镜像兜底 */ }
  const deepFreeze = (v) => {
    if (v !== null && typeof v === 'object') {
      for (const o of Object.values(v)) deepFreeze(o)
      Object.freeze(v)
    }
    return v
  }
  userMessageFactory = (input) => deepFreeze(structuredClone({ ...input, role: 'user', id: crypto.randomUUID() }))
  return userMessageFactory
}

function envConfig() {
  const raw = process.env.DSH_ESCALATION_CONFIG
  if (raw === undefined || raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    return { __configError: `DSH_ESCALATION_CONFIG 不是合法 JSON: ${String(error)}` }
  }
}

// ---- 宿主配置 schema ---------------------------------------------------------------
// v0.4 起改用真 schemastery 实例（lib/config-schema.js）：宿主设置面要求 Config 有
// `toJSON()` 且至少一个字段 `meta.volatile`，否则整条 entry 被直接丢弃
// （dsh-settings-index.js:539-543 `"toJSON" in schema` / :122-133 volatileForm 实读）。
// schemastery 经 createRequire(<profile>/package.json) 解析 —— 插件以 junction 挂在
// profile 下，静态 import 会因 realpath 解析不到 profile 依赖（真机 ERR_MODULE_NOT_FOUND）。
// 解析失败时回退零依赖兜底并在面板显式报错（fail-closed，不伪造可编辑性）。

const schemaInfo = createConfig(DEFAULTS)
const Config = schemaInfo.Config

/** 解引用 volatile 字段：`.volatile()` 的值在运行时是 `{get()}` 引用
 *  （loader `_commitVolatile` 就地写它，插件持有引用即可感知热更新，
 *   见 cordis_loader.js:395-419 实读）。 */
function deref(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

/**
 * 把配置里的 volatile 引用摊平 —— 但**只在读取时摊平**。
 *
 * 关键：`deref` 必须在每次读取时执行，不能在 apply 开头一次性摊平。
 * volatile ref 是 `{get(), [Symbol.for("cosmokit.volatile.write")]}`
 * （cosmokit lib/index.js:105-113 实读），loader `_commitVolatile`
 * 是**就地写这个 ref**（updateVolatile → ref[write](value)）。若 apply 里
 * 先摊平成普通对象，热更新就丢在快照里 —— GUI 改了阈值但插件读老值，
 * 表现为"改了不生效"且没有任何报错（v0.4 门禁实测抓到的缺陷）。
 */
function derefAll(raw) {
  const out = {}
  for (const k of Object.keys(raw)) out[k] = deref(raw[k])
  return out
}

/** 生成「每次访问都解引用」的配置视图（保留 ref 本身，故能感知热更新）。 */
function liveConfig(layers) {
  return {
    get enabled() { return deref(layers.merged.enabled) },
    get thresholdRatio1() { return deref(layers.merged.thresholdRatio1) },
    get thresholdRatio2() { return deref(layers.merged.thresholdRatio2) },
    get maxCompactPerSession() { return deref(layers.merged.maxCompactPerSession) },
    get maxEscalatePerSession() { return deref(layers.merged.maxEscalatePerSession) },
    get maxChainDepth() { return deref(layers.merged.maxChainDepth) },
    get autoContinue() { return deref(layers.merged.autoContinue) },
    get renameOnEscalate() { return deref(layers.merged.renameOnEscalate) },
    get archiveParentOnEscalate() { return deref(layers.merged.archiveParentOnEscalate) },
    get nameTemplate() { return deref(layers.merged.nameTemplate) },
    get continuePrompt() { return deref(layers.merged.continuePrompt) },
  }
}

/** 配置分层：宿主 config 逐键优先，env 只补宿主没给的键。 */
function planConfigLayers(hostConfig) {
  const hostRaw = hostConfig !== null && typeof hostConfig === 'object' && !Array.isArray(hostConfig) ? hostConfig : {}
  // 宿主 config 可能带 volatile 引用（{get()}）—— 先摊平再合并/判定，
  // 否则阈值会变成对象，decide() 的所有比较都会失真。
  const host = hostRaw
  const hostKeys = Object.keys(host).filter((k) => k in DEFAULTS)
  const envRaw = envConfig()
  const envError = envRaw.__configError
  const env = envError === undefined ? envRaw : {}
  const envKeys = Object.keys(env).filter((k) => k in DEFAULTS && !(k in host))
  const overlay = {}
  for (const k of envKeys) overlay[k] = env[k]
  const unknown = [...new Set([...Object.keys(host), ...Object.keys(env)])].filter((k) => !(k in DEFAULTS))
  // merged 必须以 DEFAULTS 为底：liveConfig 是「每次读取解引用」的视图，
  // 它从 merged 取值，缺键就会读到 undefined（v0.4 门禁实测抓到的缺陷）。
  return { merged: { ...DEFAULTS, ...overlay, ...host }, hostKeys, envKeys, envError, unknown }
}

/** 每会话动作账本（进程内；宿主重启归零 —— 已记录的降级）。 */
class Ledger {
  map = new Map()
  ensure(sessionId) {
    let rec = this.map.get(sessionId)
    if (rec === undefined) {
      rec = { compactions: 0, escalations: 0, depth: 0, lastDecision: null, busy: false, escalatedTo: null }
      this.map.set(sessionId, rec)
    }
    return rec
  }
}

/** 最新已完成 turn 的结束事件 seq（inclusive boundary）；无则 null。
 *  对齐 controller 的 latestCompletedPrefixBoundary（该函数宿主内私有，
 *  此处按事件流语义重建：最后一个 type==='turn/end' 的 seq）。 */
function latestCompletedTurnBoundary(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type === 'turn/end') return e.seq
  }
  return null
}

/** buildForkSeed 的 turn/end 特化重建（dsh-session-main.js 实读）：
 *  prefix = events[0..boundary]，boundary 为 turn/end → 无开放尾部 →
 *  openTurnClosers 只处理开放 turn，此处仅需 end-seed 哨兵。 */
function buildCompletedTurnSeed(events, boundary) {
  const prefix = events.slice(0, boundary + 1)
  const boundaryEvent = prefix[prefix.length - 1]
  prefix.push({
    type: 'session/end-seed',
    seq: boundary + 1,
    time: boundaryEvent.time,
    data: { inherited: true },
  })
  return prefix
}

/** 本地时间占位符（{time}=HHmmss, {date}=YYYYMMDD）。 */
function localStamps(now) {
  const p = (n, w) => String(n).padStart(w, '0')
  return {
    time: `${p(now.getHours(), 2)}${p(now.getMinutes(), 2)}${p(now.getSeconds(), 2)}`,
    date: `${now.getFullYear()}${p(now.getMonth() + 1, 2)}${p(now.getDate(), 2)}`,
  }
}

function apply(ctx, hostConfig) {
  const layers = planConfigLayers(hostConfig)
  if (layers.envError !== undefined) {
    ctx.logger?.warn?.(`[session-escalation] ${layers.envError} —— 忽略 env 层`)
  }
  if (layers.unknown.length > 0) {
    ctx.logger?.warn?.(`[session-escalation] 未知配置键已忽略: ${layers.unknown.join(', ')}（可用: ${Object.keys(DEFAULTS).join(', ')}）`)
  }
  const cfgSource = layers.hostKeys.length > 0 && layers.envKeys.length > 0 ? 'host+env'
    : layers.hostKeys.length > 0 ? 'host'
      : layers.envKeys.length > 0 ? 'env' : 'default'
  let cfg
  let cfgError = null
  try {
    cfg = liveConfig(layers)
    // 首次读取即校验一次（非法配置在启动时就暴露，而不是等到第一次 turn/end）
    resolveConfig(derefAll(layers.merged))
  } catch (error) {
    cfgError = String(error?.message ?? error)
    ctx.logger?.warn?.(`[session-escalation] 配置非法 (${cfgError}) —— 回退默认策略，插件保持停用`)
    cfg = liveConfig({ merged: resolveConfig({ ...DEFAULTS, enabled: false }) })
  }
  const ledger = new Ledger()

  const readOccupancy = (session) => {
    const projections = svc(ctx, 'sessionProjections')
    if (typeof projections?.snapshot !== 'function') return { occupancy: null, contextWindow: null }
    try {
      const snap = projections.snapshot(session, ['contextPressure'])
      const view = snap?.values?.contextPressure
      if (view === undefined) return { occupancy: null, contextWindow: null }
      const occupancy = view.projectedTokens ?? view.pressureTokens ?? null
      const contextWindow = view.contextWindow ?? null
      return { occupancy, contextWindow }
    } catch (error) {
      ctx.logger?.warn?.(`[session-escalation] contextPressure 读取失败: ${String(error)}`)
      return { occupancy: null, contextWindow: null }
    }
  }

  const doCompact = async (agent, rec, session) => {
    const compaction = svc(ctx, 'compaction')
    if (typeof compaction?.compactNow !== 'function') {
      // bili gate / 无引擎宿主下 ctx.compaction 缺席 —— 降级：本会话压缩额度直接视为耗尽
      rec.compactions = cfg.maxCompactPerSession
      ctx.logger?.info?.(`[session-escalation] ${session.id}: 无 compaction 引擎（ctx.compaction 缺失），转升级路径`)
      return false
    }
    try {
      const result = await compaction.compactNow(agent, undefined, undefined)
      if (result === null) {
        ctx.logger?.info?.(`[session-escalation] ${session.id}: compactNow 返回 null（无可紧凑历史）`)
      } else {
        rec.compactions += 1
        ctx.logger?.info?.(`[session-escalation] ${session.id}: 压缩完成 ${result.shadowedSeqs.length} 项 / ~${result.shadowedTokenCount} tokens (第 ${rec.compactions} 次)`)
      }
      return true
    } catch (error) {
      if (error?.code === 'busy') {
        ctx.logger?.info?.(`[session-escalation] ${session.id}: 压缩 busy —— 下一 turn 重试`)
        return false
      }
      // summary/commit/changed/persistence：额度计数不动，日志留痕
      ctx.logger?.warn?.(`[session-escalation] ${session.id}: compactNow 失败 code=${String(error?.code)} msg=${String(error?.message ?? error)}`)
      return false
    }
  }

  /** 给分支会话起名（可选能力）：宿主用 ctx.sessionTitle.rename 落 session/title 事件
   *  （title.js:301-317 实读：同步、要求 session 是 store 中的活实例、空标题抛错）。
   *  失败只记日志 —— 命名是增强项，绝不能阻断分支建立。 */
  const renameChild = (session, childId, seqNo) => {
    const titles = svc(ctx, 'sessionTitle')
    if (typeof titles?.rename !== 'function') {
      ctx.logger?.info?.(`[session-escalation] sessionTitle 服务缺席 —— 分支 ${childId} 保留宿主默认标题`)
      return
    }
    let parentTitle = session.id
    try {
      const snap = titles.get?.(session)
      if (typeof snap?.title === 'string' && snap.title.trim() !== '') parentTitle = snap.title
    } catch { /* 标题快照不可读 → 退回 session id */ }
    const childSession = svc(ctx, 'sessions')?.get?.(childId)
    if (childSession === undefined) {
      ctx.logger?.info?.(`[session-escalation] 分支 ${childId} 尚未进入 store —— 跳过命名`)
      return
    }
    const now = new Date()
    const stamps = localStamps(now)
    const rendered = renderName(cfg.nameTemplate, {
      parent: parentTitle,
      parentId: session.id,
      n: seqNo,
      ...stamps,
      uuid8: childId.replace(/^session-/, '').slice(0, 8),
    })
    try {
      const snap = titles.rename(childSession, rendered)
      ctx.logger?.info?.(`[session-escalation] 分支命名: ${childId} → "${snap?.title ?? rendered}"`)
    } catch (error) {
      ctx.logger?.warn?.(`[session-escalation] 分支命名失败（不影响分支）: ${String(error?.message ?? error)}`)
    }
  }

  /** 升级成功后把旧会话归档（可选能力）：宿主 WorkspaceRegistry.archiveSession 是原生可逆
   *  能力（不改 workspace 成员关系，可 unarchive 恢复）；副作用 = 无条件取消置顶 +
   *  stopActivity:true 会先发 workspace/session-stop（等价用户停止）取消父会话运行中 turn
   *  —— turn/end 提交到微任务之间用户若恰好对旧会话发出新消息，该消息会被取消，
   *  这是用户 2026-11-10 拍板「默认开启 + stopActivity:true」时已知并接受的权衡。
   *  失败只 warn：归档是增强项，且升级后本会话已让位分支、不重试，绝不阻断升级结果。 */
  const archiveParent = async (session) => {
    const registry = svc(ctx, 'workspaceRegistry')
    if (typeof registry?.archiveSession !== 'function') {
      ctx.logger?.info?.(`[session-escalation] workspaceRegistry.archiveSession 缺席 —— 旧会话 ${session.id} 不归档（保留在会话列表）`)
      return
    }
    try {
      await registry.archiveSession(session.id, { stopActivity: true })
      ctx.logger?.info?.(`[session-escalation] 旧会话已归档: ${session.id}（可在归档区恢复）`)
    } catch (error) {
      ctx.logger?.warn?.(`[session-escalation] 归档旧会话 ${session.id} 被拒（升级不受影响）: code=${String(error?.code)} msg=${String(error?.message ?? error)}`)
    }
  }

  const doEscalate = async (agent, rec, session) => {
    const agentsSvc = svc(ctx, 'agents')
    const create = agentsSvc?.create
    if (typeof create !== 'function') {
      ctx.logger?.warn?.('[session-escalation] ctx.agents.create 不可用 —— 无法升级')
      return false
    }
    const events = session.snapshotEvents?.() ?? []
    const boundary = latestCompletedTurnBoundary(events)
    if (boundary === null) {
      ctx.logger?.info?.(`[session-escalation] ${session.id}: 无已完成 turn 可作 fork 边界 —— 本轮不动作`)
      return false
    }
    const seed = buildCompletedTurnSeed(events, boundary)
    const childId = `session-${crypto.randomUUID()}`
    const seqNo = rec.escalations + 1
    const header = session.header ?? {}
    // 对齐 controller fork 配方（api-session-controller.js:794-798）：meta 只有
    // cwd/isSeeded/agentPreset —— 不设 parentSession，分支即"同级"（用户需求）。
    const meta = {
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      isSeeded: true,
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    }
    const agentOptions = {}
    try {
      const sel = svc(ctx, 'agentDefaultModel')?.currentSelection?.()
      if (sel?.provider !== undefined && sel?.model !== undefined) {
        agentOptions.provider = sel.provider
        agentOptions.model = sel.model
        if (sel.reasoningEffort !== undefined) agentOptions.reasoningEffort = sel.reasoningEffort
      }
    } catch { /* 能力探测失败 → 空 agentOptions，宿主默认兜底 */ }

    // preset mount（controller composeAgent :264-277 的真实配方；installModelSelection
    // 为宿主私有，不复制 —— 由 agentOptions 的显式 provider/model 覆盖选型）
    let setup = undefined
    const presets = svc(ctx, 'agentPresets')
    if (presets !== undefined && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
      const resolved = await presets.resolve(header.agentPreset ?? undefined)
      setup = async (agentCtx) => { await presets.mount(agentCtx, resolved.id) }
    }

    try {
      const handle = await create.call(agentsSvc, {
        sessionId: childId,
        seed,
        inheritedEventCount: boundary + 1,
        meta,
        ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
        ...(setup === undefined ? {} : { setup }),
        // 不传 parentAgent：controller fork 配方（:790-804）同样不传 ——
        // 传了会建立子所有权，父 agent .dispose 会连带拆掉分支；
        // 用户需求是"同级"，分支必须独立于父会话生命周期。
      })
      const childAgent = handle?.agent ?? handle
      // workspace attach（controller :808-815 配方的尽力复刻；失败只记日志不回滚分支）
      try {
        const workspace = svc(ctx, 'workspaceRegistry')?.list?.()?.find((w) => w.sessionIds?.includes(session.id))
        if (workspace !== undefined && typeof workspace.attachSession === 'function') {
          await workspace.attachSession(childId)
        }
      } catch (error) {
        ctx.logger?.warn?.(`[session-escalation] 子会话 ${childId} workspace attach 失败: ${String(error)}`)
      }
      rec.escalations += 1
      rec.escalatedTo = childId
      const childRec = ledger.ensure(childId)
      childRec.depth = rec.depth + 1
      ctx.logger?.info?.(`[session-escalation] 升级完成: ${session.id} → ${childId} (边界 seq=${boundary}, depth=${childRec.depth})`)
      // 命名（可配，renameOnEscalate=false 时保持宿主默认标题）
      if (cfg.renameOnEscalate) renameChild(session, childId, seqNo)
      // autoContinue：分支继承完整历史后，自动发一条续作消息驱动新会话继续任务。
      // 配方逐字节对齐 dsh-automation（lib/index.js:21764: handle.agent.followup(
      // createUserMessage({content:[{type:"text",…}],source:{kind:"automation",…}}))）。
      if (cfg.autoContinue && cfg.continuePrompt.length > 0) {
        try {
          const createUserMessage = await resolveCreateUserMessage()
          childAgent?.followup?.(createUserMessage({
            content: [{ type: 'text', text: cfg.continuePrompt }],
            source: { kind: 'session-escalation', parentSessionId: session.id, boundarySeq: boundary },
          }))
          ctx.logger?.info?.(`[session-escalation] 续作消息已投递 → ${childId}`)
        } catch (error) {
          ctx.logger?.warn?.(`[session-escalation] 续作投递失败（分支已建好，可手动继续）: ${String(error)}`)
        }
      }
      // 归档旧会话（可配）：子侧（分支/命名/续作）全部落定后再做父侧收尾。
      if (cfg.archiveParentOnEscalate) await archiveParent(session)
      return true
    } catch (error) {
      ctx.logger?.warn?.(`[session-escalation] 升级失败: ${String(error)}`)
      return false
    }
  }

  const evaluate = async (session) => {
    const rec = ledger.ensure(session.id)
    if (rec.escalatedTo !== null) return // 已让位给分支
    if (rec.busy) return
    const agent = svc(ctx, 'agents')?.get?.(session.id)
    if (agent === undefined) return
    rec.busy = true
    try {
      const { occupancy, contextWindow } = readOccupancy(session)
      const verdict = decide({
        occupancy,
        contextWindow,
        compactionsDone: rec.compactions,
        escalationsDone: rec.escalations,
        chainDepth: rec.depth,
        agentIdle: true,
      }, cfg)
      rec.lastDecision = { ...verdict, occupancy, contextWindow, at: Date.now() }
      if (verdict.action === 'none') return
      if (verdict.action === 'compact') {
        await doCompact(agent, rec, session)
        return
      }
      // escalate；或压缩不可用时的第二次机会走 decide 重评
      const done = await doEscalate(agent, rec, session)
      if (!done && rec.escalations === 0) {
        ctx.logger?.info?.(`[session-escalation] ${session.id}: 升级未执行 —— 下一 turn 重评`)
      }
    } finally {
      rec.busy = false
    }
  }

  // 每 turn/end 之后重评（compactNow 的 busy 语义 + followup 排空 → turn 边界是最稳的 idle 点）
  const off = ctx.on?.('session/event', (session, event) => {
    if (!cfg.enabled) return
    if (event?.type !== 'turn/end') return
    if (ORIGIN_SKIP.has(session?.header?.origin)) return
    // fire-and-forget：错误在 evaluate 内部日志化；不阻塞事件提交路径
    Promise.resolve().then(() => evaluate(session)).catch((error) => {
      ctx.logger?.warn?.(`[session-escalation] evaluate 异常: ${String(error)}`)
    })
  })

  ctx.commands?.register?.({
    name: 'escalation',
    description: '会话两级阈值治理状态（@zjjlivingfree/dsh-session-escalation）',
    handler: (invocation) => {
      const sid = invocation?.agent?.session?.id
      const rec = sid === undefined ? undefined : ledger.map.get(sid)
      const titles = svc(ctx, 'sessionTitle')
      const lines = [
        `session-escalation v${VERSION} · ${cfg.enabled ? '启用' : '停用'} · autoContinue=${cfg.autoContinue} · renameOnEscalate=${cfg.renameOnEscalate} · archiveParentOnEscalate=${cfg.archiveParentOnEscalate}`,
        `配置来源: ${cfgSource}${cfgError === null ? '' : ` · ⚠ 配置非法已停用: ${cfgError}`}`,
        '配置面: ' + (schemaInfo.hasGui ? '插件管理页可编辑（volatile schema @ ' + schemaInfo.profileDir + '）' : '仅文件 —— ' + schemaInfo.reason) + ',',
        `阈值 L1=${cfg.thresholdRatio1} L2=${cfg.thresholdRatio2} · 额度 compact=${cfg.maxCompactPerSession} escalate=${cfg.maxEscalatePerSession} depth≤${cfg.maxChainDepth}`,
        `命名模板: ${cfg.nameTemplate} · 占位符 {parent}{parentId}{n}{time}{date}{uuid8} · sessionTitle=${typeof titles?.rename === 'function' ? '就绪' : '缺席（分支保留默认标题）'}`,
        `compaction 引擎: ${typeof svc(ctx, 'compaction')?.compactNow === 'function' ? '就绪' : '缺席（bili gate 或无引擎 → 直接升级路径）'}`,
        `sessionProjections: ${typeof svc(ctx, 'sessionProjections')?.snapshot === 'function' ? '就绪' : '缺席（无法度量 → 全停用）'}`,
        `归档引擎: ${typeof svc(ctx, 'workspaceRegistry')?.archiveSession === 'function' ? '就绪' : '缺席（升级后旧会话保留在会话列表）'}`,
        ...(rec === undefined
          ? ['当前会话: 无账本记录（未触发过评估或宿主刚重启）']
          : [`当前会话 ${sid}: compact=${rec.compactions} escalate=${rec.escalations} depth=${rec.depth}` + (rec.escalatedTo ? ` → 分支 ${rec.escalatedTo}` : ''),
            `上次判定: ${rec.lastDecision === null ? '无' : JSON.stringify(rec.lastDecision)}`]),
        ...(cfgSource !== 'default' ? ['提示: 改配置后需重载插件才生效（apply 内 cfg 为闭包常量）'] : []),
        ...(off === undefined ? ['⚠ ctx.on 不可用 —— 未挂事件监听，插件实际未运行'] : []),
      ]
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  ctx.effect?.(() => () => { off?.() }, 'session-escalation')
}

export { apply, inject, name, Config }
