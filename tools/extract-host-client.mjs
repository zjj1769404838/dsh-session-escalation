#!/usr/bin/env node
// 从宿主 app.asar 提取 @deepseek-ai/dsh-client-modules 的 client bundle 到项目本地 fixtures/。
// 背景（2026-11-11）：旧夹具放 %TEMP%，临时目录清理后 test-loader ENOENT ——
// 按「回归环境自足」教训，门禁环境依赖必须项目内可重建。自校验：内容必须含 createClientModuleSystem。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ASAR = process.env.DSH_APP_ASAR || 'D:/apps/DeepSeek Harness/DSH NEXT/resources/app.asar'
const OUT = join(here, '..', 'fixtures', 'client-modules-client.js')
const MARKER = 'createClientModuleSystem'

const buf = readFileSync(ASAR)
const jsonLen = buf.readUInt32LE(12) // pickle u32[3] = header JSON 精确长度（u32[1] 含 8 字节对齐填充，不能直接用）
const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'))
// dataStart 候选：16+u32[1] 与 -8 校准，以 MARKER 自校验二选一（asar-lib 教训：对齐差 8 字节）
const bases = [16 + buf.readUInt32LE(4), 16 + buf.readUInt32LE(4) - 8]

const pkg = header.files.node_modules?.files?.['@deepseek-ai']?.files?.['dsh-client-modules']
if (!pkg) { console.error('header 里找不到 @deepseek-ai/dsh-client-modules'); process.exit(2) }

const leaves = []
;(function walk(node, path) {
  if (node.files) for (const [name, child] of Object.entries(node.files)) walk(child, [...path, name])
  else leaves.push({ path, size: node.size, offset: node.offset })
})(pkg, [])

let hit = null
for (const base of bases) {
  for (const leaf of leaves) {
    if (!/client/i.test(leaf.path.at(-1))) continue
    const start = base + Number(leaf.offset)
    const content = buf.slice(start, start + leaf.size).toString('utf8')
    if (content.includes(MARKER)) { hit = { base, leaf, content }; break }
  }
  if (hit) break
}
if (!hit) {
  console.error(`未找到含 ${MARKER} 的 client bundle；包内候选文件：\n  ${leaves.map((l) => l.path.join('/')).join('\n  ')}`)
  process.exit(2)
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, hit.content, 'utf8')
console.log(`EXTRACTED ${hit.leaf.path.join('/')} base=${hit.base} bytes=${Buffer.byteLength(hit.content)} -> ${OUT}`)
