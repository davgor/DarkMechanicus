// c5: commit 3 of 5 changed lines over two hunks (LF file, then CRLF file); HEAD holds exactly those, working file unchanged.
// c6: some lines unselected → file checkbox indeterminate (screenshot); editing the file resets the selection with the toast.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { S, git, start, openRepo, shot } from './lib.mjs'

const L = join(S, 'scratch-lines')
const SEL = join(S, 'scratch-sel')
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)
const row = (page, text) => page.locator('tr').filter({ has: page.locator('.diff-text', { hasText: text }) }).first()
const fileBox = (page, path) => page.locator(`input[aria-label="Include ${path}"]`)
const boxState = (page, path) => fileBox(page, path).evaluate((b) => (b.indeterminate ? 'indeterminate' : b.checked ? 'checked' : 'unchecked'))
const lineStates = (page) => page.evaluate(() => [...document.querySelectorAll('tr')].filter((r) => r.querySelector('.diff-box'))
  .map((r) => `${r.querySelector('.diff-text')?.textContent?.replace(/\r/g, '\\r')}=${r.querySelector('.diff-box').getAttribute('aria-checked')}`))

function expected(eol) {
  const out = []
  for (let i = 1; i <= 20; i++) {
    if (i !== 3) out.push(`line ${i}`)
    if (i === 17) out.push('B1 added', 'B3 added')
  }
  return out.map((l) => l + eol).join('')
}

async function commitLines(page, file, other, eol) {
  const before = sha(join(L, file))
  if ((await boxState(page, other)) !== 'unchecked') await fileBox(page, other).click()
  if ((await boxState(page, file)) !== 'checked') await fileBox(page, file).click()
  if ((await boxState(page, file)) !== 'checked') await fileBox(page, file).click()
  await page.getByRole('button', { name: new RegExp(`^${file.replace('.', '\\.')}`) }).click()
  await row(page, 'B2 added').locator('.diff-box').waitFor({ timeout: 15000 })
  await row(page, 'A1 new third line').locator('.diff-box').click()
  await row(page, 'B2 added').locator('.diff-box').click()
  await page.waitForTimeout(300)
  console.log(`${file} lines:`, JSON.stringify(await lineStates(page)), '| file box:', await boxState(page, file), '| other:', await boxState(page, other))
  await shot(page, `c5-${file.replace('.txt', '')}-selected`)
  await page.getByLabel('Summary').fill(`Commit 3 of 5 lines of ${file}`)
  await page.getByRole('button', { name: /^Commit to main/ }).click()
  await page.getByText(/Committed [0-9a-f]{7}/).first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(1500)
  const raw = execShow(file)
  console.log(`$ git show --stat HEAD (${file}):\n` + git(L, 'show', '--stat', '--format=%h %s', 'HEAD'))
  console.log(`${file}: HEAD blob equals expected (1,2,4..17,B1,B3,18..20 with ${JSON.stringify(eol)}):`, raw === expected(eol), '| working file unchanged:', sha(join(L, file)) === before)
  console.log(`$ git diff -- ${file} (left in Changes):\n` + git(L, 'diff', '--', file).replace(/\r/g, '\\r'))
  await shot(page, `c5-${file.replace('.txt', '')}-after-commit`)
}

function execShow(file) { return execFileSync('git', ['-C', L, 'show', `HEAD:${file}`], { encoding: 'latin1' }) }

const { page, close } = await start([L, SEL])
try {
  // c6 first, on scratch-sel
  await openRepo(page, 'scratch-sel')
  await page.getByRole('button', { name: /^list\.txt/ }).click()
  await row(page, 'X2 inserted').locator('.diff-box').waitFor({ timeout: 15000 })
  await row(page, 'X2 inserted').locator('.diff-box').click()
  await row(page, 'Y1 inserted').locator('.diff-box').click()
  await page.waitForTimeout(300)
  console.log('c6 lines:', JSON.stringify(await lineStates(page)), '| list.txt box:', await boxState(page, 'list.txt'))
  await shot(page, 'c6-partial-lines-indeterminate')
  appendFileSync(join(SEL, 'list.txt'), 'edited outside the app\n')
  const toast = page.getByText(/list\.txt changed, so its line selection was reset/)
  await toast.first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(500)
  console.log('c6 toast:', JSON.stringify(await toast.first().innerText()))
  console.log('c6 after edit lines:', JSON.stringify(await lineStates(page)), '| list.txt box:', await boxState(page, 'list.txt'))
  await shot(page, 'c6-selection-reset-toast')

  // c5 on scratch-lines
  await openRepo(page, 'scratch-lines')
  await commitLines(page, 'notes.txt', 'crlf.txt', '\n')
  await commitLines(page, 'crlf.txt', 'notes.txt', '\r\n')
  console.log('$ git log --oneline:\n' + git(L, 'log', '--oneline'))
} catch (error) {
  await shot(page, 'c5c6-error')
  throw error
} finally {
  await close()
}
