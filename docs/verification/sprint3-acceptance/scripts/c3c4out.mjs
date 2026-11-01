// c3: window.git.checkoutPullRequest(scratch-c, 1) creates pr/1 at refs/pull/1/head (called via Playwright
// page.evaluate in the renderer, the same call devtools would make); signed out, getPullRequests(scratch-gh) → auth_required.
// c4 (signed-out half): the Pull requests view in scratch-gh's branch menu.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { S, SIGNED_OUT_ENV, git, start, openRepo, shot } from './lib.mjs'

const C = join(S, 'scratch-c')
const GH = join(S, 'scratch-gh')
const ghStatus = () => {
  try { execFileSync('/opt/homebrew/bin/gh', ['auth', 'status', '--hostname', 'github.com'], { env: { ...process.env, ...SIGNED_OUT_ENV }, stdio: 'pipe' }); return 'exit 0' } catch (e) { return `exit ${e.status}` }
}
console.log('gh auth status with the app env (empty GH_CONFIG_DIR):', ghStatus())
const pullHead = execFileSync('git', ['--git-dir', join(S, 'origin-c.git'), 'rev-parse', 'refs/pull/1/head'], { encoding: 'utf8' }).trim()
console.log('$ git --git-dir origin-c.git rev-parse refs/pull/1/head →', pullHead)
console.log('scratch-c branches before:', JSON.stringify(git(C, 'branch', '--format=%(refname:short)')))
const { page, close } = await start([C, GH])
try {
  console.log('account:', JSON.stringify(await page.evaluate(() => window.github.getAccount?.())))
  await openRepo(page, 'scratch-c')
  const result = await page.evaluate((folder) => window.git.checkoutPullRequest(folder, { number: 1, uncommitted: 'stash' }), C)
  console.log('window.git.checkoutPullRequest(scratch-c, {number: 1}) →', JSON.stringify({ ok: result.ok, branch: result.value?.branch ?? result.value?.status?.branch, error: result.error }))
  const prOid = git(C, 'rev-parse', 'refs/heads/pr/1')
  console.log('$ git rev-parse pr/1 →', prOid, '| equals refs/pull/1/head:', prOid === pullHead, '| current branch:', git(C, 'branch', '--show-current'))
  console.log('$ git log -1 pr/1 (hash subject) →', git(C, 'log', '-1', '--format=%h %s', 'pr/1'))
  console.log('leftover refs/dm:', JSON.stringify(git(C, 'for-each-ref', 'refs/dm')))
  await page.waitForTimeout(6000)
  console.log('scratch-c toolbar 6 s after the devtools-style call:', (await page.locator('.source-toolbar').innerText()).replace(/\s+/g, ' '))
  await openRepo(page, 'scratch-gh')
  await openRepo(page, 'scratch-c')
  console.log('scratch-c toolbar after reopening:', (await page.locator('.source-toolbar').innerText()).replace(/\s+/g, ' '))
  await shot(page, 'c3-scratch-c-on-pr-1')

  const prs = await page.evaluate((folder) => window.git.getPullRequests(folder), GH)
  console.log('signed out: window.git.getPullRequests(scratch-gh) →', JSON.stringify(prs))

  await openRepo(page, 'scratch-gh')
  console.log('toolbar:', (await page.locator('.source-toolbar').innerText()).replace(/\s+/g, ' '))
  await page.getByRole('button', { name: /Current branch/ }).click()
  await page.getByRole('button', { name: 'Pull requests', exact: true }).click()
  await page.getByText('Sign in to GitHub to see pull requests').waitFor({ timeout: 30000 })
  await shot(page, 'c4-pull-requests-signed-out')
} catch (error) {
  await shot(page, 'c3c4out-error')
  throw error
} finally {
  await close()
}
