// c12: rebase -r stopped at a conflicting merge → rebase banner (not merge banner); Abort ends the rebase.
// c13: committing only ':/a' commits exactly that file; 'a' stays in Changes.
// c14: conflicting merge resolved and committed from the app → message is 'Merge branch …' with no '#' lines.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { S, git, start, openRepo, shot } from './lib.mjs'

const R = join(S, 'scratch-rebase')
const P = join(S, 'scratch-pathspec')
const M = join(S, 'scratch-merge')
const gitDir = (repo, name) => existsSync(join(repo, '.git', name))
console.log('c12 before: MERGE_HEAD', gitDir(R, 'MERGE_HEAD'), '| rebase-merge/', gitDir(R, 'rebase-merge'), '\n$ git status (first line): ' + git(R, 'status').split('\n')[0])
const { page, close } = await start([R, P, M])
try {
  await openRepo(page, 'scratch-rebase')
  const region = page.getByRole('region', { name: 'Operation in progress' })
  await region.waitFor({ timeout: 20000 })
  console.log('c12 banner:', JSON.stringify(await region.innerText()))
  console.log('c12 merge banner present:', await page.getByRole('region', { name: 'Merge in progress' }).count(), '| Abort merge / Commit merge buttons:', await page.getByRole('button', { name: 'Abort merge' }).count(), await page.getByRole('button', { name: 'Commit merge' }).count())
  await shot(page, 'c12-rebase-banner')
  await region.getByRole('button', { name: 'Abort', exact: true }).click()
  const confirm = page.getByRole('dialog')
  if (await confirm.isVisible().catch(() => false)) {
    console.log('c12 confirm dialog:', JSON.stringify(await confirm.innerText()))
    await confirm.getByRole('button', { name: /Abort/ }).last().click()
  }
  await region.waitFor({ state: 'detached', timeout: 30000 })
  await page.waitForTimeout(800)
  await shot(page, 'c12-after-abort')
  console.log('c12 after Abort: MERGE_HEAD', gitDir(R, 'MERGE_HEAD'), '| rebase-merge/', gitDir(R, 'rebase-merge'), '\n$ git status:\n' + git(R, 'status'))

  await openRepo(page, 'scratch-pathspec')
  console.log('c13 $ git status --short before:', JSON.stringify(git(P, 'status', '--short')))
  await page.locator('input[aria-label="Include a"]').click()
  await page.waitForTimeout(300)
  console.log('c13 include :/a =', await page.locator('input[aria-label="Include :/a"]').isChecked(), '| include a =', await page.locator('input[aria-label="Include a"]').isChecked())
  await page.getByLabel('Summary').fill('Commit only :/a')
  await shot(page, 'c13-only-colon-slash-a-included')
  await page.getByRole('button', { name: /^Commit to main/ }).click()
  await page.getByText(/Committed [0-9a-f]{7}/).first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(1500)
  await shot(page, 'c13-after-commit')
  console.log('c13 $ git show --stat HEAD:\n' + git(P, 'show', '--stat', '--format=%h %s', 'HEAD'))
  console.log('c13 $ git status --short after:', JSON.stringify(git(P, 'status', '--short')))
  console.log('c13 Changes list:', JSON.stringify((await page.locator('input[aria-label^="Include "]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))))

  await openRepo(page, 'scratch-merge')
  await page.getByRole('button', { name: /Current branch/ }).click()
  const option = page.getByRole('option', { name: /feature\/conflict/ })
  await option.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Merge into main' }).click()
  const mergeBanner = page.getByRole('region', { name: 'Merge in progress' })
  await mergeBanner.waitFor({ timeout: 20000 })
  console.log('c14 banner on first paint:', JSON.stringify(await mergeBanner.innerText()))
  await page.getByText(/^Merging feature\/conflict into main: 1 conflicted file$/).waitFor({ timeout: 20000 })
  console.log('c14 banner:', JSON.stringify(await mergeBanner.innerText()), '| .git/MERGE_MSG:', JSON.stringify(readFileSync(join(M, '.git', 'MERGE_MSG'), 'utf8')))
  await shot(page, 'c14-merge-conflict')
  await page.getByRole('list', { name: 'Conflicted files' }).locator('li').filter({ hasText: 'c.txt' }).getByRole('button', { name: /^Use mine/ }).click()
  await page.getByText(/: 0 conflicted files$/).waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: 'Commit merge' }).click()
  await mergeBanner.waitFor({ state: 'detached', timeout: 20000 })
  await page.waitForTimeout(800)
  await shot(page, 'c14-merge-committed')
  const body = git(M, 'log', '-1', '--format=%B')
  console.log('c14 $ git log -1 --format=%B:\n' + body + '\n--- lines starting with #:', body.split('\n').filter((l) => l.startsWith('#')).length, '| parents:', git(M, 'log', '-1', '--format=%p'))
} catch (error) {
  await shot(page, 'c12to14-error')
  throw error
} finally {
  await close()
}
