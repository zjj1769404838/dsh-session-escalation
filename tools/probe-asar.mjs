import { readFileSync, readdirSync, statSync } from 'node:fs'
const buf = readFileSync('D:/apps/DeepSeek Harness/DSH NEXT/resources/app.asar')
const jsonLen = buf.readUInt32LE(12)
const raw = buf.slice(16, 16 + jsonLen).toString('utf8')
const header = JSON.parse(raw)
const nm = header.files.node_modules
console.log('node_modules entries:', Object.keys(nm.files || {}))
const scopes = nm.files?.['@deepseek-ai']
console.log('@deepseek-ai entries:', scopes ? Object.keys(scopes.files || {}) : '(none)')
console.log('lib entries:', Object.keys(header.files.lib?.files || {}))
console.log('build entries:', Object.keys(header.files.build?.files || {}).slice(0, 30))
console.log('raw contains client-modules?', raw.includes('client-modules'))
console.log('raw contains dsh-client?', raw.includes('dsh-client'))
// 磁盘侧资源
const res = 'D:/apps/DeepSeek Harness/DSH NEXT/resources'
for (const d of ['app.asar.unpacked', 'runtime']) {
  try { console.log(d + ':', readdirSync(res + '/' + d).slice(0, 30)) } catch (e) { console.log(d + ': ERR ' + e.code) }
}
try { console.log('unpacked/node_modules:', readdirSync(res + '/app.asar.unpacked/node_modules/@deepseek-ai').slice(0, 40)) } catch (e) { console.log('unpacked deep: ERR ' + e.code) }
