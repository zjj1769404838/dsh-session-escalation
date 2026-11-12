/**
 * dsh-session-escalation — 两级阈值会话治理策略（纯函数，零依赖）
 *
 * 契约见 ../CONTRACT.md。输入是当前会话占用快照 + 历史动作计数，
 * 输出是唯一决定的下一步动作。不碰 ctx，不碰 IO —— 门禁只测这里。
 *
 * 语义：
 *   L1（thresholdRatio1）：达到 → 自动压缩（compactNow），最多 maxCompactPerSession 次。
 *   L2（thresholdRatio2）：达到、或压缩额度耗尽后仍高于 L1 → 升级：
 *        fork 同级新会话继承完整历史继续任务。最多 maxEscalatePerSession 次（默认 1），
 *        升级后的子会话重新获得完整额度，但整条链受 maxChainDepth 封顶。
 *
 * @module dsh-session-escalation/policy
 */

/** 命名模板支持的占位符全集（未知占位符在 resolveConfig 阶段即拒绝，fail-closed）。 */
export const NAME_PLACEHOLDERS = Object.freeze(['parent', 'parentId', 'n', 'time', 'date', 'uuid8'])

export const DEFAULT_NAME_TEMPLATE = '{parent}-续{n}'

const PLACEHOLDER_RE = /\{([^{}]*)\}/g

export const DEFAULTS = Object.freeze({
  enabled: true,
  thresholdRatio1: 0.70,
  thresholdRatio2: 0.90,
  maxCompactPerSession: 2,
  maxEscalatePerSession: 1,
  maxChainDepth: 16,
  autoContinue: true,
  continuePrompt: '上一会话已因上下文占用达到升级阈值而在此继续。请回顾继承的历史，直接继续未完成任务，不要向用户重复确认。',
  renameOnEscalate: true,
  nameTemplate: DEFAULT_NAME_TEMPLATE,
  // 升级成功（分支已建好）后，把旧会话归档 —— 用户 2026-11-10 明确要求默认开启。
  // 归档是宿主 workspaceRegistry 的原生能力（可逆：不改 workspace 成员关系，只进全局归档集）。
  archiveParentOnEscalate: true,
})

/**
 * 渲染命名模板。未知占位符原样保留（校验在 validateNameTemplate 阶段完成，
 * 此处不做二次判定，保证渲染是纯函数）。
 * @param template - 含 {placeholder} 的模板串
 * @param vars - 占位符取值表
 * @returns 渲染后的字符串（未 trim，由调用方决定）
 */
export function renderName(template, vars) {
  if (typeof template !== 'string') throw new Error(`nameTemplate must be a string, got ${typeof template}`)
  const table = vars ?? {}
  return template.replace(PLACEHOLDER_RE, (whole, key) => {
    const v = table[key]
    return v === undefined || v === null ? whole : String(v)
  })
}

/**
 * 校验命名模板：非空、只含已知占位符、样例渲染后非空。
 * @throws 任一条件不满足
 */
export function validateNameTemplate(template) {
  if (typeof template !== 'string') throw new Error(`nameTemplate must be a string, got ${typeof template}`)
  if (template.trim() === '') throw new Error('nameTemplate must not be empty')
  const unknown = []
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    if (!NAME_PLACEHOLDERS.includes(m[1])) unknown.push(m[1])
  }
  if (unknown.length > 0) {
    throw new Error(`nameTemplate has unknown placeholder(s) ${unknown.map((k) => `{${k}}`).join(', ')}; supported: ${NAME_PLACEHOLDERS.map((k) => `{${k}}`).join(', ')}`)
  }
  const sample = renderName(template, {
    parent: '父会话', parentId: 'session-00000000-0000-4000-8000-000000000000',
    n: 2, time: '120000', date: '20260101', uuid8: 'deadbeef',
  })
  if (sample.trim() === '') throw new Error('nameTemplate renders to an empty string')
}

/** 校验后的配置构造；非法即抛（fail-closed，不允许静默的坏阈值）。 */
export function resolveConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw ?? {}) }
  if (!(cfg.thresholdRatio1 > 0 && cfg.thresholdRatio1 < 1)) throw new Error(`thresholdRatio1 must be in (0,1), got ${cfg.thresholdRatio1}`)
  if (!(cfg.thresholdRatio2 >= cfg.thresholdRatio1 && cfg.thresholdRatio2 < 1)) throw new Error(`thresholdRatio2 must be in [thresholdRatio1,1), got ${cfg.thresholdRatio2}`)
  for (const k of ['maxCompactPerSession', 'maxEscalatePerSession', 'maxChainDepth']) {
    if (!Number.isSafeInteger(cfg[k]) || cfg[k] < 0) throw new Error(`${k} must be a non-negative safe integer, got ${cfg[k]}`)
  }
  for (const k of ['enabled', 'autoContinue', 'renameOnEscalate', 'archiveParentOnEscalate']) {
    if (typeof cfg[k] !== 'boolean') throw new Error(`${k} must be a boolean, got ${typeof cfg[k]}`)
  }
  if (typeof cfg.continuePrompt !== 'string') throw new Error(`continuePrompt must be a string, got ${typeof cfg.continuePrompt}`)
  validateNameTemplate(cfg.nameTemplate)
  return Object.freeze(cfg)
}

/**
 * 单一决策点。
 * @param obs - { occupancy:number|null, contextWindow:number|null,
 *                compactionsDone:number, escalationsDone:number, chainDepth:number,
 *                agentIdle:boolean }
 * @param cfg - resolveConfig 的结果
 * @returns { action:'none'|'compact'|'escalate', reason:string, ratio:number|null }
 *   ratio=null 当占用或窗口未知（不可核验 → 不动作，fail-closed）。
 */
export function decide(obs, cfg) {
  const { occupancy, contextWindow, compactionsDone, escalationsDone, chainDepth, agentIdle } = obs
  const none = (reason, ratio = null) => ({ action: 'none', reason, ratio })
  if (!cfg.enabled) return none('disabled')
  if (occupancy === null || contextWindow === null || !(contextWindow > 0)) return none('unknown-occupancy')
  if (!agentIdle) return none('agent-busy')
  const ratio = occupancy / contextWindow
  if (ratio < cfg.thresholdRatio1) return none('below-l1', ratio)
  const escalateExhausted = escalationsDone >= cfg.maxEscalatePerSession || chainDepth >= cfg.maxChainDepth
  // L2：直接升级
  if (ratio >= cfg.thresholdRatio2) {
    return escalateExhausted
      ? none('escalate-budget-exhausted', ratio)
      : { action: 'escalate', reason: 'l2-threshold', ratio }
  }
  // L1..L2 区间：先压缩；压缩额度耗尽仍超 L1 → 兜底升级
  if (compactionsDone < cfg.maxCompactPerSession) return { action: 'compact', reason: 'l1-threshold', ratio }
  if (escalateExhausted) return none('compact-budget-exhausted', ratio)
  return { action: 'escalate', reason: 'compact-budget-exhausted-while-above-l1', ratio }
}
