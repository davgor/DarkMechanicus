const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app } = require('electron')

// Keep adjacent row measurements and captures independent of fractional host display scaling.
app.commandLine.appendSwitch('force-device-scale-factor', '1')

const [root, output, repo] = process.argv.slice(2)
app.setAppPath(repo)
app.setPath('userData', join(root, 'desktop'))
app.setPath('home', root)

function desktopControls(win) {
  const wc = win.webContents
  const evaluate = expression => wc.executeJavaScript(expression)
  async function until(expression) {
    const end = Date.now() + 10000
    while (Date.now() < end) {
      if (await evaluate(expression)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Desktop did not reach ' + expression + '\n' + await evaluate('document.body.innerText'))
  }
  const find = (selector, label) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el => el.textContent.trim() === ${JSON.stringify(label)})`
  async function click(selector, label) {
    const element = find(selector, label)
    await until(`Boolean(${element}) && !(${element}).disabled`)
    await evaluate(`(${element}).click()`)
  }
  async function capture(name) {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const image = await wc.capturePage()
    assert(!image.isEmpty())
    writeFileSync(join(output, name + '.png'), image.toPNG())
  }
  const tab = () => click('[role="tab"]', 'Delivery Standards')
  const field = 'textarea[aria-label="Ticket standards"]'
  const saved = revision => until(`document.body.innerText.includes("Saved revision ${revision}")`)
  return { evaluate, until, click, tab, field, saved, capture }
}

async function verifyRows(evaluate) {
  const rows = await evaluate(`Array.from(document.querySelectorAll('.standards-field')).map(field => {
    const box = field.getBoundingClientRect()
    return { label: field.querySelector('textarea').getAttribute('aria-label'), x: box.x, right: box.right,
      top: box.top, bottom: box.bottom }
  })`)
  assert.deepEqual(rows.map(row => row.label), ['Planned standards', 'Ticket standards', 'Sprint standards', 'Epic standards'])
  for (const [index, row] of rows.entries()) {
    assert(row.bottom > row.top && row.right > row.x, 'Expected a visible field')
    assert.equal(row.x, rows[0].x)
    assert.equal(row.right, rows[0].right)
    if (index) assert(row.top >= rows[index - 1].bottom, 'Each prompt must occupy its own row')
  }
}

async function verifyChatLaunches(controls) {
  const {evaluate, click, until, saved, tab} = controls
  const folder = join(root, 'Mars')
  const chats = `window.dm.chats.list(${JSON.stringify(folder)}).then(r => {if (!r.ok) throw Error(r.error.code); return r.data})`
  assert.equal((await evaluate(chats)).length, 0, 'Later must leave the project without a chat')
  async function launched(expectedCount, fragment) {
    await until(`(${chats}).then(list => list.length === ${expectedCount})`)
    await until('Boolean(document.querySelector(".terminal-pane"))')
    const records = await evaluate(chats)
    const chat = records.find(record => record.firstPrompt?.includes(fragment))
    assert(chat, 'Missing expected standards kickoff')
    assert.equal(chat.folder, folder)
    assert.equal(chat.role, 'planner')
    assert.equal(chat.allowSave, true)
    assert.equal(chat.agent, 'cu_01m7excm4q4w8k80je8vrvffej')
    return chat.firstPrompt
  }
  await click('button', 'Prepare with agent')
  const prepare = await launched(1, 'starting from revision 2')
  assert(prepare.includes('Apply these standards to all existing project work now, including items already in progress?'))
  await click('.folder-main .folder-name', 'Mars')
  await tab()
  await saved(2)
  await click('button', 'Standardize tickets')
  await click('button', 'Yes, apply revision 2')
  const standardize = await launched(2, 'Apply saved Delivery Standards revision 2')
  assert(standardize.includes('standardize_project_work') && standardize.includes('includeInProgress true'))
}

async function exercise(win) {
  const controls = desktopControls(win)
  const { evaluate, until, click, tab, field, saved, capture } = controls
  win.setContentSize(1440, 960)
  await click('.folder-main .folder-name', 'Mars')
  await tab()
  await until('document.querySelectorAll(".standards-field textarea").length === 4')
  await verifyRows(evaluate)
  await capture('01-project-setup')
  await click('button', 'Accept defaults')
  await saved(1)
  const ticket = await evaluate(`document.querySelector(${JSON.stringify(field)}).value`)
  const revised = ticket + '\nVerify the SQLite round-trip before ticket acceptance.'
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(field)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(revised)});
    el.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  await click('button', 'Save standards')
  await saved(2)
  await click('.folder-main .folder-name', 'Ryza')
  await tab()
  await click('button', 'Accept defaults')
  await saved(1)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(field)}).value`), ticket)
  await click('.folder-main .folder-name', 'Mars')
  await tab()
  await saved(2)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(field)}).value`), revised)
  await capture('02-saved-revision')
  await click('button', 'Standardize tickets')
  await until('Boolean(document.querySelector("[role=dialog]"))')
  await capture('03-standardize-confirmation')
  await click('button', 'Later')
  await until('!document.querySelector("[role=dialog]")')
  await verifyChatLaunches(controls)
}

app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => {
    exercise(win).then(() => app.quit(), error => { console.error(error); app.exit(1) })
  })
})
require(join(repo, 'out/main/index.js'))
