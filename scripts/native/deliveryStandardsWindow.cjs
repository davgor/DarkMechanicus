const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app } = require('electron')

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

async function exercise(win) {
  const { evaluate, until, click, tab, field, saved, capture } = desktopControls(win)
  win.setContentSize(1440, 960)
  await click('.folder-main .folder-name', 'Mars')
  await tab()
  await until('document.querySelectorAll(".standards-field textarea").length === 4')
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
}

app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => {
    exercise(win).then(() => app.quit(), error => { console.error(error); app.exit(1) })
  })
})
require(join(repo, 'out/main/index.js'))
