// v0.4.1 四源一致性校验（版本/归档字段/门禁数字/夹具路径）+ 四套门禁重跑 + 变异套件复跑
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
ok('pkg.version=0.4.1', pkg.version === '0.4.1');

const idx = read('lib/index.js');
ok("index VERSION '0.4.1'", idx.includes("const VERSION = '0.4.1'"));
const archIdx = [...idx.matchAll(/archiveParentOnEscalate/g)].length;
ok('index archive refs >=3 (liveConfig getter / doEscalate guard / panel line)', archIdx >= 3);
ok('index archiveParent call with stopActivity', idx.includes('archiveSession(session.id, { stopActivity: true })'));

const pol = read('lib/policy.js');
ok('policy DEFAULTS archiveParentOnEscalate: true', pol.includes('archiveParentOnEscalate: true'));
ok("policy bool-key list includes it", pol.includes("'archiveParentOnEscalate'"));

const cs = read('lib/config-schema.js');
const cl = read('lib/client.js');
const fieldOf = (src) => {
  const m = src.match(/\{\s*key:\s*'archiveParentOnEscalate'[\s\S]*?\}/);
  return m ? m[0].replace(/\s+/g, ' ') : null;
};
ok('config-schema has field object', fieldOf(cs) !== null);
ok('client has field object', fieldOf(cl) !== null);
ok('field label/hint identical across schema & client', fieldOf(cs) !== null && fieldOf(cs) === fieldOf(cl));
const csCount = [...cs.matchAll(/key:\s*'[A-Za-z0-9_]+'/g)].length;
const clCount = [...cl.matchAll(/key:\s*'([A-Za-z0-9_]+)'/g)].length;
ok('config-schema declares 11 fields (got ' + csCount + ')', csCount === 11);
ok('client declares 11 fields (got ' + clCount + ')', clCount === 11);

const rd = read('README.md');
for (const s of ['33/33', '11 个字段', '| `archiveParentOnEscalate` | `true` |', 'fixtures/client-modules-client.js', 'tools/extract-host-client.mjs', 'tools/mutate-archive.mjs', '_ModuleLoader__']) {
  ok('README has: ' + s, rd.includes(s));
}
for (const s of ['29/29', '$TEMP/client-modules-client.js']) {
  ok('README no stale: ' + s, !rd.includes(s));
}

const ct = read('CONTRACT.md');
for (const s of ['33/33 passed', '### A10. 旧会话归档', 'G11 归档真机效果', 'archiveParentOnEscalate:true', 'fixtures/client-modules-client.js', 'tools/mutate-archive.mjs', 'tools/extract-host-client.mjs']) {
  ok('CONTRACT has: ' + s, ct.includes(s));
}
for (const s of ['29/29 passed', '$TEMP/client-modules-client.js']) {
  ok('CONTRACT no stale: ' + s, !ct.includes(s));
}

// 四套门禁重跑（真实退出码 + 通过数口径）
const gates = [
  ['test-policy.mjs', '18/18'],
  ['test-flow.mjs', '33/33'],
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
