/**
 * DM-505 c8 packaging proof: drives a PACKAGED Dark Mechanicus build (portable or installed exe) over CDP against a
 * scratch profile/home/repo, with no model prompt. Shows the extension loads from `resources/skitarii` outside app.asar,
 * the launch writes the DM client descriptor pinning the packaged runtime + packaged cli.js, the native PTY runs, and the
 * extension's dmClient spawns the packaged CLI child with the chat's bound grant (it paints "Skitarii mail: 1 unread").
 *
 * Usage (Git Bash, from the worktree root, Node 24 on PATH, DM_* and ELECTRON_RUN_AS_NODE unset):
 *   PACK_EXE=<packaged exe> PACK_LABEL=portable PACK_OUT=docs/verification/DM-505-pack-portable node docs/verification/DM-505-pack-smoke.mjs
 * Only the installed OMP's auth is copied (omp auth export | omp auth import) into the scratch home; the scratch root is
 * deleted at the end. Never writes a grant or credential to the evidence.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(join(repo, 'package.json'))
const exe = resolve(process.env.PACK_EXE)
// Development build: PACK_EXE is the project's Electron and PACK_APP the project root; no app.asar exists.
const dev = Boolean(process.env.PACK_APP)
const sameRuntime = (path, resources) => Boolean(path) && (dev ? resolve(path).toLowerCase() === exe.toLowerCase() : resolve(dirname(path), 'resources').toLowerCase() === (resources ?? '').toLowerCase())
const label = process.env.PACK_LABEL
const output = resolve(repo, process.env.PACK_OUT)
const omp = process.env.PACK_OMP ?? join(process.env.LOCALAPPDATA, 'omp', 'omp.exe')
mkdirSync(output, { recursive: true })
const root = mkdtempSync(join(tmpdir(), `dm505-pack-${label}-`))
const home = join(root, 'home'), userData = join(root, 'userData'), dmHome = join(root, 'dm-home'), folder = join(root, 'repo')
for (const path of [home, userData, dmHome, folder]) mkdirSync(path, { recursive: true })
const result = { label, exe, startedAt: new Date().toISOString(), checks: [] }
const record = (name, passed, detail) => { result.checks.push({ name, passed, detail }); console.log(passed ? 'PASS' : 'FAIL', name, JSON.stringify(detail)) }
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

const clean = (base) => { const e = { ...base }; for (const k of Object.keys(e)) if (/^(DM_SESSION_TOKEN|DM_DESKTOP_PIPE|DM_SKITARII_CLIENT_DESCRIPTOR|ELECTRON_.*|NODE_OPTIONS|CI)$/iu.test(k)) delete e[k]; return e }
const env = clean({ ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), PI_CODING_AGENT_DIR: join(home, '.omp', 'agent'), DARKMECHANICUS_HOME: dmHome, DISABLE_AUTO_UPDATE: '1' })
const authEnv = clean(process.env)

let child, socket, port, closed, nextId = 0
const pending = new Map()
const cdp = (method, params = {}) => { const id = ++nextId; const p = new Promise((res, rej) => pending.set(id, { res, rej })); socket.send(JSON.stringify({ id, method, params })); return p }
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
async function until(fn, what, timeout = 30_000) {
  const deadline = Date.now() + timeout
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 200)) }
}
const untilJs = (expr, what, timeout) => until(() => evaluate(expr), what, timeout)
async function screenshot(name) { const { data } = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(output, name), Buffer.from(data, 'base64')) }
function processes() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  return JSON.parse(ps.stdout)
}
function tree(all, rootPid) {
  const ids = new Set([rootPid]); let grew = true
  while (grew) { grew = false; for (const p of all) if (ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) { ids.add(p.ProcessId); grew = true } }
  return all.filter((p) => ids.has(p.ProcessId))
}
const redact = (text) => (text ?? '').replace(/(DM_SESSION_TOKEN=)\S+/giu, '$1<redacted>')
function findFiles(dir, name, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name === name) found.push(...readdirSync(full).map((f) => join(full, f))); else findFiles(full, name, found) }
  }
  return found
}

try {
  result.versions = { node: process.version, omp: spawnSync(omp, ['--version'], { env: authEnv, encoding: 'utf8', windowsHide: true }).stdout.trim(), exeSha256: sha(exe), os: `${process.platform} ${process.arch}` }
  assert.equal(spawnSync('git', ['init', '-q', folder]).status, 0)
  assert.equal(spawnSync('git', ['-C', folder, '-c', 'user.name=dm505', '-c', 'user.email=dm505@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'scratch']).status, 0)
  // Only the installed OMP's credentials move, in memory, into the scratch agent folder; nothing is written to evidence.
  const exported = spawnSync(omp, ['auth', 'export'], { env: authEnv, encoding: 'utf8', maxBuffer: 4 << 20, windowsHide: true })
  const imported = spawnSync(omp, ['auth', 'import', '-'], { env, input: exported.stdout, encoding: 'utf8', maxBuffer: 4 << 20, windowsHide: true })
  record('omp-auth-copied-to-scratch', exported.status === 0 && imported.status === 0, { export: exported.status, import: imported.status, scratchAgentDir: '<scratch>/home/.omp/agent' })
  exported.stdout = ''

  const seed = join(root, 'seed.cjs'), inject = join(root, 'inject.cjs')
  const bundle = (contents, outfile) => buildSync({ absWorkingDir: repo, stdin: { resolveDir: repo, contents }, outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'warning', external: ['electron'] })
  bundle(`
    import {openWorkspace} from './src/core/workspace'; import {openAppDatabase} from './src/main/desktop/appDatabase';
    import {createAgentRegistry} from './src/main/desktop/agentRegistry'; import {createFolderRegistry} from './src/main/desktop/folderRegistry'; import {join} from 'node:path';
    (async()=>{const ws=openWorkspace({repoRoot:${JSON.stringify(folder)},homeDir:${JSON.stringify(dmHome)},role:'desktop',transport:'desktop',label:'DM505 pack'});
    await ws.initializeRepository({mode:'db',name:'DM505 pack proof'});ws.close();
    const db=openAppDatabase(${JSON.stringify(userData)});createAgentRegistry({db}).upsert({kind:'omp',executablePath:${JSON.stringify(omp)},version:${JSON.stringify(result.versions.omp)},connectedVia:'found'});db.close();
    createFolderRegistry({file:join(${JSON.stringify(userData)},'folders.json'),homeDir:${JSON.stringify(home)},dmHome:${JSON.stringify(dmHome)}}).track(${JSON.stringify(folder)});
    })().catch(e=>{console.error(e);process.exitCode=1});`, seed)
  const seeded = spawnSync(process.execPath, [seed], { env, encoding: 'utf8', windowsHide: true })
  record('scratch-stores-seeded', seeded.status === 0, (seeded.stdout + seeded.stderr).trim().slice(0, 500))
  assert.equal(seeded.status, 0)

  const net = await import('node:net')
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); port = s.address().port; await new Promise((r) => s.close(r))
  child = spawn(exe, [...(dev ? [process.env.PACK_APP] : []), `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
  let log = ''
  child.stdout.on('data', (c) => { log += c }); child.stderr.on('data', (c) => { log += c })
  closed = new Promise((r) => child.once('exit', (code) => r(code)))
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('/renderer/index.html')) } catch { return null } }, 'packaged renderer', 60_000)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej })
  socket.onmessage = (event) => { const m = JSON.parse(event.data); const e = pending.get(m.id); if (!e) return; pending.delete(m.id); m.error ? e.rej(new Error(JSON.stringify(m.error))) : e.res(m.result) }
  await cdp('Runtime.enable')
  record('packaged-app-renderer-loaded', true, { url: target.url })
  await untilJs(`document.querySelector('[aria-label^="Expand "]') !== null || document.querySelector('[aria-label^="New chat in "]') !== null`, 'tracked folder')
  await evaluate(`{const e=document.querySelector('[aria-label^="Expand "]');if(e)e.click();}`)

  const F = JSON.stringify(folder)
  const created = []
  for (const [title, role] of [['Alpha', 'worker'], ['Beta', 'reviewer']]) {
    const r = await evaluate(`window.dm.chats.create({folder:${F},agent:'omp',role:'${role}',title:'${title}'})`)
    assert(r.ok, JSON.stringify(r))
    created.push(r.data)
    await untilJs(`Array.from(document.querySelectorAll('.chat-row-main')).some(e=>e.textContent.includes('${title}'))`, `${title} row`)
    await evaluate(`Array.from(document.querySelectorAll('.chat-row-main')).find(e=>e.textContent.includes('${title}')).click()`)
    await untilJs(`window.dm.chats.list(${F}).then(r=>r.data.find(c=>c.id==='${r.data.id}'&&c.endpointId))`, `${title} endpoint`, 60_000)
  }
  const chats = (await evaluate(`window.dm.chats.list(${F})`)).data
  const [alpha, beta] = created.map((c) => chats.find((x) => x.id === c.id))
  record('chats-started-with-mailboxes', Boolean(alpha.endpointId && beta.endpointId), { alpha: alpha.endpointId, beta: beta.endpointId })

  // Native PTY + packaged extension: the app's process tree holds omp launched with -e <resources>\skitarii\extension\index.ts.
  const appTree = () => tree(processes(), child.pid)
  const ompProcs = await until(() => { const t = appTree().filter((p) => /omp/i.test(p.Name ?? '') && /skitarii/i.test(p.CommandLine ?? '')); return t.length >= 2 ? t : null }, 'two OMP processes', 60_000)
  const ext = /-e\s+"?([^"]+?skitarii[\\/]extension[\\/]index\.ts)"?/iu.exec(ompProcs[0].CommandLine)?.[1]
  const resources = ext ? resolve(ext, '..', '..', '..') : null
  const ptyHosts = appTree().filter((p) => /conpty|OpenConsole|winpty/i.test(`${p.Name} ${p.CommandLine}`)).map((p) => ({ pid: p.ProcessId, name: p.Name }))
  record('native-pty-runs-omp', ompProcs.length >= 2, { omp: ompProcs.map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, commandLine: redact(p.CommandLine) })), ptyHosts })
  const extFiles = ['index.ts', 'dmClient.ts', 'messaging.ts'].map((f) => join(resources ?? '', 'skitarii', 'extension', f))
  const asar = require('@electron/asar')
  const asarFile = join(resources ?? '', 'app.asar')
  const asarList = existsSync(asarFile) ? asar.listPackage(asarFile) : []
  record(dev ? 'extension-from-project-resources' : 'extension-outside-asar', Boolean(resources) && extFiles.every((f) => existsSync(f)) && (dev || (!asarList.some((f) => /skitarii[\\/]extension/iu.test(f)) && asarList.some((f) => /[\\/]out[\\/]main[\\/]cli\.js$/u.test(f)))), {
    extensionArg: ext, resourcesPath: resources, files: extFiles.map((f) => ({ path: f, exists: existsSync(f), sha256: existsSync(f) ? sha(f) : null, sameAsRepo: existsSync(f) && sha(f) === sha(join(repo, 'resources', 'skitarii', 'extension', f.split(/[\\/]/u).pop())) })),
    asarHasCliJs: asarList.some((f) => /[\\/]out[\\/]main[\\/]cli\.js$/u.test(f)), asarHasExtension: asarList.some((f) => /skitarii[\\/]extension/iu.test(f))
  })

  // Descriptor: written per launch under the chat's OMP folder; pins this packaged exe + its app.asar cli.js; no grant.
  const descriptors = findFiles(userData, 'dm-client')
  const parsed = descriptors.map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  // The descriptor may name inherited variables (`inherit`), but holds no value beyond its fixed fields: never a grant.
  const FIELDS = new Set(['version', 'chatId', 'generation', 'folder', 'command', 'args', 'cwd', 'env', 'inherit'])
  const pinned = parsed.map(({ path, text }) => { const d = JSON.parse(text); return { path, descriptor: d, hasToken: Object.keys(d).some((k) => !FIELDS.has(k)) || Object.keys(d.env ?? {}).some((k) => !['ELECTRON_RUN_AS_NODE', 'DARKMECHANICUS_HOME'].includes(k)) } })
  const expectCli = dev ? join(repo, 'out', 'main', 'cli.js') : join(resources ?? '', 'app.asar', 'out', 'main', 'cli.js')
  const pinsPackaged = pinned.length === 2 && pinned.every(({ descriptor, hasToken }) => !hasToken && descriptor.command && existsSync(descriptor.command) && sameRuntime(descriptor.command, resources) && descriptor.args?.[0]?.toLowerCase() === expectCli.toLowerCase())
  record('descriptor-pins-packaged-runtime-and-cli', pinsPackaged, pinned.map(({ path, descriptor, hasToken }) => ({ path: path.replace(root, '<scratch>'), descriptor, hasToken })))

  // Mail from Alpha to Beta through the store; Beta's extension can only show it by its dmClient running the packaged CLI with Beta's bound grant.
  bundle(`import {openWorkspace} from './src/core/workspace'; import {acceptMessage} from './src/core/services/agentMailStore';
    const ws=openWorkspace({repoRoot:${JSON.stringify(folder)},homeDir:${JSON.stringify(dmHome)},role:'desktop',transport:'desktop',label:'DM505 inject'});
    try{console.log(JSON.stringify(acceptMessage(ws.ctx(),{senderEndpointId:${JSON.stringify(alpha.endpointId)},to:${JSON.stringify(beta.endpointId)},clientMessageId:'dm505-pack-1',body:'DM-505 packaged fixture mail'})))}finally{ws.close()}`, inject)
  const injected = spawnSync(process.execPath, [inject], { env, encoding: 'utf8', windowsHide: true })
  record('fixture-mail-alpha-to-beta', injected.status === 0, (injected.stdout + injected.stderr).trim().slice(0, 600))

  const cliChildren = new Map()
  const ompPids = new Set(ompProcs.map((p) => p.ProcessId))
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline && cliChildren.size < 4) {
    for (const p of appTree()) if (/cli\.js/u.test(p.CommandLine ?? '') && / call /u.test(p.CommandLine ?? '')) cliChildren.set(p.ProcessId, { pid: p.ProcessId, parent: p.ParentProcessId, parentIsOmp: ompPids.has(p.ParentProcessId), exe: p.ExecutablePath, commandLine: redact(p.CommandLine) })
    await new Promise((r) => setTimeout(r, 300))
  }
  const children = [...cliChildren.values()]
  record('dmclient-spawns-packaged-cli-child', children.some((c) => sameRuntime(c.exe, resources) && c.commandLine.toLowerCase().includes(expectCli.toLowerCase())), children)
  const mail = await evaluate(`window.dm.chats.mail.state({folder:${F},chatId:'${beta.id}'})`)
  record('beta-mail-state', mail.ok && mail.data.pendingCount === 1, mail.ok ? { pendingCount: mail.data.pendingCount, unseenCount: mail.data.unseenCount } : mail)
  await evaluate(`Array.from(document.querySelectorAll('.chat-row-main')).find(e=>e.textContent.includes('Beta')).click()`)
  await new Promise((r) => setTimeout(r, 8000)) // a few watcher ticks so the status line has painted
  await screenshot(`DM-505-pack-${label}-beta-terminal.png`)
  const rows = await evaluate(`Array.from(document.querySelectorAll('.xterm-rows, .xterm-accessibility')).map(e=>e.innerText).join('\\n')`)
  if (rows) record('beta-terminal-text', /Skitarii mail: 1 unread/u.test(rows) && !/unavailable/iu.test(rows), rows.split('\n').filter((l) => /Skitarii mail/u.test(l)))
  result.appLog = redact(log).slice(-4000)
} catch (error) {
  record('run', false, String(error?.stack ?? error))
} finally {
  if (child) {
    // Quit as the person does: close the main window. Every process the run started must be gone within 10 s.
    const owned = tree(processes(), child.pid).map((p) => p.ProcessId)
    try { await Promise.race([evaluate('window.close()'), new Promise((r) => setTimeout(r, 2000))]) } catch { /* the page goes away as it closes */ }
    try { socket?.close() } catch { /* closing */ }
    const alive = () => { const now = new Set(processes().map((p) => p.ProcessId)); return owned.filter((pid) => now.has(pid)) }
    const deadline = Date.now() + 10_000
    let left = alive()
    while (left.length && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 500)); left = alive() }
    record('processes-gone-after-window-close', left.length === 0, { owned: owned.length, left })
    for (const pid of left) spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], { windowsHide: true })
    await new Promise((r) => setTimeout(r, 2000))
  }
  result.finishedAt = new Date().toISOString()
  const json = JSON.stringify(result, null, 2)
  const scrub = (text, path) => text.split(path).join('<scratch>').split(JSON.stringify(path).slice(1, -1)).join('<scratch>')
  writeFileSync(join(output, `DM-505-pack-${label}-result.json`), scrub(json, root))
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); console.log('scratch removed', !existsSync(root)) } catch (e) { console.log('scratch removal failed', String(e)) }
  process.exit(result.checks.every((c) => c.passed) ? 0 : 1)
}
