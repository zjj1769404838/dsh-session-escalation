import { createRequire } from 'node:module';
const require0 = createRequire(import.meta.url);
// 用宿主【真实的】__ModuleLoader__ 实现加载本插件 client.js —— 行为级验证客户端半边可运行
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HOST_CLIENT = process.env.DSH_HOST_CLIENT_MODULES || require0('node:url').fileURLToPath(new URL('./fixtures/client-modules-client.js', import.meta.url));
const MY_CLIENT = new URL('./lib/client.js', import.meta.url);
const MY_CLIENT_PATH = require0('node:url').fileURLToPath(MY_CLIENT);
const results = [];
const check = (name, fn) => { try { fn(); results.push(['PASS', name]) } catch (e) { results.push(['FAIL', name + ' :: ' + e.message]) } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg) };

// ---- 1. 伪浏览器 window：提供 __ModuleLoader__ 注册门面 ----
const facade = { mode: 'queue', pendingQueue: [], load(r) { this.pendingQueue.push(r) } };
const sandbox = { console, setTimeout, clearTimeout, queueMicrotask, TextDecoder, TextEncoder, URL, Response: globalThis.Response, ReadableStream: globalThis.ReadableStream };
sandbox.window = { __ModuleLoader__: facade };
// 宿主 bundle 变体兼容：旧版首行 window.__ModuleLoader__.load({...})，新版改用裸全局 _ModuleLoader__
sandbox._ModuleLoader__ = facade;
sandbox.__ModuleLoader__ = facade;
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);

// ---- 2. 执行宿主真实 client bundle，拿到其命名导出 ----
vm.runInContext(readFileSync(HOST_CLIENT, 'utf8'), context, { filename: 'dsh-client-modules-client.js' });
const selfReg = facade.pendingQueue.find(r => String(r.id).includes('dsh-client-modules'));
assert(selfReg, '宿主管线未注册自身');

facade.pendingQueue = facade.pendingQueue.filter(r => !String(r.id).includes('dsh-client-modules'));
const fakeReact = {
  createElement: (type, props, ...children) => ({ $$el: type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useMemo: (fn) => fn(), useEffect: () => {}, useLayoutEffect: () => {},
  useSyncExternalStore: (sub, get) => get(), useCallback: (f) => f, useRef: (v) => ({ current: v }),
};
const fakeJsx = {
  jsx: (type, props) => ({ $$el: type, props: props || {} }),
  jsxs: (type, props) => ({ $$el: type, props: props || {} }),
  Fragment: Symbol('Fragment'),
};
const hostExports = selfReg.factory((spec) => {
  if (spec === 'react') return fakeReact;
  if (spec === 'react/jsx-runtime') return fakeJsx;
  throw new Error('宿主 bundle 意外 require: ' + spec);
});

check('宿主真实 bundle 导出 createClientModuleSystem', () => assert(typeof hostExports.createClientModuleSystem === 'function', 'missing createClientModuleSystem'));

// ---- 3. 用宿主真实 ClientModuleSystem 承载我的插件 ----
const boot = {
  rev: 'test-rev-1',
  release: { version: '0.2.2-rc.1' },
  entries: [{ id: '@zjjlivingfree/dsh-session-escalation', url: '/plugins/@zjjlivingfree/dsh-session-escalation?rev=r1', rev: 'r1', inject: ['@deepseek-ai/dsh-client-ui-slots'], external: [] }],
  batches: [{ phase: 'application', url: '/plugins/batch-1?phase=application', rev: 'b1', entries: ['@zjjlivingfree/dsh-session-escalation'] }],
};
const loadedUrls = [];
const system = hostExports.createClientModuleSystem(
  facade,
  { id: '@deepseek-ai/dsh-client-modules', exports: hostExports },
  {
    boot,
    staticModules: { react: fakeReact, 'react/jsx-runtime': fakeJsx },
    loadBundle: async (url) => {
      loadedUrls.push(url);
      // 复刻浏览器 script 语义：bundle 执行只注册 factory
      const src = url.includes('session-escalation') ? readFileSync(MY_CLIENT_PATH, 'utf8') : '';
      if (src) vm.runInContext(src, context, { filename: 'my-client.js' });
    },
  },
);
check('宿主 ClientModuleSystem 构建成功', () => assert(system && typeof system.import === 'function', 'no import()'));

// ---- 4. 走真实 import 通路拿到我的 exports ----
let mine;
try { mine = await system.import('@zjjlivingfree/dsh-session-escalation'); }
catch (e) { results.push(['FAIL', '宿主管线 import 我的插件 :: ' + e.message]); }
if (mine) {
  check('经宿主管线 import 成功', () => assert(mine && typeof mine === 'object', 'no exports'));
  check('transport 被真实触发（批次 URL 或单包 URL）', () => assert(loadedUrls.length >= 1, 'loadBundle 未被调用: ' + JSON.stringify(loadedUrls)));
  check('exports.apply 是函数', () => assert(typeof mine.apply === 'function', 'apply missing'));
  check('exports.inject = ["slots"]', () => assert(JSON.stringify(mine.inject) === '["slots"]', 'got ' + JSON.stringify(mine.inject)));

  // ---- 5. 真实 apply：注册到 plugins.row.config ----
  const registrations = [];
  let injectedSlotName;
  const fakeCtx = {
    slots: {
      inject(name, run) {
        injectedSlotName = name;
        const gen = run();
        for (const reg of gen) registrations.push(reg);
      },
      register(meta, component) { return { meta, component }; },
    },
  };
  check('apply 不抛错', () => mine.apply(fakeCtx));
  check('slot 注入目标 = plugins.row.config', () => assert(injectedSlotName === 'plugins.row.config', 'got ' + injectedSlotName));
  check('注册了恰好 1 个组件', () => assert(registrations.length === 1, 'got ' + registrations.length));
  const row = registrations[0];
  check('注册 key = <包名>#<行id>', () => assert(row.meta.key === '@zjjlivingfree/dsh-session-escalation#session-escalation', 'got ' + row.meta.key));
  check('注册 name = plugins.row.config', () => assert(row.meta.name === 'plugins.row.config', 'got ' + row.meta.name));

  // ---- 6. 渲染：summary 视图 / 无 form / loading / ready ----
  const byLabel = (text) => JSON.stringify(row.component({ view: 'summary', t: (k) => text[k] ?? k }));
  check('summary 视图返回纯文本节点', () => {
    const node = row.component({ view: 'summary' });
    assert(node && node.$$el === 'span', 'summary 不是 span 节点');
    assert(typeof node.props.children === 'string' && node.props.children.length > 0, 'summary 无文本');
  });
  const pageNoForm = row.component({ view: 'page' });
  check('无 form 时给出降级提示（不抛错）', () => {
    const txt = collectText(pageNoForm);
    assert(/未暴露可编辑配置/.test(txt), 'got ' + txt.slice(0, 120));
  });
  const readyForm = {
    state: { status: 'ready', writable: true, revision: 7, value: {
      enabled: true, thresholdRatio1: 0.7, thresholdRatio2: 0.9,
      maxCompactPerSession: 2, maxEscalatePerSession: 1, maxChainDepth: 16,
      inheritMode: 'summary', autoContinue: true, renameOnEscalate: true,
      nameTemplate: '{parent}-续{n}', continuePrompt: '继续',
    } },
    mutate: async () => true,
  };
  const pageReady = row.component({ view: 'page', form: readyForm });
  check('ready 时渲染出表单（form 节点 + 多个控件）', () => {
    const txt = collectText(pageReady);
    assert(txt.length > 0, '空渲染');
    const stats = countNodes(pageReady);
    assert(stats.buttons >= 10, '按钮过少: ' + stats.buttons);
    assert(/revision=7/.test(txt), '未显示 revision: ' + txt.slice(0, 200));
  });
}

function collectText(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && node.$$el !== undefined) {
    if (typeof node.$$el === 'function') return collectText(node.$$el({ ...node.props }));
    return collectText(node.props?.children);
  }
  return '';
}
function countNodes(node, acc = { buttons: 0, inputs: 0 }) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach(n => countNodes(n, acc)); return acc; }
  if (node.$$el !== undefined) {
    const t = node.$$el;
    if (t === 'button') acc.buttons++;
    if (t === 'input' || t === 'select' || t === 'textarea') acc.inputs++;
    if (typeof t === 'function') return countNodes(t({ ...node.props }), acc);
    countNodes(node.props?.children, acc);
  }
  return acc;
}

const failed = results.filter(r => r[0] === 'FAIL');
for (const [st, name] of results) console.log(`${st === 'PASS' ? 'PASS' : 'FAIL'} ${name}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
