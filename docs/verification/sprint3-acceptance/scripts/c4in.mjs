// c4 (signed-in half): Push and create pull request on scratch-gh's unpublished branch. Uses this machine's gh login in
// an isolated profile; never prints the token; signs out at the end. Push is NOT clicked (pushurl is a local bare anyway).
import { join } from 'node:path'
import { S, git, start, openRepo, shot } from './lib.mjs'

delete process.env.GH_TOKEN
delete process.env.GITHUB_TOKEN
const GH = join(S, 'scratch-gh')
console.log('scratch-gh: branch', git(GH, 'branch', '--show-current'), '| upstream:', git(GH, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/feature-unpublished') || '(none)', '| pushurl:', git(GH, 'config', 'remote.origin.pushurl'))
const { page, close } = await start([GH], { env: { GH_TOKEN: '', GITHUB_TOKEN: '' } })
try {
  await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).first().click()
  await page.getByRole('button', { name: 'Use my GitHub CLI login' }).click()
  await page.getByRole('dialog', { name: 'Sign in to GitHub' }).waitFor({ state: 'detached', timeout: 30000 })
  const account = await page.evaluate(() => window.github.getAccount())
  console.log('signed in as:', account.ok ? account.data?.login : JSON.stringify(account.error))
  await openRepo(page, 'scratch-gh')
  await page.getByRole('button', { name: 'Push and create pull request' }).waitFor({ timeout: 30000 })
  console.log('toolbar (unpublished branch):', (await page.locator('.source-toolbar').innerText()).replace(/\s+/g, ' '))
  await shot(page, 'c4-push-and-create-pull-request')
} catch (error) {
  await shot(page, 'c4in-error')
  throw error
} finally {
  const out = await page.evaluate(() => window.github.signOut())
  console.log('signed out:', JSON.stringify(out), '| account now:', JSON.stringify(await page.evaluate(() => window.github.getAccount())))
  await close()
  console.log('push-sink refs after run:', JSON.stringify(git(join(S, 'push-sink.git'), 'for-each-ref')))
}
