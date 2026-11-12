/**
 * 宿主配置 schema（v0.4 起为「真 schemastery 实例」）
 *
 * 为什么必须是真 schemastery（全部源码实证，host 0.2.2-rc.1）：
 *   1. dsh-settings `schema(entry)`（dsh-settings/lib/index.js:539-543）要求
 *      `entry.fiber.runtime.Config` 上存在 `toJSON`，否则该 entry 在设置面
 *      完全不可见。
 *   2. `volatileForm(schema)`（:122-133）与 `isVolatilePath`（:148-155）直接读
 *      `schema.meta` / `schema.dict`，并把 `plainSchema` 交给客户端时用
 *      `new z(schema.toJSON())`（:104-120）重建 —— 手写扁平 JSON 用真 z 重建
 *      会得到空壳（实测：`REBUILD_OK type=undefined dictKeys=[]`，
 *      `rebuilt is not a function`），所以手写零依赖对象无法进入 GUI。
 *   3. `.volatile()` 字段的值在运行时是活引用（`{get()}` + 内部
 *      `Symbol(cosmokit.volatile.write)`）：loader `_commitVolatile`
 *      （cordis_loader.js:395-419）就地写引用，插件持有的闭包引用因此能感知
 *      热更新、无需重挂载。非 volatile 字段变更会重挂载 fiber。
 *
 * 为什么用 createRequire 而不是静态 import：
 *   插件以 junction 挂在 profile 下（profile/node_modules/@zjjlivingfree/... →
 *   D:\my-projects\plugins\...）。Node 按 fs.realpathSync 后的真实路径找
 *   node_modules，从 D:\my-projects\plugins 解析不到 profile 的依赖，静态
 *   `import '@deepseek-ai/schemastery'` 会 ERR_MODULE_NOT_FOUND（真机实证）。
 *   而 `createRequire(<profile>/package.json)('@deepseek-ai/schemastery')`
 *   可以正常解析到 profile 内的 v3.19.0。
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { resolveConfig } from './policy.js'
import os from 'node:os'
import path from 'node:path'

/** profile 根目录的候选路径（按可信度排序）。 */
function profileCandidates() {
  const out = []
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') out.push(fromEnv)
  const home = os.homedir()
  const root = path.join(home, '.dsh', 'profiles')
  const preferred = process.env.DSH_PROFILE
  if (typeof preferred === 'string' && preferred !== '') out.push(path.join(root, preferred))
  out.push(path.join(root, 'desktop'), path.join(root, 'web'))
  try {
    for (const name of readdirSync(root)) out.push(path.join(root, name))
  } catch { /* 无 profiles 目录 → 只剩上面的固定候选 */ }
  return out
}

/** 解析真 schemastery；失败返回 undefined（fail-closed，插件仍可运行但无 GUI 表单）。 */
export function loadSchemastery() {
  for (const dir of profileCandidates()) {
    const manifest = path.join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const z = createRequire(manifest)('@deepseek-ai/schemastery')
      if (typeof z === 'function' && typeof z.object === 'function') return { z, profileDir: dir }
    } catch { /* 该 profile 没装/解析失败 → 试下一个 */ }
  }
  return undefined
}

/**
 * 配置字段元数据：只描述「怎么渲染 / 什么类型」，**默认值一律取自
 * policy.js 的 DEFAULTS**，绝不在此重复写一份 —— 否则两个文件会漂移，
 * 而漂移的表现是「面板显示 0.70、实际判定用 0.75」这种最难查的错。
 */
export const FIELD_SPECS = Object.freeze([
  { key: 'enabled', kind: 'boolean', label: '总开关', hint: '停用后不再评估任何会话' },
  { key: 'thresholdRatio1', kind: 'ratio', label: '第一级阈值（压缩）', hint: '上下文占用比达到该值即压缩' },
  { key: 'thresholdRatio2', kind: 'ratio', label: '第二级阈值（升级）', hint: '达到该值即建立继承分支' },
  { key: 'maxCompactPerSession', kind: 'count', label: '每会话压缩上限', hint: '用尽后直接转升级' },
  { key: 'maxEscalatePerSession', kind: 'count', label: '每会话升级上限', hint: '0 表示永不升级' },
  { key: 'maxChainDepth', kind: 'count', label: '继承链深上限', hint: '防止无限升级' },
  { key: 'autoContinue', kind: 'boolean', label: '自动续作', hint: '分支建立后自动投递续作消息' },
  { key: 'renameOnEscalate', kind: 'boolean', label: '自动命名', hint: '按模板给分支起标题' },
  { key: 'archiveParentOnEscalate', kind: 'boolean', label: '自动归档旧会话', hint: '升级成功后把旧会话归档（可从归档区恢复），会取消其置顶' },
  { key: 'nameTemplate', kind: 'text', label: '命名模板', hint: '占位符 {parent} {parentId} {n} {time} {date} {uuid8}' },
  { key: 'continuePrompt', kind: 'text', label: '续作提示词', hint: '投递给分支的首条用户消息' },
])

/** 字段元数据必须与 DEFAULTS 完全对齐（键集合 + 类型），否则直接抛。 */
function assertSpecsMatch(defaults) {
  const specKeys = FIELD_SPECS.map((s) => s.key)
  const defKeys = Object.keys(defaults)
  const missing = defKeys.filter((k) => !specKeys.includes(k))
  const extra = specKeys.filter((k) => !defKeys.includes(k))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`FIELD_SPECS 与 DEFAULTS 不一致 —— 缺: ${missing.join(',') || '无'}; 多: ${extra.join(',') || '无'}`)
  }
}

/** 解引用 volatile 活引用（`{get()}`）。 */
function derefValue(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

/**
 * 给真 schemastery schema 套一层语义校验。
 *
 * 为什么必须有这一层：真 schema 只管类型与区间，管不到跨字段语义 ——
 * 实测 `validate({thresholdRatio1: 0.9, thresholdRatio2: 0.5})` **通过**，
 * `validate({nameTemplate: '{nope}'})` 也**通过**。这两类非法组合若只靠
 * apply 兜底，用户会在 GUI 里存下一个"能保存但一保存就停用插件"的配置。
 * 故在 `~standard.validate` 外再跑一遍 policy.js 的 resolveConfig（单一事实源），
 * 让非法组合在写入点就被拒绝。
 *
 * 实现约束：只在自己的实例上定义 `~standard`（不污染原型、不改 toJSON），
 * 且 vendor 原样保留 —— cordis_loader 的 isSchemastery 判据就是 vendor 字符串
 * （cordis_loader.js:251-253）。
 */
function withSemanticValidation(schema, defaults) {
  const base = schema['~standard']
  if (base === undefined || typeof base.validate !== 'function') {
    throw new Error('schemastery schema 缺少 ~standard.validate，无法挂语义校验')
  }
  const wrapped = Object.freeze({
    version: base.version,
    vendor: base.vendor,
    validate(input) {
      const result = base.validate(input)
      // cordis resolveConfig 明确拒绝异步（cordis.js:244-250），这里提前给同款信号
      if (result !== null && typeof result === 'object' && 'then' in result) {
        throw new TypeError('Async config validation is not supported')
      }
      if (result.issues !== undefined) return result
      const plain = {}
      for (const k of Object.keys(result.value ?? {})) plain[k] = derefValue(result.value[k])
      try {
        resolveConfig({ ...defaults, ...plain })
      } catch (error) {
        return { issues: [{ message: String(error?.message ?? error) }] }
      }
      return result
    },
  })
  Object.defineProperty(schema, '~standard', { get: () => wrapped, configurable: true, enumerable: false })
  return schema
}

/** 用真 schemastery 构造配置 schema。所有字段 volatile → 可在 GUI 编辑且热更新。 */
export function buildSchema(z, defaults) {
  assertSpecsMatch(defaults)
  const dict = {}
  for (const spec of FIELD_SPECS) {
    const def = defaults[spec.key]
    let s
    if (spec.kind === 'boolean') s = z.boolean().default(def)
    else if (spec.kind === 'ratio') s = z.number().min(0.01).max(0.99).default(def)
    else if (spec.kind === 'count') s = z.natural().default(def)
    else s = z.string().default(def)
    dict[spec.key] = s.description(spec.label).volatile()
  }
  return withSemanticValidation(z.object(dict), defaults)
}

/**
 * 零依赖兜底 Config（schemastery 不可用时）。
 * 它没有 toJSON，因此宿主设置面会忽略该 entry —— 这是刻意的 fail-closed：
 * 宁可在 GUI 里看不到表单并在 /escalation 面板明确提示，也不要伪造一个
 * 无法被 `new z(schema.toJSON())` 重建的假 schema。
 */
const FALLBACK = Object.freeze({
  get '~standard'() {
    return {
      version: 1,
      vendor: 'dsh-session-escalation-fallback',
      validate: (input) => ({ value: input === null || input === undefined ? {} : input }),
    }
  },
})

const resolved = loadSchemastery()

/**
 * 构造本插件的 Config。
 * @param defaults policy.js 的 DEFAULTS —— 唯一默认值来源
 * @returns {{ Config: object, hasGui: boolean, profileDir?: string, reason: string }}
 */
export function createConfig(defaults) {
  if (resolved === undefined) {
    return {
      Config: FALLBACK,
      hasGui: false,
      reason: '未找到可用的 @deepseek-ai/schemastery —— 配置仅能经 cordis.patch.yml / env 提供，宿主设置面不会显示本插件表单',
    }
  }
  return {
    Config: buildSchema(resolved.z, defaults),
    hasGui: true,
    profileDir: resolved.profileDir,
    reason: `真 schemastery（${resolved.profileDir}）`,
  }
}
