# v0.5.0 设计：升级＝干净新会话＋交接摘要（不再整段克隆历史）

> 依据：2026-11-18 无限升级事故诊断（session-cc3272b4：7 次继承升级、子会话出生即 285% 占用）。
> 用户选定 B 方案：占用到阈值 → 自动开一个**干净**新会话，只带一份小交接摘要。

## 变更点

1. **新配置 `inheritMode`（默认 `'summary'`）**
   - `'summary'`：升级 = `agents.create` **不传 seed / inheritedEventCount / isSeeded**，
     子会话是真正的全新会话；随后经 autoContinue 投递**交接消息**（固定头：父标题+父id+日期+第n次升级，
     正文 = `continuePrompt`）。宿主对"无 seed 创建"的语义＝普通新会话（与 GUI 新建同路径），风险最低。
   - `'full'`：保留 v0.4 行为（前缀+end-seed 哨兵），供显式回退。
2. **full 模式体积门禁（fail-closed）**：建分支前估算 seed 字节（Σ JSON.stringify(event)+1，token≈bytes/4）；
   若 estTokens ≥ thresholdRatio2 × contextWindow → 拒绝升级、**消耗升级额度**（防逐轮重试刷屏）、warn 留痕。
3. **仅 completed turn 触发评估**：`turn/end` 事件带 `data.reason.kind` 且 ≠ `'completed'`（error/aborted）
   → 直接跳过（掐断 provider 抖动/用户中止引发的连环升级）。`reason` 缺失视为 completed（兼容既有事件形状与门禁）。
4. **compaction 引擎缺席路径不改**：仍转升级——但升级现在是干净新会话，正是期望行为（bili 在代理层压缩，
   本插件不再需要"克隆历史"来续命）。

## 配置面

- `resolveConfig`：`inheritMode ∈ {'summary','full'}`，非法抛（fail-closed）。
- `liveConfig` getter + `FIELD_SPECS` + client `FIELDS` 同步（11→12 字段，kind='text'，hint 注明两值语义）。
- 面板 `/escalation` 增加 inheritMode 显示。

## 门禁增量（预计）

- policy 18→19：+`config: inheritMode enum validation`。
- flow 33→38：既有 L2 seed 测试显式 `inheritMode:'full'`；+summary 无 seed 创建+交接消息含父标题/头；
  +error turn 不评估；+aborted turn 不评估；+full 模式体积门禁拒绝并消耗额度。
- client 13/13 数字更新：12 行字段、text 控件 2→3。
- verify-sync：版本 0.5.0、12 字段、门禁数字、README/CONTRACT 关键串。
- 四套门禁 + 变异套件全绿后才提交。

## 版本与发布

0.4.1 → 0.5.0（行为变更）。发布走既定 SOP（钉官方源 + --access=public + 直查）；live 启用由用户决定。
