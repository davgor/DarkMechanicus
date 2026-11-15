/** Real built Electron app + disposable custom CLI backed by the installed selected OMP model. No native/global input. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const output = resolve(repo, process.env.DM515_OUTPUT ?? 'evidence/dm515/desktop')
assert(!existsSync(output), 'Choose a fresh evidence directory; existing evidence is never overwritten.')
mkdirSync(output, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'dm515-desktop-'))
const home = join(root, 'home'), userData = join(root, 'userData'), folder = join(root, 'first-prompt-proof'), dmHome = join(root, 'dm-home')
for (const path of [home, userData]) mkdirSync(path, { recursive: true })
const omp = process.env.DM515_OMP ?? join(process.env.LOCALAPPDATA, 'omp', 'omp.exe')
const model = process.env.DM515_MODEL ?? 'openai-codex/gpt-6.1-sol'
const delivery = join(output, 'delivery.jsonl')
const prompt = '  Could you investigate why signing in keeps failing after the session expires and fix the refresh flow?\nPreserve existing approval boundaries and explain the result in café-friendly terms.  '
const checks = []
const record = (name, detail) => checks.push({ name, passed: true, detail })
const baselinePaths = [join(process.env.USERPROFILE, '.omp', 'agent', 'config.yml'), join(process.env.USERPROFILE, '.omp', 'agent', 'settings.json'), join(process.env.USERPROFILE, '.claude', 'settings.json')]
const hash = (path) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
const baseline = baselinePaths.map((path) => ({ path, sha256: hash(path) }))
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), PI_CODING_AGENT_DIR: join(home, '.omp', 'agent'), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), DARKMECHANICUS_HOME: dmHome, DM515_OMP: omp, DM515_MODEL: model }
for (const key of Object.keys(env)) if (/^(?:DM_SESSION_TOKEN|DM_DESKTOP_PIPE|ELECTRON_.*|NODE_OPTIONS)$/iu.test(key)) delete env[key]
const authEnv = { ...process.env }
delete authEnv.DM_SESSION_TOKEN
delete authEnv.DM_DESKTOP_PIPE
let child, socket, active, closed
let nextId = 0
const rendererErrors = []
const pending = new Map()
async function cdp(method, params = {}) {
  const id = ++nextId
  const result = new Promise((resolveResult, reject) => pending.set(id, { resolve: resolveResult, reject }))
  socket.send(JSON.stringify({ id, method, params }))
  return result
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression, label, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await evaluate(expression)
    if (result) return result
    await new Promise((resolveResult) => setTimeout(resolveResult, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function screenshot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(output, name), Buffer.from(data, 'base64'))
}
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
async function attach() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${active}/json/list`)).json()
      const target = targets.find((entry) => entry.type === 'page' && entry.url.includes('/renderer/index.html'))
      if (target) {
        socket = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((resolveResult, reject) => { socket.onopen = resolveResult; socket.onerror = reject })
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data)
          if (message.method === 'Runtime.exceptionThrown') rendererErrors.push(message.params.exceptionDetails)
          if (message.method === 'Log.entryAdded') rendererErrors.push(message.params.entry)
          const entry = pending.get(message.id)
          if (!entry) return
          pending.delete(message.id)
          if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
          else entry.resolve(message.result)
        }
        await cdp('Runtime.enable')
        await cdp('Log.enable')
        return
      }
    } catch { /* The owned app's debug endpoint is still starting. */ }
    await new Promise((resolveResult) => setTimeout(resolveResult, 100))
  }
  throw new Error('Owned Electron app did not expose its renderer.')
}
async function launch() {
  const net = await import('node:net')
  const portServer = net.createServer()
  await new Promise((resolveResult) => portServer.listen(0, '127.0.0.1', resolveResult))
  active = portServer.address().port
  await new Promise((resolveResult) => portServer.close(resolveResult))
  child = spawn(require('electron'), [join(root, 'app.cjs'), `--remote-debugging-port=${active}`], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: false })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  closed = new Promise((resolveResult) => child.once('exit', (code) => { writeFileSync(join(output, `electron-${active}.txt`), stdout + '\n' + stderr); resolveResult(code) }))
  await attach()
  await until(`document.querySelector('[aria-label^="Expand "]') !== null || document.querySelector('[aria-label^="New chat in "]') !== null`, 'tracked folder')
  await evaluate(`{const expand=document.querySelector('[aria-label^="Expand "]');if(expand)expand.click();}`)
  await until(`document.querySelector('[aria-label^="New chat in "]') !== null`, 'folder chat control')
}
async function quit() {
  socket?.close(); socket = undefined
  if (!child || child.exitCode !== null) return
  child.send('quit')
  const result = await Promise.race([closed, new Promise((resolveResult) => setTimeout(() => resolveResult('timeout'), 12_000))])
  if (result === 'timeout') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
    throw new Error('Owned app did not settle through normal disposal.')
  }
  assert.equal(result, 0)
}
try {
  const clone = spawnSync('git', ['clone', '--shared', '--no-checkout', repo, folder], { encoding: 'utf8', windowsHide: true })
  assert.equal(clone.status, 0, clone.stderr)
  // Credentials stay in memory in transit, then only in the disposable vendor home; no credential is an artifact.
  const exported = spawnSync(omp, ['auth', 'export'], { env: authEnv, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  assert.equal(exported.status, 0, 'Could not export existing credentials for isolated selected-model proof.')
  const imported = spawnSync(omp, ['auth', 'import', '-'], { env, input: exported.stdout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  assert.equal(imported.status, 0, 'Could not import credentials into the disposable vendor home.')
  exported.stdout = ''; imported.stdout = ''
  const seed = join(root, 'seed.cjs')
  buildSync({ absWorkingDir: repo, stdin: { resolveDir: repo, contents: `
    import {openWorkspace} from './src/core/workspace';
    import {openAppDatabase} from './src/main/desktop/appDatabase';
    import {createAgentRegistry} from './src/main/desktop/agentRegistry';
    import {createFolderRegistry} from './src/main/desktop/folderRegistry';
    import {createChatStore} from './src/main/agents/chatStore';
    import {writeFileSync,readdirSync} from 'node:fs'; import {join} from 'node:path';
    (async()=>{const folder=${JSON.stringify(folder)},data=${JSON.stringify(userData)},home=${JSON.stringify(home)},dmHome=${JSON.stringify(dmHome)};
    const workspace=openWorkspace({repoRoot:folder,homeDir:dmHome,role:'desktop',transport:'desktop',label:'DM515 isolated proof'});
    await workspace.initializeRepository({mode:'db',name:'First prompt proof'});workspace.close();
    const db=openAppDatabase(data);createAgentRegistry({db}).addCustom({id:'cu_01m7excm4q4w8k80je8vrvffej',displayName:'Disposable semantic agent',executablePath:${JSON.stringify(process.execPath)},args:[${JSON.stringify(join(repo, 'scripts/native/main/firstPromptAgent.mjs'))},'{instructions}',${JSON.stringify(delivery)}]});db.close();
    createFolderRegistry({file:join(data,'folders.json'),homeDir:home,dmHome}).track(folder);
    const store=createChatStore({root:join(data,'agents','chats')});const historical=store.createChat({folder,agent:'cu_01m7excm4q4w8k80je8vrvffej',model:null,role:'worker',allowSave:false,title:'Explicit existing history'});
    const dir=join(data,'agents','chats',readdirSync(join(data,'agents','chats'))[0]);writeFileSync(join(dir,historical.id+'.jsonl'),JSON.stringify({id:'old-user',at:new Date().toISOString(),kind:'user_message',text:'Historical read-only question'})+'\\n');
    writeFileSync(${JSON.stringify(join(output, 'fixture.json'))},JSON.stringify({root:${JSON.stringify(root)},folder,userData:data,historicalId:historical.id,model:${JSON.stringify(model)}},null,2));
    })().catch(e=>{console.error(e);process.exitCode=1});` }, outfile: seed, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'warning' })
  const seeded = spawnSync(process.execPath, [seed], { env, encoding: 'utf8', windowsHide: true })
  writeFileSync(join(output, 'seed.txt'), seeded.stdout + '\n' + seeded.stderr)
  assert.equal(seeded.status, 0, 'Disposable production stores could not be seeded.')
  writeFileSync(join(root, 'app.cjs'), `const {app}=require('electron');app.setAppPath(${JSON.stringify(repo)});app.setPath('userData',${JSON.stringify(userData)});app.setPath('home',${JSON.stringify(home)});process.on('message',m=>{if(m==='quit')app.quit()});require(${JSON.stringify(join(repo, 'out/main/index.js'))});`)
  await launch()
  const count = () => evaluate(`window.dm.chats.list(${JSON.stringify(folder)}).then(r=>r.data.length)`)
  const before = await count()
  await click('[aria-label^="New chat in "]')
  await until(`document.querySelector('[role="dialog"] textarea') !== null`, 'first-prompt popup')
  await screenshot('01-first-prompt-popup.png')
  assert.equal(await count(), before)
  assert(await evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>b.textContent==='Start').disabled`))
  await evaluate(`document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  assert.equal(await count(), before)
  await click('[aria-label^="New chat in "]')
  await until(`document.querySelector('[role="dialog"] textarea') !== null`, 'reopened popup')
  await evaluate(`{const t=document.querySelector('[role="dialog"] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(prompt)});t.dispatchEvent(new Event('input',{bubbles:true}));}`)
  await screenshot('02-full-prompt-popup.png')
  await evaluate(`{const f=document.querySelector('[role="dialog"] form');f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}`)
  await until(`document.querySelector('.terminal-pane h1') !== null`, 'opened terminal')
  const chat = await until(`window.dm.chats.list(${JSON.stringify(folder)}).then(r=>r.data.find(c=>c.titleStatus==='generated'))`, 'genuine model-inferred title', 120_000)
  assert(chat.title.split(/\s+/u).length <= 5)
  assert(!prompt.trim().toLowerCase().startsWith(chat.title.toLowerCase()))
  assert.equal(chat.firstPrompt, prompt)
  assert.equal(chat.firstPromptDelivery, 'submitted')
  assert.equal(await count(), before + 1)
  await until(`document.querySelector('.terminal-pane h1')?.textContent === ${JSON.stringify(chat.title)}`, 'header title')
  assert(await evaluate(`Array.from(document.querySelectorAll('.chat-row-title')).some(e=>e.textContent===${JSON.stringify(chat.title)})`))
  assert(await evaluate(`!document.querySelector('textarea[aria-label="Prompt"]') && !Array.from(document.querySelectorAll('button')).some(e=>e.textContent==='Send prompt')`))
  await screenshot('03-semantic-title-terminal.png')
  const messages = readFileSync(delivery, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(messages.filter((event) => event.event === 'first-message').map((event) => event.prompt), [prompt])
  assert.deepEqual(messages.filter((event) => event.event === 'model-request').map((event) => event.prompt), [prompt])
  record('popup-cancel-blank-and-double-submit', 'Cancel/Escape creates no chat; blank Start disabled; repeated submit creates exactly one chat.')
  record('real-selected-model-inference-and-full-delivery', { model, title: chat.title, firstMessageCount: 1, originalPrompt: prompt })
  await evaluate(`document.querySelector('.terminal-host .xterm-helper-textarea').focus()`)
  await cdp('Input.insertText', { text: 'Continue through native terminal input' })
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const deadline = Date.now() + 10_000
  while (!readFileSync(delivery, 'utf8').includes('later-message')) {
    assert(Date.now() < deadline, 'Terminal-native follow-up did not reach the custom CLI.')
    await new Promise((resolveResult) => setTimeout(resolveResult, 100))
  }
  record('terminal-native-follow-up', 'Actual xterm keyboard path delivers the later message without an app composer.')
  await quit()
  await launch()
  const reopened = await evaluate(`window.dm.chats.list(${JSON.stringify(folder)})`)
  assert.equal(reopened.data.find((entry) => entry.id === chat.id).title, chat.title)
  await evaluate(`Array.from(document.querySelectorAll('.chat-row-main')).find(e=>e.textContent.includes(${JSON.stringify(chat.title)})).click()`)
  await until(`document.querySelector('.terminal-pane h1')?.textContent === ${JSON.stringify(chat.title)}`, 'persisted reopened title')
  await screenshot('04-restart-persisted-title.png')
  assert.equal(readFileSync(delivery, 'utf8').split('"event":"first-message"').length - 1, 1)
  record('restart-persistence-without-redelivery', 'The same generated title survives real app restart and original message remains delivered once.')
  const manual = await evaluate(`window.dm.chats.rename({folder:${JSON.stringify(folder)},chatId:${JSON.stringify(chat.id)},title:'My explicit manual name'})`)
  assert.equal(manual.data.title, 'My explicit manual name')
  await evaluate(`Array.from(document.querySelectorAll('.chat-row-main')).find(e=>e.textContent.includes('Explicit existing history')).click()`)
  await until(`document.querySelector('.terminal-pane h1')?.textContent === 'Explicit existing history'`, 'explicit historical title')
  await evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes('Earlier conversation')).click()`)
  await until(`document.body.textContent.includes('Historical read-only question')`, 'read-only historical conversation')
  await screenshot('05-explicit-history.png')
  record('manual-name-and-read-only-history', 'Manual rename persists; an existing explicit history title is untouched and Earlier conversation remains readable.')
  const final = await evaluate(`window.dm.chats.list(${JSON.stringify(folder)})`)
  writeFileSync(join(output, 'persisted-chats.json'), JSON.stringify(final.data, null, 2))
  await quit()
  for (const entry of baseline) assert.equal(hash(entry.path), entry.sha256, `Global vendor settings changed: ${entry.path}`)
  writeFileSync(join(output, 'global-settings-unchanged.json'), JSON.stringify(baseline, null, 2))
} catch (error) {
  writeFileSync(join(output, 'failure.txt'), error.stack ?? String(error))
  if (socket) {
    await screenshot('failure.png').catch(() => {})
    const body = await evaluate('document.body.innerText').catch(() => 'Renderer inspection failed.')
    writeFileSync(join(output, 'failure-renderer.txt'), body)
    const page = await evaluate('({url:location.href,html:document.documentElement.outerHTML,bridge:typeof window.dm})').catch(() => ({}))
    writeFileSync(join(output, 'failure-page.json'), JSON.stringify({ page, rendererErrors }, null, 2))
  }
  throw error
} finally {
  try { await quit() } finally {
    rmSync(root, { recursive: true, force: true })
    writeFileSync(join(output, 'result.json'), JSON.stringify({ checks, root, disposableStateRemoved: !existsSync(root), model, evidence: output }, null, 2))
  }
}
console.log(JSON.stringify({ checks, output }, null, 2))
