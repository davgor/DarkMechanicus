// c1: owner/repo shorthand clone with progress; a larger clone cancelled part-way leaves no folder; ext:: refused before git runs.
// c2: sidebar + menu → Clone repository… → URL clone ends tracked, selected and open on Source control.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { S, git, start, shot, uptime } from './lib.mjs'

const P = join(S, 'clones')
const EXT_MARK = join(S, 'ext-ran')
console.log('uptime:', uptime())
const { page, app, close } = await start([], { cloneParent: P })
const progressOf = () => page.evaluate(() => window.__progress)
const dialog = () => page.getByRole('dialog', { name: 'Clone a repository' })
try {
  await page.evaluate(() => { window.__progress = []; window.git.onProgress((e) => window.__progress.push(e)) })

  // c1a: owner/repo shorthand from the welcome view's Clone repository button
  await page.getByRole('button', { name: 'Clone repository' }).click()
  await page.getByRole('tab', { name: 'URL' }).click()
  await page.getByLabel('Repository URL or owner/repo').fill('octocat/Hello-World')
  await page.getByLabel('Name').fill('hello-short')
  await shot(page, 'c1-shorthand-dialog')
  await page.getByRole('button', { name: 'Clone', exact: true }).click()
  await dialog().waitFor({ state: 'detached', timeout: 120000 })
  const events = await progressOf()
  console.log('c1 progress events:', events.length, 'phases:', [...new Set(events.map((e) => e.phase ?? e.stage ?? e.message))].slice(0, 8).join(' | '))
  console.log('c1 sample events:', JSON.stringify(events.slice(-3)))
  console.log('c1 hello-short origin:', git(join(P, 'hello-short'), 'remote', 'get-url', 'origin'), '| HEAD:', git(join(P, 'hello-short'), 'log', '-1', '--format=%h %s'))
  await page.getByTestId('sync-primary').waitFor({ timeout: 30000 })
  await shot(page, 'c1-shorthand-cloned')

  // c1b: a larger clone (git/git) cancelled part-way removes its half-made folder
  await page.evaluate(() => { window.__progress = [] })
  await page.getByRole('button', { name: 'Add a folder' }).click()
  await page.getByRole('menuitem', { name: 'Clone repository…' }).click()
  await page.getByRole('tab', { name: 'URL' }).click()
  await page.getByLabel('Repository URL or owner/repo').fill('git/git')
  await page.getByLabel('Name').fill('git-big')
  await page.getByRole('button', { name: 'Clone', exact: true }).click()
  await page.locator('.clone-progress-text').filter({ hasText: /\d+%/ }).waitFor({ timeout: 120000 })
  await page.waitForTimeout(2000)
  console.log('c1 big clone progress text:', await page.locator('.clone-progress-text').textContent(), '| folder exists mid-clone:', existsSync(join(P, 'git-big')))
  await shot(page, 'c1-big-clone-in-progress')
  await page.getByRole('button', { name: 'Cancel clone' }).click()
  await page.locator('.clone-progress').waitFor({ state: 'detached', timeout: 60000 })
  await page.waitForTimeout(2000)
  console.log('c1 after cancel: git-big exists:', existsSync(join(P, 'git-big')), '| clone parent now holds:', JSON.stringify(readdirSync(P)))
  await shot(page, 'c1-big-clone-cancelled')

  // c1c: ext:: refused before git runs (the helper would create EXT_MARK)
  await page.getByLabel('Repository URL or owner/repo').fill(`ext::sh -c touch% ${EXT_MARK}`)
  await page.getByLabel('Name').fill('ext-clone')
  const cloneButton = page.getByRole('button', { name: 'Clone', exact: true })
  console.log('c1 Clone button enabled for ext:: URL:', await cloneButton.isEnabled())
  if (await cloneButton.isEnabled()) await cloneButton.click()
  await page.waitForTimeout(1500)
  console.log('c1 ext:: dialog alert:', JSON.stringify(await dialog().getByRole('alert').allInnerTexts()))
  await shot(page, 'c1-ext-refused')
  const direct = await page.evaluate((mark) => window.git.clone({ url: `ext::sh -c touch% ${mark}`, name: 'ext-direct', operationId: 'ext-direct' }), EXT_MARK)
  console.log('c1 window.git.clone(ext::) →', JSON.stringify(direct))
  console.log('c1 ext marker created (git ran):', existsSync(EXT_MARK), '| ext-clone/ext-direct folders:', existsSync(join(P, 'ext-clone')), existsSync(join(P, 'ext-direct')))
  await dialog().getByRole('button', { name: 'Close', exact: true }).click()
  await dialog().waitFor({ state: 'detached', timeout: 10000 })

  // c2: sidebar + menu → Clone repository… → URL tab, full URL
  await page.getByRole('button', { name: 'Add a folder' }).click()
  await shot(page, 'c2-sidebar-plus-menu')
  await page.getByRole('menuitem', { name: 'Clone repository…' }).click()
  await page.getByRole('tab', { name: 'URL' }).click()
  await page.getByLabel('Repository URL or owner/repo').fill('https://github.com/octocat/Hello-World.git')
  await page.getByLabel('Name').fill('hello-url')
  await shot(page, 'c2-clone-dialog-url')
  await page.getByRole('button', { name: 'Clone', exact: true }).click()
  await page.waitForTimeout(300)
  await shot(page, 'c2-clone-dialog-running')
  await dialog().waitFor({ state: 'detached', timeout: 120000 })
  await page.getByTestId('sync-primary').waitFor({ timeout: 30000 })
  await page.waitForTimeout(1500)
  await shot(page, 'c2-cloned-open-on-source-control')
  const profile = await app.evaluate(({ app: a }) => a.getPath('userData'))
  const tracked = JSON.parse(readFileSync(join(profile, 'folders.json'), 'utf8')).folders.map((f) => f.path)
  console.log('c2 folders.json:', JSON.stringify(tracked))
  console.log('c2 selected sidebar item:', JSON.stringify(await page.locator('[aria-current="true"], [aria-current="page"], [aria-selected="true"]').allInnerTexts()))
  console.log('c2 active tab:', JSON.stringify(await page.locator('[role=tab][aria-selected="true"]').allInnerTexts()))
  console.log('c2 hello-url HEAD:', git(join(P, 'hello-url'), 'log', '-1', '--format=%h %s'))
} catch (error) {
  await shot(page, 'c1c2-error')
  throw error
} finally {
  await close()
  console.log('uptime:', uptime())
}
