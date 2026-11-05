// node cap.mjs <cwd> <outprefix> : runs plain `omp` in cwd (scratch agent dir), types /mcp list, saves screen text
import { createRequire } from 'node:module'
import fs from 'node:fs'
const req = createRequire('C:/Users/davgo/Documents/GitHub/dm-wt/omp-s3/package.json')
const pty = req('node-pty')
const { Terminal } = req('@xterm/headless')
const [cwd, out] = process.argv.slice(2)
const B = String.fromCharCode(92)
const env = { ...process.env, PI_CODING_AGENT_DIR: process.cwd() + B + 'agent' }
delete env.ELECTRON_RUN_AS_NODE
const term = new Terminal({ cols: 120, rows: 50, allowProposedApi: true })
const p = pty.spawn('C:/Users/davgo/AppData/Local/omp/omp.exe', [], { name: 'xterm-256color', cols: 120, rows: 50, cwd, env })
let raw = ''
p.onData((d) => { raw += d; term.write(d) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dump = () => { const b = term.buffer.active; const l = []; for (let i = 0; i < b.length; i++) l.push(b.getLine(i).translateToString(true)); return l.join(String.fromCharCode(10)).replace(/\s+$/, '') }
await sleep(9000)
fs.writeFileSync(out + '-startup.screen.txt', dump())
p.write('/mcp list'); await sleep(500); p.write(String.fromCharCode(13)); await sleep(4000)
fs.writeFileSync(out + '-mcp-list.screen.txt', dump())
p.kill(); await sleep(500)
console.log('done', raw.length)
process.exit(0)
