# dsh-session-escalation 契约（单一真相源）

> 目标（用户原话 m00255）：达到某个阈值则先自动压缩会话；后续达到更大阈值则在**同级新开会话继承继续任务**。
> v0.3 追加（用户原话 m00960）："我想知道这些是否能改成配置化？新会话命名是否能自定义规则？"
> 证据基线：DSH NEXT `D:/apps/DeepSeek Harness/DSH NEXT/resources/app.asar`，host 包版本 0.2.2-rc.1。
> 所有行号来自 asar 提取到 `C:/Users/17694/AppData/Local/Temp/*.js` 的源码实读。行号会随版本漂移，引用前重新校准（教义）。宿主 client bundle 夹具 2026-11-11 起由 `tools/extract-host-client.mjs` 落 `fixtures/`（不再依赖 %TEMP%；`DSH_APP_ASAR` / `DSH_HOST_CLIENT_MODULES` 可覆盖）。

## 已验证 API（磁盘实据）

### A1. 会话继承原语：`ctx.sessions.fork(source, boundary?, childSessionId?)`
- 源：dsh-session-main.js:2025-2039（SessionStore 即 `ctx.sessions`，见 :1717 注释 "In-memory session store (`ctx.sessions`)"）
- 语义：从活源会话的**精确事件前缀**创建独立活会话；boundary 是包含式源事件 seq，省略=源当前最后事件；开放尾部自动补 synthetic tool results 与 step/turn closers；`inheritedEventCount` 只计复制事件。
- seed 由 `buildForkSeed` 生成 = 前缀 + `{type:"session/end-seed", seq:boundary+1, time:events[boundary].time, data:{inherited:true}}` + openTurnClosers。
- 子会话继承 cwd，`isSeeded: true`（:2034-2037）。
- 插件实现取更保守的路径：自算 `latestCompletedTurnBoundary`（最后一个 `turn/end` 的 seq）后调 `agents.create` 传 seed，**不直接调 fork**（见 A5）。

### A2. 会话读取：`ctx.sessions.get(id)` / `list()`；Session 面
- dsh-session-main.js:1999/2006；`session.surface`(:1331), `session.seq`(:1479), `eventAt(seq)`(:1441), `snapshotEvents()`(:1454)。
- 各事件 seq 在 `snapshotEvents()` 数组里按序，触发器 `turn/end` 的 seq 即 boundary 候选。

### A3. Token 用量：`contextPressure` 投影（token-meter 注册）——缺口 G1 已闭合
- 注册链：dsh-token-meter.js:793 `TokenMeter extends Service`, :795 `static inject=["sessionProjections"]`, :807 `ctx.sessionProjections.register(contextPressureProjectionDefinition)`。
- key: `"contextPressure"`（dsh-token-meter.js:450），stateVersion 5。
- 字段：`contextWindow?`、`pressureTokens?` = `usage.inputTokens + cacheReadTokens + cacheWriteTokens`（:368 `pressureFrom`）、`surfaceTokens`、`projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`（:488-496 wire view）。
- **读取方 API（G1 结论）**：`ctx.sessionProjections.snapshot(session, keys)`（dsh-session-projection.js:232），**同步**返回 `{asOfSeq, values}`。`cachedSnapshot` 已 deprecated（:254 明确 "never use it to decide behavior"）。
- 插件实际取值：`view.projectedTokens ?? view.pressureTokens ?? null`，`view.contextWindow ?? null`；任一为 null → fail-closed 零动作。

### A4. 触发压缩：`ctx.compaction.compactNow(agent, signal?, sourceCommandId?)`
- seam：dsh-compaction.js:169-173 `CompactionEngine extends Service(ctx,"compaction")`。
- 实现：dsh-compaction-basic.js:1002 `compactNow(agent, signal, sourceCommandId)`；返回 `null` 或 `{shadowedSeqs, shadowedTokenCount, summarySeq}`。
- 失败：`ManualCompactionError` codes: busy/cancelled/changed/summary/commit/persistence（dsh-command-compact.js:20-42）。**`busy` 不消耗额度，下轮重试**（插件已实现）。
- **G2 结论（与 bili gate 共存）**：本机 `compaction-basic`/`command-compact` 均 `enabled:false`、`bili-compaction-gate` active → `ctx.compaction` 缺席。插件策略：无引擎时把 `rec.compactions` 置满并**直接转升级路径**（有门禁 `无 compaction 引擎 → L1 也转升级路径` 覆盖）。

### A5. fork → 可运行 agent 的官方配方 —— 缺口 G4 已闭合
- 权威先例：`api-session-controller.js:756-823`（宿主 GUI"从检查点分支"）。
  - `childId = brandString(\`session-${randomUUID()}\`)` @:786
  - `composition = await this.agents.composeAgent(presetForObservation(source))` @:787
  - `agentOptions: {provider, model}` 来自 `ctx.agentDefaultModel.currentSelection()` @:789
  - `meta: {cwd, isSeeded: true, agentPreset?}` @:794-798（**不含 parentSession，保同级**）
  - `agents.create({sessionId, seed, inheritedEventCount: boundary+1, meta, agentOptions, setup})`
  - `workspace.attachSession(childId)` @:809，失败抛 `session/workspace-attach-failed`
- agent 动作语汇（dsh-agent-loop.js:564-578）：`followup`=`send(…,"next-turn",true)`、`steer`=`"next-step"`、`inject`=`"next-step"` 不唤醒。
- `createUserMessage` 在 dsh-llm（`createMessage` @1604 = `deepFreeze(structuredClone({...input, id: brandString(randomUUID())}))`）；user 消息 source 只校验 `typeof source.kind === "string" && kind !== ""`（dsh-session-main.js:1205）。
- 生产先例：`@michengai/dsh-automation` 用 `handle.agent.followup(createUserMessage({content:[…], source:{kind:"automation",…}}))`。
- **插件实现**：不传 `parentAgent`（保同级）；`setup` 由 `agentPresets.resolve(presetId)` + `presets.mount(agentCtx, presetId)` 组装（composeAgent 内 installModelSelection 为宿主私有，改用显式 `agentOptions`）。

### A6. 事件面（触发评估挂点）
- `ctx.on("session/event", (session, event) => ...)`。
- 触发点：`event.type === 'turn/end'` 且 `session.header.origin` 不在 `ORIGIN_SKIP = {'subagent'}`；动作排进 `Promise.resolve().then()` 避开 turn 收尾。
- 事件名枚举：KNOWN_SESSION_EVENT_TYPES（dsh-session-main.js:79-137），含 `turn/start`、`turn/end`、`step/start`、`step/end`、`request/context`、`assistant/message`、`session/title`(:115)、`session/title-llm-request`(:116)。

### A7. 插件配置管线：`apply(ctx, config)` + 导出 `Config` —— v0.3 新增，已实证
- `Registry.plugin` @cordis.js:1691-1713：`runtime = {name, callback, fibers, Config: plugin.Config}` —— **`Config` 取自插件对象本身**，函数式插件导出 `Config` 即可（也可挂 `apply.Config`）。
- 执行 @cordis.js:359-365：`const config = this.resolveConfig(this.config)` → `runtime.callback(this.ctx, config)`，即 **`apply` 第二参数是校验后的配置**。
- `resolveConfig(runtime, config)` @cordis.js:244-250：无 `Config` 直接返回原值；否则 `runtime.Config["~standard"].validate(config)`；**`"then" in result` 即抛 `TypeError("Async config validation is not supported")`**（必须同步）；`result.issues` → `ValidationError(issues)`（issues 形状 `{message, path?}`，path 用于 `(at a.b)`）；否则返回 `result.value`。
- 🔴 **插件不能静态 `import z from '@deepseek-ai/schemastery'`**：junction 挂载时 `fs.realpathSync` 解回 `D:/my-projects/plugins/...`，Node 按真实路径祖先链找 node_modules，**看不到 profile 依赖**（实测 `ERR_MODULE_NOT_FOUND`；`mklink /J` 在插件目录下也建不成，`Operation not permitted`）。
- ✅ **但可以 `createRequire` 拿到真 schemastery**：`createRequire('C:/Users/<u>/.dsh/profiles/desktop/package.json')('@deepseek-ai/schemastery')` 成功（实测 v3.19.0，导出 `ValidationError/extend/resolve/from/lazy/natural`）。v0.4 起 `lib/config-schema.js` 按 `DSH_PROFILE_DIR` → `~/.dsh/profiles/${DSH_PROFILE}` → `desktop` → `web` → 全部 profile 的顺序探测，命中即用真 schema 构造函数建 `Config`。
- 🔴 **手写 toJSON 的零依赖 Config 不可行**（v0.3 路线已证伪）：`plainSchema` 走 `new z(schema.toJSON())`，喂手写扁平 JSON 得到 `type=undefined, dictKeys=[], rebuilt is not a function`。schemastery 的 `toJSON()` 必须是真实例产出的 uid/refs 图。
- 热改语义：只改 config 走 update 不重建 fiber（`equalExceptVolatile` @cordis_loader.js:285-287，`isSchemastery` 判据是 `schema?.["~standard"].vendor === "schemastery"`）。但 **`apply` 内若把 config 摊平成快照，热改不会生效**；v0.4 用 `liveConfig(layers)`（每次访问都 `deref` 的 getter 视图）承载热更新。

### A9. GUI 配置面：`plugins.row.config` 槽位 + `configForms` —— v0.4 新增，已实证
- **入口不是设置页**：`dsh-free-search/lib/client.js:2690` 源码注释明写「rc.1 废弃了旧版设置页的插件配置 slot，只保留 `plugins.row.config`」。用户可见路径 = **插件管理页 → 插件那一行 → 配置页**。
- 槽位 key 规则 `` `${bundle}#${rowId}` ``（ui-plugin-manager `rowConfigKey`）；dsh-ops 用 `ROW_ID#ROW_ID`（client.js:1269-1272），free-search 用 `dsh-free-search#web-search-free`。本插件 = `@zjjlivingfree/dsh-session-escalation#session-escalation`。
- **宿主把表单直接塞进 slot props**：ui-plugin-manager `renderSlot("plugins.row.config", { view: "page", form }, { entryKey: key })`；`form = this.ctx.configForms.get(id)`，形状 `{ state: {status, value, writable, revision}, mutate(ops, revision) }`。**不需要自建 HTTP bridge，也不需要设置页。**
- `form.state.status` 必须 `'ready'` 且 `writable !== false` 才可写；`mutate` 的 `revision` 是 fencing token（冲突返回 false，需重取）。
- 设置页可见性硬门禁（`dsh-settings/lib/index.js`）：`schema(entry)` @:539-543 要求 `"toJSON" in Config`；`volatileForm` @:122-133 要求至少一个字段 `.meta.volatile`；`describe` @:411-465 要求 `entry.fiber.state === 2`（active）。三者缺一，entry 在设置面彻底不可见。
- ⚠ **设置页没有通用 schema 表单渲染器**（`autoGenerate` 无任何已发布客户端消费，与 dsh-settings README 一致），所以「改 volatile 就自动出表单」不成立，必须自带 `lib/client.js`。
- 客户端半边模块格式：`window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })`，导出 `apply` + `inject`；`package.json` 需 `dsh.client = { inject: [...], platform: "web" }` + `exports["./client"]`。
- volatile 运行时语义（实读 cosmokit `lib/index.js:83-113` + probe）：`.volatile()` 字段值不是裸值，而是 `{ get(), [Symbol.for("cosmokit.volatile.write")] }` 活引用；`JSON.stringify` 显示 `{}`。**所有消费处必须 `deref`**，否则阈值比较得到 `object`。

### A10. 旧会话归档：宿主原生 `workspaceRegistry.archiveSession` —— v0.4.1 新增，已实证
- **归档是宿主原生能力**（非社区插件私有）：`@deepseek-ai/dsh-workspace` 的 `WorkspaceRegistry`（`super(ctx, "workspaceRegistry")`，inject=["storageDomain","sessionPersistence"]）提供 `archiveSession(sessionId, options)` / `unarchiveSession` / `get archivedSessionIds`；归档**不改 workspace 成员关系**（可逆），副作用是**无条件取消置顶**。
- **`stopActivity` 语义**：`options.stopActivity !== true` 时走 `workspace/session-activity` 瀑布检查（dsh-agent `installTurnArchiveAdmission` 在 agent running 时上报 `{kind:"turn"}`）→ 抛 `WorkspaceActiveSessionError`；`stopActivity: true` 跳过检查并先发 `workspace/session-stop`（等价用户停止，取消运行中 turn）。
- **本插件取舍**（用户 2026-11-10 拍板：默认开启 + `stopActivity:true`）：升级是 L2 触发后的父侧收尾，接受「取消运行中 turn」的权衡；归档排在**子侧全部落定之后**（分支 → 改名 → 续作 → 归档）；`archiveSession` 抛错只 warn（升级不受影响），`workspaceRegistry` 缺席只 info（旧会话保留在会话列表），不重试不阻断。
- 门禁 4 组（test-flow 29→33）：默认开启恰一次且实参 `{stopActivity:true}` / 抛 `WorkspaceActiveSessionError` 只 warn 且续作照常 / registry 缺席 info 降级 + 面板「归档引擎: 缺席」/ 开关关闭绝不调用。变异 2 路真红见 `tools/mutate-archive.mjs`（第三路覆盖 client 槽位 key）。

### A8. 新会话命名：`ctx.sessionTitle.rename(session, title)` —— v0.3 新增，已实证
- 服务：`ctx.sessionTitle`（`super(ctx, "sessionTitle")` @title.js:219），`static inject = ["sessions","sessionProjections","agents"]` @:201-205。
- `rename(session, title)` @title.js:301-317：`assertServiceActive()` → 校验 `ctx.sessions.get(session.id) !== session` 抛错（**必须传 store 里的会话本体**）→ `normalizeSessionTitle(title, config.maxTitleBytes)` → 空则抛 `SessionTitleInvalidError` → `supersede(state, "user rename superseded automatic title generation")` → `session.append("session/title", {title, messageSeqs: [], source: {kind: "user"}})`。
- `get(session)` @:287-289 = `foldSessionTitle(session.snapshotEvents())`，用于取父会话当前标题。
- 服务缺席可能：`@deepseek-ai/dsh-experimental-session-titles-bundle` 列在 profile bundles，但包体在 asar 内、bundle 目录无 patch 文件 → **运行时靠 `ctx.get('sessionTitle')` 探测，绝不写进 `inject`**（否则宿主未挂时 fiber failed，v0.1 已踩过同类坑）。
- 未声明 inject 时读服务的正道：`ctx.get(name, strict=true)`（cordis.js:1347-1356），`strict` 要求 fiber 处于 active 才返回值；直接属性访问 `ctx.commands` 在未声明时**硬抛** `cannot get property "commands" without inject`。

### A12. v0.5 继承模式：干净新会话 + 交接消息 —— 连环升级根因修复，已实证
- **事故根因（2026-11-18，session-cc3272b4 磁盘取证）**：v0.4 的 escalate 用 `events.slice(0, boundary+1)` 整段克隆父历史 → 子会话出生即继承全部体积（该会话 5060/5239 事件为继承、解压 11.84MB ≈ 285 万 token、占用比 ≈285% ≥ L2）→ 第一个 turn/end 再触发升级 → 76 分钟连环 7 次、quick-notes 工作区堆出 9 个 seeded 兄弟会话。放大器：①`turn/end` 不分 reason（error/aborted 也评估，trae 通道 39 次 TRANSPORT 重试直接产升级）；②bili gate 下 `ctx.compaction` 缺席 → L1 恒"额度耗尽"直落升级路径。
- **宿主契约（app.asar 字节实读）**：`CreateAgentOptions.seed?/inheritedEventCount?` 均为可选（dsh-session 类型声明 "Exact fork-inherited prefix length when the session metadata sets `isSeeded`"）→ **不传 seed 且 meta 不写 isSeeded = 普通新会话**，与 GUI 新建同路径。
- **summary 模式（默认）**：`agents.create({sessionId, meta:{cwd?, agentPreset?}, agentOptions?, setup?})`，无 seed/inheritedEventCount/isSeeded；autoContinue 投递的交接消息正文 = `[交接] 你是第 n 次升级接棒会话。父会话：「标题」(父id)，交接时间 …。父会话历史未随本会话继承，细节可回查父会话（session <id>）。` + `continuePrompt`；`source.boundarySeq=null`。
- **full 模式（旧行为兜底档）**：保留 seed 配方，但建前估算 seed 体积（Σ JSON.stringify(event).length+1，tokens≈bytes/4）；估算 ≥ T2×contextWindow → 拒绝建立、**消耗升级额度**（防逐轮重试刷屏）、warn 留痕。
- **门禁**：summary 无 seed 断言、交接头内容断言、体积门禁拒绝+额度消耗、error/aborted turn 跳过（`tools/mutate-archive.mjs` 对 summary 守卫与 completed-only 守卫各有一路定向变异，真红+还原）。

## 设计（两级阈值状态机）

```
occupancy = projectedTokens（token-meter contextPressure 投影）
ratio = occupancy / contextWindow
每 turn/end 后异步评估（非 subagent、agent 空闲；v0.5：仅 reason.kind==='completed'，
  error/aborted 一律跳过 —— 2026-11-18 连环升级事故的放大器之一）：
  ratio ≥ T2 (0.90) 或 (压缩额度耗尽且 ratio ≥ T1) → escalate：
    inheritMode='summary'（v0.5 默认）：
      ctx.agents.create({sessionId: session-<uuid>, meta:{cwd, agentPreset?}, agentOptions, setup})
        —— 干净新会话：不传 seed / inheritedEventCount / isSeeded
      workspace.attachSession(childId)（尽力）
      renameOnEscalate → ctx.sessionTitle.rename(childSession, renderName(nameTemplate, vars))
      autoContinue → childAgent.followup(createUserMessage({
        content:[{type:'text', text:'[交接] 你是第 n 次升级接棒会话。父会话：「标题」(id)…' + continuePrompt}],
        source:{kind:'session-escalation', parentSessionId, boundarySeq:null} }))
    inheritMode='full'（v0.4 旧行为）：
      boundary = 最后一个 turn/end 的 seq → seed = 前缀 + end-seed 哨兵
      体积门禁：seed 估算 tokens(Σ JSON.stringify+1, /4) ≥ T2×contextWindow
        → 拒绝建立、消耗升级额度、warn（防"出生即超限→连环升级"复发）
      ctx.agents.create({sessionId, seed, inheritedEventCount: boundary+1,
                         meta:{cwd, isSeeded:true, agentPreset?}, agentOptions, setup})
      （rename / autoContinue 同上，boundarySeq=boundary）
    archiveParentOnEscalate → workspaceRegistry.archiveSession(session.id, {stopActivity:true})（排在子侧全部落定之后；失败/缺席不阻断）
  ratio ≥ T1 (0.70) 且压缩额度未耗尽 → ctx.compaction.compactNow(agent)（busy 不计数、下轮重试）
  防抖：每会话压缩 ≤ 2、升级 ≤ 1、链深 ≤ 16；agent 忙 / 度量缺失 → fail-closed
同级 = 不传 parentAgent，meta 不含 parentSession（对齐 controller）。
```

## 配置（宿主 config 管线，`resolveConfig` 全量校验）

`{ enabled, thresholdRatio1:0.70, thresholdRatio2:0.90, maxCompactPerSession:2, maxEscalatePerSession:1, maxChainDepth:16, inheritMode:'summary', autoContinue:true, continuePrompt:"…", renameOnEscalate:true, archiveParentOnEscalate:true, nameTemplate:"{parent}-续{n}" }`

- 首选入口：**GUI 插件管理页的表单**（A9）；文件级等价入口是 `cordis.patch.yml` 的 `config:`。
- 优先级：**宿主 config（GUI 写入 / patch）逐键优先 > `DSH_ESCALATION_CONFIG` > `DEFAULTS`**；面板显示 `host+env` / `host` / `env` / `default`。
- 校验分两层：类型/区间由 schemastery 负责（`z.number().min().max()` / `z.natural()` / boolean / string），**跨字段约束与命名模板占位符由 `withSemanticValidation` 负责**（`resolveConfig` 是唯一事实源，schema 层不重复实现）。
  - 实测缺口：裸 schemastery 会**放行** `{thresholdRatio1:0.9, thresholdRatio2:0.5}` 与 `{nameTemplate:'{nope}'}`，所以语义层不是冗余装饰。
- 非法 → fail-closed 停用并 warn；未知键 warn 忽略。
- **热更新**：volatile 字段写入后 `_commitVolatile` 就地更新引用，`liveConfig` 的 getter 视图立刻读到新值（门禁「活引用改动后同一 apply 实例读到新值」覆盖），**不需要重载插件**。

## 验证计划与实绩

1. 纯策略内核门禁 `test-policy.mjs`：**19/19 passed**（含命名模板 5 组、inheritMode 枚举 v0.5 一组）。
2. 宿主集成门禁 `test-flow.mjs`（假 ctx + 真实事件形状）：**38/38 passed**（含 config 优先级、语义校验、volatile 热更新、命名链路 6 组、归档 4 组、v0.5 六组：full seed 配方、summary 无 seed、summary 交接头、full 体积门禁、error 跳过、aborted/completed）。
3. 客户端门禁 `test-client.mjs`：**13/13 passed**（模块 id / inject / slot key 规则 / form 三态 / 控件类型 / 字段表与 DEFAULTS 对齐）。
4. 宿主真实管线门禁 `test-loader.mjs`：**14/14 passed**。它读取宿主真实的 `@deepseek-ai/dsh-client-modules` 客户端 bundle（夹具 `fixtures/client-modules-client.js`，由 `tools/extract-host-client.mjs` 从宿主 app.asar 提取；`DSH_APP_ASAR` / `DSH_HOST_CLIENT_MODULES` 可覆盖），在 `node:vm` 里建门面（同时兼容旧版 `window.__ModuleLoader__` 与宿主新版裸全局 `_ModuleLoader__`），再用**宿主的 `createClientModuleSystem`** 走完整链路：注册 factory → transport 触发 → `system.import()` → 拿到 `exports` → `apply(ctx)` → `ctx.slots.inject('plugins.row.config')` → 组件渲染。断言覆盖：模块 ID、`inject=['slots']`、注册 name/key（`@zjjlivingfree/dsh-session-escalation#session-escalation`）、summary 视图、无 form 降级、ready 时表单与 `revision=7`。
   - 这是**真管线不是桩**：宿主升级若改 `__DSH_BOOT__` wire 格式或 `__ModuleLoader__` 契约，本门禁会先红。
5. 四套门禁变异自检：策略门禁删 `unknown.length > 0` 判据 → exit 1；流程门禁删 `if (cfg.renameOnEscalate)` → exit 1；客户端门禁把 key 改成裸 `ROW_ID` → exit 1；真实管线门禁同样把 key 改成裸 `ROW_ID` → exit 1（`FAIL 注册 key = <包名>#<行id> :: got session-escalation`）。恢复后均 exit 0。定向变异套件 `tools/mutate-archive.mjs` v0.5 扩到 5 路：`stopActivity: true`→false → `FAIL 归档: 默认开启`；去掉 `if (cfg.archiveParentOnEscalate)` 守卫 → `FAIL 归档: archiveParentOnEscalate=false`；client 槽位 key 改裸 `ROW_ID` → `FAIL 注册 key`；**summary 守卫移除**（`...(summary ? {} : { seed, inheritedEventCount })` 改回无条件传）→ `FAIL v0.5 summary: L2 升级不传 seed`；**completed-only 守卫移除** → `FAIL v0.5 仅 completed turn 评估: reason=error 跳过`。五路全真红后字节级还原，clean 复跑 exit 0。
   - ⚠ 客户端变异首版是**假红**：`node -e` 里的反引号被 shell 吞掉导致语法错误退出 1，不是门禁抓到。改用 `mut-client.cjs`（读原文 → 写变异 → execSync 跑门禁 → 还原并校验字节）后才是真红。
   - ⚠ `test-loader.mjs` 夹具曾有 2 个夹具缺口（非应用缺陷）：`registrationTarget.mode` 必须是 `"queue"` 且**必须与 `sandbox.window.__ModuleLoader__` 是同一对象**（否则 bundle 注册到别处 → `loaded without registering`）；bootstrap 自身以"已物化 exports"传入时其自注册要从 pendingQueue 排除（否则 `duplicate factory registration`）。三处修好后才真绿。
6. 真机冒烟：v0.2 已验 fiber `active`（补 `inject=['commands','agents','sessionProjections']` 后）；v0.4 已验 fiber `active`（`plugin_manager list_plugins` → `include:session-escalation` / `@zjjlivingfree/dsh-session-escalation` / `fiberPhase:"active"`，total 280）。**GUI 视觉确认仍未做**：宿主 401 鉴权 + `windows_desktop` 无桌面能力，无法自动截图。

## 缺口台账（fail-closed）

- G1 投影读取公开签名 —— **已闭合**（`ctx.sessionProjections.snapshot`，projection.js:232，同步）
- G2 与 bili gate 共存语义 —— **已闭合**（无引擎降级转升级，门禁覆盖）
- G3 idle 时机事件名 —— **已闭合**（`turn/end` + origin 过滤 + 微任务排队）
- G4 fork→运行中 agent 官方路径 —— **已闭合**（api-session-controller.js:756-823 配方）
- G5 宿主 config schema 管线 —— **已闭合**（cordis.js:244-250/359-365/1691-1713）
- G6 会话命名 API —— **已闭合**（title.js:301-317；服务需运行时探测不可 inject）
- G7 真机 v0.4 复验 —— **部分闭合**：fiber `active` 已验（total 280）；**GUI 视觉确认未做**（宿主 401 鉴权、`windows_desktop` 无桌面能力，无法自动截图；需人工看一眼插件管理页本插件行）
- G8 标题长度语义 —— 复用宿主 `normalizeSessionTitle(title, maxTitleBytes)` 截断，插件不自行切字节（**未独立验证截断边界**，归类为宿主职责）
- G9 GUI 表单在真实宿主的渲染 —— **离线部分闭合**：`test-loader.mjs` 用宿主真实 `ClientModuleSystem` 走完整管线并渲染出表单节点（14/14）；**像素级 DOM 落盘未验**（需真实浏览器）
- G10 `configForms` 服务的 compose 时机 —— **未验**（若插件行尚未 compose，`formFor` 返回 undefined → 组件显示"未暴露可编辑配置"，属宿主时序，非插件缺陷，但需真机确认默认路径能拿到 form）
- G11 归档真机效果 —— **未验**（代码与门禁 4 组已备：需真实触发一次 L2 升级后确认归档区出现旧会话、面板「归档引擎: 就绪」、子会话正常续作；`stopActivity` 取消运行中 turn 的实际体感需真机观察）
- G12 连环升级根因 —— **机制层已闭合（v0.5）**：summary 默认 + completed-only 评估 + full 体积门禁，门禁 6 组 + 变异 2 路覆盖；**真机复验未做**（需启用 v0.5 后观察一个高压会话：升级一次、子会话干净、无连环 fork；此前 quick-notes 工作区已堆积的 9 个 seeded 兄弟会话属事故遗留，处置归用户）
