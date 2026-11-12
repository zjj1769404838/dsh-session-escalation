window.__ModuleLoader__.load({
  id: '@zjjlivingfree/dsh-session-escalation',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')

    const ROW_ID = 'session-escalation'

    // 字段表必须与 lib/policy.js 的 DEFAULTS 键集合一致（test-flow 有断言）。
    const FIELDS = [
      { key: 'enabled', kind: 'boolean', label: '总开关', hint: '关闭后不再自动压缩或升级' },
      { key: 'thresholdRatio1', kind: 'ratio', label: '一级阈值（压缩）', hint: '上下文占用比例达到该值时压缩，0-1' },
      { key: 'thresholdRatio2', kind: 'ratio', label: '二级阈值（升级）', hint: '达到该值时同层新开会话并继承任务，需大于一级阈值' },
      { key: 'maxCompactPerSession', kind: 'count', label: '每会话压缩上限', hint: '超过后一级阈值直接转升级' },
      { key: 'maxEscalatePerSession', kind: 'count', label: '每会话升级上限', hint: '0 表示禁用升级' },
      { key: 'maxChainDepth', kind: 'count', label: '链深上限', hint: '继承链最大长度，防止无限接棒' },
      { key: 'autoContinue', kind: 'boolean', label: '自动续作', hint: '升级后向新会话投递一条续作消息' },
      { key: 'renameOnEscalate', kind: 'boolean', label: '自动命名', hint: '按模板重命名新会话' },
      { key: 'archiveParentOnEscalate', kind: 'boolean', label: '自动归档旧会话', hint: '升级成功后把旧会话归档（可从归档区恢复），会取消其置顶' },
      { key: 'nameTemplate', kind: 'text', label: '命名模板', hint: '占位符 {parent} {parentId} {n} {time} {date} {uuid8}' },
      { key: 'continuePrompt', kind: 'text', label: '续作提示词', hint: '新会话收到的第一条消息内容' },
    ]

    const PLACEHOLDERS = ['parent', 'parentId', 'n', 'time', 'date', 'uuid8']

    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value))

    function readValue(state, key) {
      const value = state?.value
      if (value === null || typeof value !== 'object') return undefined
      return value[key]
    }

    function withDefaults(state) {
      const out = {}
      for (const field of FIELDS) {
        const value = readValue(state, field.key)
        out[field.key] = value === undefined ? '' : value
      }
      return out
    }

    function validate(draft) {
      const errors = []
      const r1 = num(draft.thresholdRatio1)
      const r2 = num(draft.thresholdRatio2)
      if (!(r1 > 0 && r1 < 1)) errors.push('一级阈值必须是 0 到 1 之间的小数')
      if (!(r2 >= r1 && r2 < 1)) errors.push('二级阈值必须不小于一级阈值且小于 1')
      for (const key of ['maxCompactPerSession', 'maxEscalatePerSession', 'maxChainDepth']) {
        const v = num(draft[key])
        if (!Number.isInteger(v) || v < 0) errors.push(`${key} 必须是非负整数`)
      }
      const template = String(draft.nameTemplate ?? '')
      if (template.trim() === '') errors.push('命名模板不能为空')
      const unknown = [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).filter((name) => !PLACEHOLDERS.includes(name))
      if (unknown.length > 0) errors.push(`命名模板含未知占位符: ${unknown.map((n) => `{${n}}`).join(', ')}`)
      if (String(draft.continuePrompt ?? '').trim() === '') errors.push('续作提示词不能为空')
      return errors
    }

    function coerce(draft, field) {
      const raw = draft[field.key]
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'ratio') return num(raw)
      if (field.kind === 'count') return num(raw)
      return String(raw ?? '')
    }

    function buildOps(draft, baseline) {
      const ops = []
      for (const field of FIELDS) {
        const next = coerce(draft, field)
        const prev = baseline?.[field.key]
        const same = prev === undefined ? false : prev === next
        if (same) continue
        ops.push({ op: 'set', path: [field.key], value: next })
      }
      return ops
    }

    function styles() {
      return {
        wrap: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '640px' },
        row: { display: 'grid', gridTemplateColumns: '200px 1fr', gap: '10px', alignItems: 'center' },
        label: { display: 'flex', flexDirection: 'column', gap: '2px' },
        name: { fontWeight: 600, fontSize: '13px' },
        hint: { fontSize: '11px', opacity: 0.65, lineHeight: 1.35 },
        input: { width: '100%', boxSizing: 'border-box', padding: '5px 7px', fontSize: '13px' },
        actions: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' },
        primary: { padding: '5px 14px', fontSize: '13px', fontWeight: 600 },
        message: { fontSize: '12px', margin: 0 },
        error: { fontSize: '12px', margin: 0, color: '#c0392b' },
        note: { fontSize: '11px', opacity: 0.7, margin: 0, lineHeight: 1.5 },
      }
    }

    function SettingsCard(props) {
      const form = props.form
      const css = styles()
      const status = form?.state?.status
      const writable = form?.state?.writable !== false
      const revision = form?.state?.revision
      const [draft, setDraft] = React.useState(() => withDefaults(form?.state))
      const [baseline, setBaseline] = React.useState(() => form?.state?.value ?? {})
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [errors, setErrors] = React.useState([])
      const dirty = React.useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline])
      const ready = status === 'ready' && writable

      React.useEffect(() => {
        // Host 侧 revision 变化（含别人改了配置）时刷新，除非本地有未保存编辑。
        if (!dirty) {
          setDraft(withDefaults(form?.state))
          setBaseline(form?.state?.value ?? {})
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [form?.state?.revision, status])

      if (!form) {
        return jsx('p', { style: css.note, children: '该插件未暴露可编辑配置（Config 缺少 toJSON 或字段未声明 volatile）。' })
      }
      if (status === 'loading') {
        return jsx('p', { style: css.note, children: '正在读取配置…' })
      }
      if (status !== 'ready') {
        return jsx('p', { style: css.note, children: `配置不可用（status=${String(status)}）。` })
      }

      const setField = (key, value) => {
        setDraft((prev) => ({ ...prev, [key]: value }))
        setMessage('')
      }

      const save = async (event) => {
        event?.preventDefault?.()
        if (!ready || busy || revision === undefined) return
        const found = validate(draft)
        setErrors(found)
        if (found.length > 0) return
        const ops = buildOps(draft, baseline)
        if (ops.length === 0) {
          setMessage('没有改动')
          return
        }
        setBusy(true)
        setMessage('')
        try {
          const accepted = await form.mutate(ops, revision)
          setMessage(accepted ? '已保存' : '被宿主拒绝（revision 冲突或校验未通过），请刷新后重试')
          if (accepted) setBaseline(coerceAll(draft))
        } catch (error) {
          setMessage(`保存失败: ${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }

      const resetAll = () => {
        setDraft(withDefaults(form.state))
        setBaseline(form.state.value ?? {})
        setErrors([])
        setMessage('')
      }

      const restoreDefault = async (field) => {
        if (!ready || busy || revision === undefined) return
        setBusy(true)
        setMessage('')
        try {
          const accepted = await form.mutate([{ op: 'unset', path: [field.key] }], revision)
          setMessage(accepted ? `${field.label} 已恢复默认（跟随插件内置值）` : '恢复默认被拒绝，请刷新后重试')
        } catch (error) {
          setMessage(`恢复默认失败: ${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }

      const rows = FIELDS.map((field) => {
        const value = draft[field.key]
        let control
        if (field.kind === 'boolean') {
          control = jsx('input', {
            type: 'checkbox',
            checked: value === true,
            disabled: !ready || busy,
            onChange: (event) => setField(field.key, event.target.checked),
          })
        } else if (field.kind === 'ratio') {
          control = jsx('input', {
            type: 'number',
            step: '0.01',
            min: '0.01',
            max: '0.99',
            style: css.input,
            value: String(value ?? ''),
            disabled: !ready || busy,
            onChange: (event) => setField(field.key, event.target.value),
          })
        } else if (field.kind === 'count') {
          control = jsx('input', {
            type: 'number',
            step: '1',
            min: '0',
            style: css.input,
            value: String(value ?? ''),
            disabled: !ready || busy,
            onChange: (event) => setField(field.key, event.target.value),
          })
        } else {
          control = jsx('input', {
            type: 'text',
            style: css.input,
            value: String(value ?? ''),
            disabled: !ready || busy,
            onChange: (event) => setField(field.key, event.target.value),
          })
        }
        return jsxs('div', {
          style: css.row,
          children: [
            jsxs('div', {
              style: css.label,
              children: [
                jsx('span', { style: css.name, children: field.label }),
                jsx('span', { style: css.hint, children: field.hint }),
              ],
            }),
            jsxs('div', {
              style: { display: 'flex', gap: '8px', alignItems: 'center' },
              children: [
                control,
                jsx('button', {
                  type: 'button',
                  title: '恢复为插件内置默认值',
                  disabled: !ready || busy,
                  onClick: () => void restoreDefault(field),
                  children: '默认',
                }),
              ],
            }),
          ],
        })
      })

      return jsxs('form', {
        style: css.wrap,
        onSubmit: (event) => void save(event),
        children: [
          jsx('p', {
            style: css.note,
            children: `阈值与额度改动保存后立即生效（volatile 热更新，无需重载插件）。revision=${String(revision)}`,
          }),
          ...rows,
          ...(errors.length > 0
            ? [jsx('p', { style: css.error, children: `请先修正：${errors.join('；')}` })]
            : []),
          jsxs('div', {
            style: css.actions,
            children: [
              jsx('button', {
                type: 'submit',
                style: css.primary,
                disabled: !ready || busy || !dirty,
                children: busy ? '保存中…' : '保存',
              }),
              jsx('button', { type: 'button', disabled: busy || !dirty, onClick: resetAll, children: '还原' }),
              message ? jsx('span', { style: css.message, children: message }) : null,
            ].filter(Boolean),
          }),
        ],
      })
    }

    function coerceAll(draft) {
      const out = {}
      for (const field of FIELDS) out[field.key] = coerce(draft, field)
      return out
    }

    function apply(ctx) {
      ctx.slots.inject('plugins.row.config', function* () {
        yield ctx.slots.register(
          { name: 'plugins.row.config', key: `@zjjlivingfree/dsh-session-escalation#${ROW_ID}` },
          (props) =>
            props && props.view === 'summary'
              ? jsx('span', { children: '阈值 / 额度 / 命名模板' })
              : jsx(SettingsCard, { ...props })
        )
      })
    }

    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
