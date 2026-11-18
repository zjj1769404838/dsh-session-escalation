# dsh-session-escalation

DSH 两级阈值会话治理插件（本地开发，`link:` 挂载于 desktop profile）。

## 行为

每个会话的每个**正常完成**（`turn/end` 且 `reason.kind==='completed'`，缺失视为 completed）的 turn 结束后，读取 token-meter `contextPressure` 投影度量占用比；error / aborted 结束的 turn 一律不评估（v0.5，防 provider 抖动引发连环升级）：

| 级别 | 默认阈值 | 动作 |
| --- | --- | --- |
| L1 | ≥ 70% | `ctx.compaction.compactNow(agent)` 自动压缩（额度 2 次） |
| L2 | ≥ 90%，或压缩额度耗尽仍 ≥ L1 | 升级（v0.5 默认 `inheritMode='summary'`）：**新建一个干净的同级会话**（不继承任何历史事件），并向其投递一条**交接消息**（`[交接]` 头：父标题 / 父 id / 交接时间 / 第 n 次升级 + `continuePrompt` 正文），驱动新会话接着干；分支会话获得完整额度，链深 ≤ 16；`renameOnEscalate=true`（默认）时按 `nameTemplate` 给分支命名；`archiveParentOnEscalate=true`（默认）时升级成功后把**旧会话归档**（宿主原生 `workspaceRegistry.archiveSession`，可从归档区恢复；会取消置顶）。`inheritMode='full'` 保留 v0.4 的整段继承（seed 配方对齐宿主 controller），但带体积门禁：继承前缀估算 ≥ L2 阈值即拒绝并消耗额度 |

无 compaction 引擎（如 billion-context gate 禁用了宿主压缩）时：L1 直接转入升级路径。
度量不可得、agent 忙、subagent 会话：fail-closed，零动作。

## 配置（v0.4 起在 GUI 里改，不用改文件）

**首选入口：DSH 插件管理页 → 本插件那一行 → 配置页。** 表单由 `lib/client.js` 注册到 `plugins.row.config` 槽位，宿主把该行的配置表单（`{state, mutate}`）直接交给组件，所以不需要自建 HTTP bridge，也不经过设置页。

12 个字段全部声明为 schemastery `.volatile()`，**保存后立即生效，不需要重载插件**（gui 写入走 `_commitVolatile` → 就地更新引用；插件读配置用的是每次访问都解引用的 getter 视图）。

`Config` 是真 schemastery schema（经 `createRequire(<profile>/package.json)` 解析宿主依赖——插件目录是 junction，静态 import 会被 realpath 解析回 `D:\my-projects\...` 而找不到包）。在它之上挂了一层语义校验：类型/区间由 schemastery 负责，**跨字段约束与命名模板占位符由 `withSemanticValidation` 负责**，两类错误都会在保存时被宿主拒绝（不然 GUI 能存下"一保存就把插件停用"的配置）。

解析不到 schemastery 时降级为零依赖 `~standard` 兜底 schema（**刻意不带 `toJSON`**，所以宿主设置面会忽略本插件而不是展示一个坏表单），`/escalation` 面板的「配置面」一行会写明降级原因。

配置优先级：**GUI / `cordis.patch.yml` 的宿主 config 逐键 > `DSH_ESCALATION_CONFIG` > `DEFAULTS`**。`/escalation` 面板第 2 行显示实际来源（`host+env` / `host` / `env` / `default`）。

无 GUI 的场合（脚本化 profile、CI）仍可在 `cordis.patch.yml` 的 `config:` 下配置（**整体替换，非深合并**，要保留的键须写全）：

```yaml
- id: session-escalation
  config:
    thresholdRatio1: 0.6
    thresholdRatio2: 0.85
    nameTemplate: '[{date}] {parent} 第{n}棒'
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `thresholdRatio1` | `0.70` | L1 压缩阈值，`0 < r < 1` |
| `thresholdRatio2` | `0.90` | L2 升级阈值，`ratio1 ≤ r < 1` |
| `maxCompactPerSession` | `2` | 每会话压缩额度 |
| `maxEscalatePerSession` | `1` | 每会话升级额度 |
| `maxChainDepth` | `16` | 分支链最大深度 |
| `inheritMode` | `'summary'` | 升级继承模式（v0.5）：`summary`=干净新会话+交接消息；`full`=整段继承（带体积门禁） |
| `autoContinue` | `true` | 升级后自动投递续作消息 |
| `continuePrompt` | 见 `DEFAULTS` | 续作消息正文 |
| `renameOnEscalate` | `true` | 升级后给分支改名 |
| `archiveParentOnEscalate` | `true` | 升级成功后归档旧会话（宿主原生能力，可恢复；会取消置顶） |
| `nameTemplate` | `'{parent}-续{n}'` | 命名模板 |

非法配置 fail-closed（插件停用并 warn），未知键 warn 后忽略。

**GUI 里改的配置热更新，不需要重载插件。** 唯一例外是「配置面」降级（解析不到 schemastery）这种模块级状态——它由 import 期决定，需要重启宿主才能改变。

### 命名模板

支持占位符（不认识的占位符在校验期直接报错，不会静默留成字面量）：

| 占位符 | 渲染为 |
| --- | --- |
| `{parent}` | 父会话标题（无标题时退回父会话 id） |
| `{parentId}` | 父会话 id |
| `{n}` | 本次是该会话第几次升级（从 1 起） |
| `{date}` | 本地日期 `YYYYMMDD` |
| `{time}` | 本地时间 `HHmmss` |
| `{uuid8}` | 分支会话 id 前 8 位十六进制 |

命名经 `ctx.sessionTitle.rename(childSession, rendered)` 落地，复用宿主 `normalizeSessionTitle` 的字节上限（宿主 `maxTitleBytes`），超长由宿主截断；显式 rename 会把标题 pin 住，后续 user 消息不再自动改写标题。

可选服务，**不写进 `inject`**：宿主未挂 session-title 时（`@deepseek-ai/dsh-experimental-session-titles-bundle` 缺席）插件只记 info 日志并跳过命名，绝不因命名而阻断分支建立。

## 诊断

会话内输入 `/escalation` 查看：版本、配置来源（及非法告警）、阈值与额度、命名模板与 `sessionTitle` 就绪度、压缩引擎就绪、投影就绪、当前会话账本（compact/escalate 计数、分支 id、上次判定）。

## 已知边界（诚实台账）

- 账本进程内存储：宿主重启归零。
- 续作消息配方逐字节对齐 dsh-automation 生产先例（followup + createUserMessage + 自定义 source.kind）；宿主在载时走真实 `@deepseek-ai/dsh-llm` import，离线门禁走同形状镜像兜底。
- 分支 workspace attach 为尽力复刻（controller 私有逻辑），失败只记日志。
- 命名失败（服务缺席 / 子会话未进 store / rename 抛错）一律只记日志，不影响分支与续作。
- GUI 表单依赖宿主 `plugins.row.config` 槽位与 `configForms` 服务；两者都来自 `@deepseek-ai/dsh-client-ui-plugin-manager`，宿主版本不带该槽位时表单不出现（命令面板 `/escalation` 仍可用）。
- **像素级渲染未验**：`test-loader.mjs` 用**宿主真实的 `__ModuleLoader__` / `ClientModuleSystem`** 走完整管线（注册 → transport → `import()` → `apply` → slot 注册 → 组件调用），证明客户端半边在宿主模块系统下可加载、可注册、可渲染出表单节点；但真实浏览器里的 React DOM 落盘与样式需人工看一眼。

## 门禁

```
node test-policy.mjs   # 19/19 · 纯策略全分支 + 边界 + 命名模板 + inheritMode 枚举 + fail-closed
node test-flow.mjs     # 38/38 · 假 ctx + 真实事件形状（full seed 配方、summary 无 seed+交接头、体积门禁、completed-only 守卫、config 优先级、语义校验、volatile 热更新、命名链路、归档 4 组）
node test-client.mjs   # 13/13 · 客户端半边：模块 id / inject / slot key 规则 / 三种 form 状态 / 字段控件类型 / 字段表与 DEFAULTS 对齐
node test-loader.mjs   # 14/14 · 用宿主真实 client-modules bundle 承载本插件 client.js（真管线，不是桩；夹具由 tools/extract-host-client.mjs 生成）
node tools/verify-sync.mjs  # 四源一致性校验（版本/12 字段/继承模式/门禁数字/夹具路径）+ 四套门禁全跑 + 变异套件复跑，exit 0 才算交付
```

`test-loader.mjs` 读取宿主真实的 `@deepseek-ai/dsh-client-modules` 客户端 bundle（夹具落 `fixtures/client-modules-client.js`，由 `tools/extract-host-client.mjs` 从宿主 app.asar 提取；`DSH_APP_ASAR` / `DSH_HOST_CLIENT_MODULES` 可覆盖），在 `node:vm` 里建门面（同时暴露旧版 `window.__ModuleLoader__` 与宿主新版裸全局 `_ModuleLoader__`），然后用**宿主的 `createClientModuleSystem`** 加载本插件，断言链路每一环。宿主升级若改了 wire 格式，这套门禁会先红。

四套门禁均做过变异自检（改坏 → exit 1 → 字节级恢复 → exit 0）；v0.4.1 归档另有 3 路定向变异，v0.5 新增 2 路（summary 漏传 seed 守卫移除、completed-only 守卫移除），共 5 路（`tools/mutate-archive.mjs`），全真红后还原。
契约与源码行号证据见 `CONTRACT.md`。
