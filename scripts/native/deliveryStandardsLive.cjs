/** Optional real-provider proof. After npm run build, with normally signed-in OMP:
 * node --import tsx scripts/native/deliveryStandardsEvidence.mjs out/standards-live --live-skitarii
 * SKITARII_SMOKE_MODEL and SKITARII_SMOKE_OMP select an existing provider/model and OMP binary.
 * Uses the production app, scoped desktop API, terminal and Skitarii extension. Only the file picker
 * selects an executable automatically. The project, chat registry and session files are disposable.
 */
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app, dialog } = require('electron')

const [root, output, repo] = process.argv.slice(2)
const profile = join(root, 'desktop')
const folder = join(root, 'Mars')
const model = process.env.SKITARII_SMOKE_MODEL ?? 'openai-codex/gpt-6.1-sol'
const omp = process.env.SKITARII_SMOKE_OMP ?? join(process.env.LOCALAPPDATA, 'omp', 'omp.exe')
const question = 'What are this project’s four saved Delivery Standards instructions? Quote the full instructions verbatim, including their reference identifiers, one per line in Planned, Ticket, Sprint, Epic order. Output just those four lines without labels, quotation marks or formatting. Answer from the context already supplied; do not invoke tools or inspect files.'
const fields = ['Planned standards', 'Ticket standards', 'Sprint standards', 'Epic standards']
const instructions = [
  ['List a negative test for each restore path.', 'Verify byte equality before accepting restored files.',
   'Deploy the restore screen and exercise a backup.', 'Archive the release evidence with its commit.'],
  ['Name a rollback scenario for every migration.', 'Prove duplicate imports keep existing record IDs.',
   'Deploy the import screen and verify its version.', 'Review every shipped migration against its recovery criteria.']
]
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const json = JSON.stringify

async function waitFor(read, label, deadline = 30_000) {
  const expires = Date.now() + deadline
  while (Date.now() < expires) {
    const result = await read()
    if (result) return result
    await pause(150)
  }
  throw Error('Timed out waiting for ' + label)
}

function messages(chatId) {
  const dir = join(profile, 'agents', 'omp', chatId, 'sessions')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => /^\d{4}-.*\.jsonl$/.test(f)).sort().flatMap(f => {
    // Parse only complete records; the provider may be in the middle of appending one.
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').slice(0, -1).filter(Boolean)
    return lines.map(line => JSON.parse(line)).filter(e => e.type === 'message').map(e => e.message)
  })
}

async function openChat(wc, title) {
  const row = `Array.from(document.querySelectorAll('.chat-row-main')).find(r=>r.querySelector('.chat-row-title')?.textContent===${json(title)})`
  await waitFor(() => wc.executeJavaScript(`(() => {
    const toggle=document.querySelector('.agent-chats-toggle[aria-label="Chats of Skitarii"]');
    if(toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    const row=${row}; if(!row) return false; row.click(); return true;
  })()`), 'chat selection')
}

async function send(wc, chatId) {
  await waitFor(() => wc.executeJavaScript(`(async () => {
    if(!document.querySelector('.xterm-helper-textarea')) return false;
    const r=await window.dm.terminals.attach(${json(folder)},${json(chatId)});
    if(!r.ok) return false;
    try {return r.data.snapshot.includes('\u001b[?2004h')} finally {r.data.terminal?.close()}
  })()`), 'ready native terminal')
  await wc.executeJavaScript("document.querySelector('.terminal-host .xterm-helper-textarea').focus()")
  await wc.debugger.sendCommand('Input.insertText', { text: question })
  await pause(500)
  for (const type of ['keyDown','keyUp']) {
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
}

async function checkTurn(wc, chatId, expected, name) {
  const from = messages(chatId).length
  await send(wc, chatId)
  const reply = await waitFor(() => {
    const turn = messages(chatId).slice(from)
    const start = turn.findIndex(m => m.role === 'user' && json(m.content).includes(question))
    if (start === -1) return false
    const assistant = turn.slice(start + 1).find(m => m.role === 'assistant')
    if (!assistant) return false
    assert(!['error','aborted'].includes(assistant.stopReason), 'Real provider rejected the request')
    assert(!assistant.content.some(p => p.type === 'toolCall'), 'Model attempted a tool read')
    const text = assistant.content.filter(p => p.type === 'text').map(p => p.text).join('').replaceAll('\r\n', '\n').trim()
    assert(text === expected, 'Provider did not recall the current four values')
    return text
  }, name + ' provider reply', 150_000)
  await waitFor(() => wc.executeJavaScript(`(async () => {
    const r=await window.dm.terminals.attach(${json(folder)},${json(chatId)});
    if(!r.ok) return false; try {return r.data.snapshot.includes(${json(expected.split(' ').at(-1))})}
    finally {r.data.terminal?.close()}
  })()`), 'visible assistant result')
  const image = await wc.capturePage()
  assert(!image.isEmpty())
  writeFileSync(join(output, name + '.png'), image.toPNG())
  return { chatId, reply, toolCalls: 0, screenshot: name + '.png' }
}

function nativeAgentPid(chatId) {
  assert(/^[a-zA-Z0-9_-]+$/.test(chatId))
  const output = execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    `Get-CimInstance Win32_Process -Filter "Name = 'omp.exe'" | Where-Object { $_.CommandLine -like '*${chatId}*' } | Select-Object -ExpandProperty ProcessId`
  ],{encoding:'utf8',windowsHide:true,timeout:10_000}).trim()
  assert(/^\d+$/.test(output), 'Expected exactly one native OMP process for the fixture chat')
  return Number(output)
}

async function saveStandards(wc, command, revision, screenshot) {
  const lines = instructions[revision - 1].map(line => line + ' Ref ' + randomBytes(5).toString('hex'))
  await wc.executeJavaScript(`Array.from(document.querySelectorAll('.folder-main .folder-name')).find(n => n.textContent === 'Mars').click()`)
  await waitFor(() => wc.executeJavaScript(`Boolean(document.querySelector('[data-tab="standards"]'))`), 'project tabs')
  await wc.executeJavaScript(`document.querySelector('[data-tab="standards"]').click()`)
  await waitFor(() => wc.executeJavaScript('document.querySelectorAll(".standards-field textarea").length === 4'), 'editable fields')
  for (const [i, label] of fields.entries()) {
    await wc.executeJavaScript(`(() => {
      const field=document.querySelector(${json('textarea[aria-label="' + label + '"]')});
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${json(lines[i])});
      field.dispatchEvent(new Event('input',{bubbles:true}));
    })()`)
  }
  await wc.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save standards' && !b.disabled).click()`)
  await waitFor(() => wc.executeJavaScript(`document.body.innerText.includes('Saved revision ${revision}')`), 'revision saved')
  const project = await command('getProject')
  assert.equal(project.deliveryStandards.revision, revision)
  const saved = project.deliveryStandards.policy.prompts
  assert.deepEqual([saved.planned,saved.ticket,saved.sprint,saved.epic], lines)
  writeFileSync(join(output, screenshot + '.png'), (await wc.capturePage()).toPNG())
  return lines.join('\n')
}

async function exercise(win) {
  win.setContentSize(1440, 960)
  const wc = win.webContents
  const invoke = async expression => {
    const result = await wc.executeJavaScript(expression)
    assert(result.ok, 'Desktop refused operation: ' + (result.error?.code ?? 'unknown'))
    return result.data
  }
  const command = (name) => invoke(`window.dm.command(${json(folder)},${json(name)},undefined)`)
  await waitFor(() => wc.executeJavaScript('Boolean(window.dm && document.querySelector(".folder-main"))'), 'desktop')
  await wc.executeJavaScript(`document.querySelector('button[aria-label="Add an agent"]').click()`)
  await waitFor(() => wc.executeJavaScript(`Boolean(document.querySelector('button[aria-label="Find Skitarii"]'))`), 'Find Skitarii')
  await wc.executeJavaScript(`document.querySelector('button[aria-label="Find Skitarii"]').click()`)
  await waitFor(() => wc.executeJavaScript(`Array.from(document.querySelectorAll('.sidebar-agents .agent-name')).some(n => n.textContent === 'Skitarii')`), 'connected Skitarii')
  const create = async title => {
    const chat = await invoke(`window.dm.chats.create(${json({ folder, agent: 'omp', role: 'worker', title, model })})`)
    await openChat(wc, title)
    return chat.id
  }
  wc.debugger.attach()
  const initial = await saveStandards(wc, command, 1, '01-initial-standards')
  const firstTitle = 'Existing standards session'
  const first = await create(firstTitle)
  const checks = [await checkTurn(wc, first, initial, '02-initial-agent')]
  const pid = nativeAgentPid(first)
  const revised = await saveStandards(wc, command, 2, '03-revised-standards')
  await openChat(wc, firstTitle)
  checks.push(await checkTurn(wc, first, revised, '04-running-agent'))
  assert.equal(nativeAgentPid(first), pid, 'Existing Skitarii process restarted')
  const second = await create('Fresh standards session')
  assert.notEqual(first, second)
  checks.push(await checkTurn(wc, second, revised, '05-new-agent'))
  assert.notEqual(nativeAgentPid(second), pid)
  writeFileSync(join(output,'provider-proof.json'), json({ model, checks }, null, 2))
}

app.setAppPath(repo)
app.setPath('userData', profile)
dialog.showOpenDialog = async () => ({canceled:false,filePaths:[omp]})
app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => {
  exercise(win).then(() => app.quit(), e => { console.error(e.message); app.exit(1) })
}))
require(join(repo, 'out/main/index.js'))
