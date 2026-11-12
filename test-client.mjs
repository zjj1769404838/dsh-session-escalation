// 客户端半边门禁：用假 loader 加载 lib/client.js，验证注册形状与组件契约。
// React 桩按真实语义展开函数组件（React 会把 type 是函数的元素递归调用），
// 否则测到的是 {$$el: SettingsCard} 而不是渲染树——首版门禁正是在这里卡住的。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const clientPath = path.join(here, 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

let failures = 0
const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

// ---------- 假 loader + 假 React（含函数组件展开） ----------
function loadClient() {
  const registrations = []
  const injected = []
  let loading = null

  const stubReact = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
  }
  const jsx = (type, props) => ({ $$el: type, props: props ?? {} })
  const jsxs = (type, props) => ({ $$el: type, props: props ?? {} })
  const moduleStubs = {
    react: stubReact,
    'react/jsx-runtime': { jsx, jsxs, Fragment: Symbol('Fragment') },
  }

  const sandboxWindow = {
    __ModuleLoader__: {
      load: (definition) => {
        loading = definition
      },
    },
  }
  const run = new Function('window', 'require', source)
  run(sandboxWindow, (id) => {
    if (!(id in moduleStubs)) throw new Error(`unexpected require(${id})`)
    return moduleStubs[id]
  })
  assert.ok(loading, '__ModuleLoader__.load 未被调用')

  const exports = loading.factory((id) => {
    if (!(id in moduleStubs)) throw new Error(`unexpected require(${id})`)
    return moduleStubs[id]
  })

  const ctx = {
    slots: {
      inject: (name, thunk) => {
        injected.push(name)
        const iterator = thunk()
        if (iterator && typeof iterator.next === 'function') {
          let step = iterator.next()
          while (!step.done) {
            registrations.push(step.value)
            step = iterator.next()
          }
        }
      },
      register: (spec, component) => ({ spec, component }),
    },
  }
  exports.apply(ctx)
  return { definition: loading, exports, registrations, injected }
}

// React 语义：type 是函数则调用它，props 递归展开。
function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.$$el === 'function') return render(node.$$el({ ...node.props }))
  const props = {}
  for (const [key, value] of Object.entries(node.props ?? {})) {
    props[key] = key === 'children' ? render(value) : value
  }
  return { $$el: node.$$el, props }
}

function flatten(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  if (node.props?.children !== undefined) flatten(node.props.children, out)
  return out
}

const loaded = loadClient()
const component = loaded.registrations[0]?.component

check('client: 模块 id 与 package.json 名称一致', () => {
  const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'))
  assert.equal(loaded.definition.id, pkg.name)
})

check('client: inject 声明 slots', () => {
  assert.deepEqual(loaded.exports.inject, ['slots'])
})

check('client: 只注入 plugins.row.config 一个槽位', () => {
  assert.deepEqual(loaded.injected, ['plugins.row.config'])
})

check('client: 注册项 key 为 <包名>#<patch 行 id>', () => {
  assert.equal(loaded.registrations.length, 1)
  const spec = loaded.registrations[0].spec
  assert.equal(spec.name, 'plugins.row.config')
  assert.equal(spec.key, '@zjjlivingfree/dsh-session-escalation#session-escalation')
})

check('client: package.json 声明 client 半边（inject + platform + exports）', () => {
  const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-plugin-manager', '@deepseek-ai/dsh-client-ui-renderer'])
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.version, '0.4.1')
})

check('client: summary 视图渲染纯文本摘要', () => {
  const out = render(component({ view: 'summary' }))
  assert.equal(out.$$el, 'span')
  assert.match(String(out.props.children), /阈值/)
})

check('client: form 缺失 → 提示未暴露配置（不崩溃）', () => {
  const out = render(component({ view: 'page', form: undefined }))
  assert.equal(out.$$el, 'p')
  assert.match(String(out.props.children), /未暴露可编辑配置/)
})

check('client: form loading 状态给出提示而非崩溃', () => {
  const out = render(component({ view: 'page', form: { state: { status: 'loading' } } }))
  assert.equal(out.$$el, 'p')
  assert.match(String(out.props.children), /正在读取配置/)
})

check('client: form 非 ready 状态回报 status', () => {
  const out = render(component({ view: 'page', form: { state: { status: 'error' } } }))
  assert.equal(out.$$el, 'p')
  assert.match(String(out.props.children), /status=error/)
})

const readyValue = {
  enabled: true,
  thresholdRatio1: 0.7,
  thresholdRatio2: 0.9,
  maxCompactPerSession: 2,
  maxEscalatePerSession: 1,
  maxChainDepth: 16,
  autoContinue: true,
  renameOnEscalate: true,
  nameTemplate: '{parent}-续{n}',
  continuePrompt: '继续',
}

check('client: form 就绪时渲染 11 行字段 + 保存/还原 + revision 提示', () => {
  const form = { state: { status: 'ready', writable: true, revision: 7, value: readyValue }, mutate: async () => true }
  const out = render(component({ view: 'page', form }))
  assert.equal(out.$$el, 'form')
  const nodes = flatten(out)
  const gridRows = nodes.filter((node) => node.props?.style?.gridTemplateColumns)
  assert.equal(gridRows.length, 11, `期望 11 行字段，实得 ${gridRows.length}`)
  const text = JSON.stringify(out)
  assert.match(text, /阈值与额度改动保存后立即生效/)
  assert.match(text, /revision=7/)
  const buttons = nodes.filter((node) => node.$$el === 'button')
  assert.ok(buttons.length >= 12, `期望每行「默认」按钮 + 保存/还原，实得 ${buttons.length}`)
})

check('client: 11 个字段各自渲染成对应控件类型', () => {
  const form = { state: { status: 'ready', writable: true, revision: 3, value: readyValue }, mutate: async () => true }
  const nodes = flatten(render(component({ view: 'page', form })))
  const inputs = nodes.filter((node) => node.$$el === 'input')
  const byType = (type) => inputs.filter((node) => node.props.type === type)
  assert.equal(byType('checkbox').length, 4, '布尔字段应有 4 个 checkbox')
  assert.equal(byType('number').length, 5, 'ratio+count 应有 5 个 number')
  assert.equal(byType('text').length, 2, '文本字段应有 2 个 text')
})

check('client: writable=false 时禁用保存', () => {
  const form = { state: { status: 'ready', writable: false, revision: 5, value: readyValue }, mutate: async () => true }
  const nodes = flatten(render(component({ view: 'page', form })))
  const submit = nodes.find((node) => node.$$el === 'button' && node.props.type === 'submit')
  assert.ok(submit, '缺少保存按钮')
  assert.equal(submit.props.disabled, true)
})

check('client: 客户端字段表与 policy DEFAULTS 键集合完全一致', async () => {
  const policy = await import(pathToFileURL(path.join(here, 'lib', 'policy.js')).href)
  const keys = Object.keys(policy.DEFAULTS)
  for (const key of keys) {
    assert.ok(source.includes(`key: '${key}'`), `client.js 缺少字段 ${key}`)
  }
  const declared = [...source.matchAll(/key: '([A-Za-z0-9_]+)'/g)].map((m) => m[1])
  assert.equal(new Set(declared).size, keys.length, `客户端字段数 ${new Set(declared).size} ≠ DEFAULTS ${keys.length}`)
  for (const declaredKey of new Set(declared)) {
    assert.ok(keys.includes(declaredKey), `client.js 声明了 DEFAULTS 里没有的字段 ${declaredKey}`)
  }
})

for (const { name, fn } of checks) {
  try {
    await fn()
    console.log('PASS ' + name)
  } catch (error) {
    failures += 1
    console.log('FAIL ' + name)
    console.log('  ' + String(error?.message ?? error).split('\n').join('\n  '))
  }
}

console.log(failures === 0 ? `client: ${checks.length}/${checks.length} passed` : `client: ${checks.length - failures}/${checks.length} passed`)
process.exit(failures === 0 ? 0 : 1)
