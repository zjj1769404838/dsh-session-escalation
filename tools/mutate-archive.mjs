#!/usr/bin/env node
// v0.4.1 归档门禁定向变异自检：每路变异必须让对应门禁真红（退出码非 0 且出现预期 FAIL 行），
// 跑完字节级还原，并复跑受影响门禁确认干净。禁假红：语法错误导致的退出 1 不算真红，必须匹配 FAIL 行。
// 2026-11-11 转正：旧 mut-real-loader.cjs 放 %TEMP% 被清理丢失 —— 自检脚本必须项目内可重建。
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const cases = [
  { name: 'stopActivity 参数漂移', file: 'lib/index.js', from: 'stopActivity: true', to: 'stopActivity: false', gate: 'test-flow.mjs', expectFail: '归档: 默认开启' },
  { name: '开关失效（守卫移除）', file: 'lib/index.js', from: 'if (cfg.archiveParentOnEscalate) await archiveParent(session)', to: 'await archiveParent(session)', gate: 'test-flow.mjs', expectFail: '归档: archiveParentOnEscalate=false' },
  { name: 'client 注册 key 漂移', file: 'lib/client.js', from: 'key: `@zjjlivingfree/dsh-session-escalation#${ROW_ID}`', to: 'key: ROW_ID', gate: 'test-loader.mjs', expectFail: '注册 key' },
]
let bad = 0
const gates = new Set()
for (const c of cases) {
  const p = join(root, c.file)
  const original = readFileSync(p)
  const text = original.toString('utf8')
  const n = text.split(c.from).length - 1
  if (n !== 1) { console.log(`MUT-ABORT ${c.name}: 锚点出现 ${n} 次（必须恰 1 次）`); bad++; continue }
  writeFileSync(p, text.replace(c.from, c.to), 'utf8')
  let red = false
  let failLine = ''
  try {
    execSync(`node ${c.gate}`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  } catch (e) {
    red = true
    const out = String(e.stdout || '') + String(e.stderr || '')
    failLine = out.split('\n').find((l) => l.startsWith('FAIL') && l.includes(c.expectFail)) || ''
  }
  writeFileSync(p, original)
  const restored = readFileSync(p).equals(original)
  const ok = red && failLine !== '' && restored
  if (!ok) bad++
  console.log(`${ok ? 'MUT-OK' : 'MUT-BAD'} ${c.name}: red=${red} failLine=${failLine ? JSON.stringify(failLine) : '(none)'} restored=${restored}`)
  gates.add(c.gate)
}
for (const gate of gates) {
  let clean = false
  try { execSync(`node ${gate}`, { cwd: root, stdio: 'ignore' }); clean = true } catch {}
  if (!clean) bad++
  console.log(`CLEAN ${gate} exit0=${clean}`)
}
console.log(bad === 0 ? 'MUTATIONS: all real-red + restored + clean-green' : `MUTATIONS: ${bad} problem(s)`)
process.exit(bad === 0 ? 0 : 1)
