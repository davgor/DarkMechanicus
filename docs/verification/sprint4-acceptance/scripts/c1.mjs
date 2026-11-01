// c1: Commit clicked while a conflicting pull runs (origin served through slow-upload-pack.sh) waits for the pull,
// then is refused; MERGE_HEAD still verifies afterwards.
// The pull leaves a merge in progress, so the Changes panel swaps the commit box for the merge banner and the commit
// box's own alert unmounts before it can render. To show the app's refusal message anyway, the script wraps the
// main-process `git:pull` and `git:commit` IPC handlers with pass-through observers that record start/end times and
// the answer each handler returned (behaviour unchanged: same arguments, same result, same thrown error).
import { join } from 'node:path'
import { S, git, gitRun, start, openRepo, shot, uptime } from './lib.mjs'

const P = join(S, 'scratch-pull')
console.log(uptime())
console.log('before: $ git status -sb\n' + git(P, 'status', '-sb'))
console.log('before: $ git rev-parse -q --verify MERGE_HEAD ->', JSON.stringify(gitRun(P, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')))
const { app, page, close } = await start([P], { env: { SLOW_SECONDS: '10' } })

async function observe() {
  await app.evaluate(({ ipcMain }) => {
    globalThis.__dm400 = []
    for (const channel of ['git:pull', 'git:commit']) {
      const original = ipcMain._invokeHandlers.get(channel)
      if (typeof original !== 'function') throw new Error(`no handler for ${channel}`)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        const entry = { channel, startedAt: Date.now() }
        globalThis.__dm400.push(entry)
        try {
          const result = await original(...args)
          Object.assign(entry, { endedAt: Date.now(), result })
          return result
        } catch (error) {
          Object.assign(entry, { endedAt: Date.now(), thrown: String(error?.message ?? error) })
          throw error
        }
      })
    }
  })
}

try {
  await openRepo(page, 'scratch-pull')
  await observe()
  const sync = page.getByTestId('sync-primary')
  await page.waitForFunction(() => /Pull origin/.test(document.querySelector('[data-testid="sync-primary"]')?.textContent ?? ''), null, { timeout: 60000 })
  await page.getByRole('progressbar').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {})
  console.log('sync button:', JSON.stringify(await sync.innerText()))
  await page.getByLabel('Summary').fill('Commit during pull')
  const commit = page.getByRole('button', { name: /^Commit to main/ })
  console.log('included files:', JSON.stringify(await page.locator('input[aria-label^="Include "]:checked').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))))
  const t0 = Date.now()
  const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`
  await sync.click()
  const pulling = page.getByRole('progressbar', { name: 'Pulling progress' })
  await pulling.waitFor({ timeout: 10000 })
  console.log(at(), 'pull running:', JSON.stringify(await page.locator('.sync-progress').innerText()))
  await commit.click()
  console.log(at(), 'Commit clicked; commit button aria-busy =', await commit.getAttribute('aria-busy'))
  await page.waitForTimeout(2000)
  console.log(at(), 'pull still running:', await pulling.count() === 1, '| commit button aria-busy =', await commit.getAttribute('aria-busy'))
  await shot(page, 'c1-commit-waiting-during-pull')
  await pulling.waitFor({ state: 'detached', timeout: 120000 })
  console.log(at(), 'pull progress gone')
  await page.getByRole('region', { name: 'Merge in progress' }).or(page.getByText(/1 conflicted file/)).first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(1500)
  await shot(page, 'c1-after-pull-merge-banner')
  const log = await app.evaluate(() => globalThis.__dm400)
  const rel = (ms) => (ms === undefined ? 'unfinished' : `+${((ms - t0) / 1000).toFixed(1)}s`)
  for (const entry of log) {
    console.log(`${entry.channel}: started ${rel(entry.startedAt)}, answered ${rel(entry.endedAt)} ->`, JSON.stringify(entry.result ?? { thrown: entry.thrown }))
  }
  const pull = log.find((e) => e.channel === 'git:pull')
  const commitCall = log.find((e) => e.channel === 'git:commit')
  console.log('commit answered after the pull:', commitCall.endedAt >= pull.endedAt, `(commit waited ${((commitCall.endedAt - commitCall.startedAt) / 1000).toFixed(1)}s; pull took ${((pull.endedAt - pull.startedAt) / 1000).toFixed(1)}s)`)
  console.log('after: $ git rev-parse -q --verify MERGE_HEAD ->', JSON.stringify(gitRun(P, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')))
  console.log('after: $ git status\n' + git(P, 'status'))
  console.log('after: $ git log --oneline -3\n' + git(P, 'log', '--oneline', '-3'))
} catch (error) {
  await shot(page, 'c1-error')
  throw error
} finally {
  await close()
}
console.log(uptime())
