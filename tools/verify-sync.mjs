// v0.5.0 四源一致性校验（版本/归档字段/继承模式/门禁数字/夹具路径）+ 四套门禁重跑 + 变异套件复跑
// 用法: node tools/verify-sync.mjs   （exit 0 = 全部一致且门禁全绿）
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // tools/ 的上级 = 插件根
const read = (p) => readFileSync(join(root, p), 'utf8');
let bad = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) bad++; };

const pkg = JSON.parse(read('package.json'));
ok('pkg.version=0.5.0', pkg.version === '0.5.0');

const idx = read('lib/index.js');
ok("index VERSION '0.5.0'", idx.includes("const VERSION = '0.5.0'"));
const archIdx = [...idx.matchAll(/archiveParentOnEscalate/g)].length;
ok('index archive refs >=3 (liveConfig getter / doEscalate guard / panel line)', archIdx >= 3);
ok('index archiveParent call with stopActivity', idx.includes('archiveSession(session.id, { stopActivity: true })'));
ok('index inheritMode liveConfig getter', idx.includes("get inheritMode() { return deref(layers.merged.inheritMode) }"));
ok('index summary gate on seed omission', idx.includes('...(summary ? {} : { seed, inheritedEventCount: boundary + 1 })'));
ok('index volume gate for full mode', idx.includes('体积门禁拒绝'));
ok('index completed-only turn guard', idx.includes("if (reasonKind !== undefined && reasonKind !== 'completed') return"));

const pol = read('lib/policy.js');
ok('policy DEFAULTS archiveParentOnEscalate: true', pol.includes('archiveParentOnEscalate: true'));
ok("policy bool-key list includes it", pol.includes("'archiveParentOnEscalate'"));
ok("policy DEFAULTS inheritMode: 'summary'", pol.includes("inheritMode: 'summary'"));
ok('policy INHERIT_MODES enum', pol.includes("INHERIT_MODES = Object.freeze(['summary', 'full'])"));

const cs = read('lib/config-schema.js');
const cl = read('lib/client.js');
const fieldOf = (src, key) => {
  const m = src.match(new RegExp("\\{\\s*key:\\s*'" + key + "'[\\s\\S]*?\\}"));
  return m ? m[0].replace(/\s+/g, ' ') : null;
};
ok('config-schema has archive field object', fieldOf(cs, 'archiveParentOnEscalate') !== null);
ok('client has archive field object', fieldOf(cl, 'archiveParentOnEscalate') !== null);
ok('archive field label/hint identical across schema & client', fieldOf(cs, 'archiveParentOnEscalate') !== null && fieldOf(cs, 'archiveParentOnEscalate') === fieldOf(cl, 'archiveParentOnEscalate'));
ok('config-schema has inheritMode field object', fieldOf(cs, 'inheritMode') !== null);
ok('client has inheritMode field object', fieldOf(cl, 'inheritMode') !== null);
ok('inheritMode field label/hint identical across schema & client', fieldOf(cs, 'inheritMode') !== null && fieldOf(cs, 'inheritMode') === fieldOf(cl, 'inheritMode'));
const csCount = [...cs.matchAll(/key:\s*'([A-Za-z0-9_]+)'/g)].length;
const clCount = [...cl.matchAll(/key:\s*'([A-Za-z0-9_]+)'/g)].length;
ok('config-schema declares 12 fields (got ' + csCount + ')', csCount === 12);
ok('client declares 12 fields (got ' + clCount + ')', clCount === 12);

const rd = read('README.md');
for (const s of ['38/38', '19/19', '12 个字段', '| `archiveParentOnEscalate` | `true` |', '| `inheritMode` |', 'fixtures/client-modules-client.js', 'tools/extract-host-client.mjs', 'tools/mutate-archive.mjs', '_ModuleLoader__']) {
  ok('README has: ' + s, rd.includes(s));
}
for (const s of ['29/29', '33/33', '18/18', '$TEMP/client-modules-client.js']) {
  ok('README no stale: ' + s, !rd.includes(s));
}

const ct = read('CONTRACT.md');
for (const s of ['38/38 passed', '19/19 passed', '### A10. 旧会话归档', '### A12. v0.5 继承模式', 'G11 归档真机效果', 'G12 连环升级根因', 'inheritMode', 'fixtures/client-modules-client.js', 'tools/mutate-archive.mjs', 'tools/extract-host-client.mjs']) {
  ok('CONTRACT has: ' + s, ct.includes(s));
}
for (const s of ['29/29 passed', '$TEMP/client-modules-client.js']) {
  ok('CONTRACT no stale: ' + s, !ct.includes(s));
}

// 四套门禁重跑（真实退出码 + 通过数口径）
const gates = [
  ['test-policy.mjs', '19/19'],
  ['test-flow.mjs', '38/38'],
  ['test-client.mjs', '13/13'],
  ['test-loader.mjs', '14/14'],
];
for (const [f, expect] of gates) {
  try {
    const out = execFileSync('node', [join(root, f)], { encoding: 'utf8', timeout: 180000 });
    ok(f + ' exit 0 & reports ' + expect, out.includes(expect));
  } catch (e) {
    ok(f + ' exit 0 & reports ' + expect, false);
    console.log('  tail: ' + String(e.stderr || e.message).slice(-400));
  }
}

// 变异套件复跑：脚本内部自证真红并还原，exit 0 = 自检通过
try {
  execFileSync('node', [join(root, 'tools', 'mutate-archive.mjs')], { encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
  ok('mutate-archive.mjs exit 0 (self-verified true-red + byte-identical restore)', true);
} catch (e) {
  ok('mutate-archive.mjs exit 0 (self-verified true-red + byte-identical restore)', false);
  console.log('  tail: ' + String(e.stderr || e.message).slice(-400));
}

console.log('SYNC_BAD=' + bad);
process.exitCode = bad ? 1 : 0;
