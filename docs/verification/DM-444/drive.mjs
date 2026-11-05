// usage: node drive.mjs <buildDir> <port> <js-to-evaluate-or-empty> <waitMs>
import { spawn, execSync } from 'node:child_process'
const [build, port, expr, waitMs] = process.argv.slice(2)
const S = 'C:\\Users\\davgo\\AppData\\Local\\Temp\\claude\\5b2748231b82b70c\\46f2df57-16a2-475c-9c1e-531c9afb4fd7\\scratchpad\\c444'
const env = { ...process.env, DISABLE_AUTO_UPDATE: '1', DARKMECHANICUS_HOME: `${S}\\dmhome`, PI_CODING_AGENT_DIR: `${S}\\agent` }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(`${S}\\${build}\\DarkMechanicus.exe`, [`--user-data-dir=${S}\\ud`, `--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
let page
for (let i = 0; i < 60 && !page; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {}
}
if (!page) { console.log('no page'); child.kill(); process.exit(2) }
if (expr) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const got = new Promise((r) => ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m) }))
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  console.log(JSON.stringify((await got).result))
  ws.close()
}
await new Promise((r) => setTimeout(r, Number(waitMs)))
execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
console.log('stopped', build)
