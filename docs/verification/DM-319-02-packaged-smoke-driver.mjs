// Starts the packaged app with a scratch user-data dir and --inspect=0, then over the main-process
// inspector evaluates the real PtyHost source (bundled from src/main/terminals/ptyHost.ts) with the
// app's own require and __filename, and spawns /bin/echo ok in a PTY.
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'

const app = process.argv[2]
const extra = process.argv.slice(3)
const userData = mkdtempSync('/tmp/dm319/userdata-')
const child = spawn(app, [`--user-data-dir=${userData}`, '--inspect=0', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] })
console.log(`started pid=${child.pid} userData=${userData}`)

const url = await new Promise((resolve, reject) => {
  let buffered = ''
  const timer = setTimeout(() => reject(new Error(`no inspector url; stderr: ${buffered}`)), 30000)
  child.stderr.on('data', (chunk) => {
    buffered += chunk
    const match = buffered.match(/ws:\/\/\S+/)
    if (match) { clearTimeout(timer); resolve(match[0]) }
  })
})
console.log(`inspector ${url}`)

const ws = new WebSocket(url)
await new Promise((resolve) => ws.addEventListener('open', resolve))
let id = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
})
const send = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })) })

const bundle = readFileSync('/tmp/dm319/ptyHost.cjs', 'utf8')
const expression = `(async () => {
  const main = process.mainModule
  const module = { exports: {} }
  new Function('require', '__filename', 'module', 'exports', ${JSON.stringify(bundle)})(main.require.bind(main), main.filename, module, module.exports)
  const { createNodePtyHost } = module.exports
  const report = { mainFilename: main.filename, resourcesPath: process.resourcesPath, arch: process.arch, electron: process.versions.electron }
  try {
    const host = await createNodePtyHost()
    const child = host.spawn({ file: '/bin/echo', args: ['ok'], cwd: '/', env: { PATH: '/usr/bin:/bin' }, cols: 80, rows: 24 })
    let output = ''
    child.onData((data) => { output += data })
    const exit = await new Promise((resolve) => child.onExit(resolve))
    await new Promise((resolve) => setTimeout(resolve, 100))
    Object.assign(report, { pid: child.pid, output, exit })
  } catch (error) {
    report.error = String(error && error.message)
  }
  const loaded = Object.keys(main.constructor._cache).filter((path) => path.includes('node-pty'))
  report.ptyNodeLoaded = process.report.getReport().sharedObjects.filter((path) => path.endsWith('pty.node'))
  report.nodePtyModules = loaded.filter((path) => path.endsWith('index.js') || path.endsWith('unixTerminal.js'))
  return JSON.stringify(report, null, 2)
})()`
const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
console.log(result.result?.result?.value ?? JSON.stringify(result))
ws.close()
child.kill('SIGTERM')
await new Promise((resolve) => child.on('exit', resolve))
console.log(`app exited`)
