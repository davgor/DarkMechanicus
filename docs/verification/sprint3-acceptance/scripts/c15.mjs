// c15: Fetch origin against an ext:: helper that prints nothing ends after ~60 s with the timeout message and git's detail;
// the button returns to Fetch origin.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { S, git, start, openRepo, shot, uptime } from './lib.mjs'

const NAME = process.argv[2] ?? 'scratch-stall'
const TAG = NAME === 'scratch-stall' ? 'c15' : 'c15-variant'
const T = join(S, NAME)
const helpers = () => { try { return execFileSync('pgrep', ['-f', `${S}/stall2?.sh|sleep 300`], { encoding: 'utf8' }).trim().split('\n').length } catch { return 0 } }
console.log('uptime before:', uptime())
console.log('origin:', git(T, 'remote', 'get-url', 'origin'), '| stall.sh:', execFileSync('cat', [join(S, NAME === 'scratch-stall' ? 'stall.sh' : 'stall2.sh')], { encoding: 'utf8' }).trim().replace(/\n/g, ' ⏎ '))
const { page, close } = await start([T])
try {
  await openRepo(page, NAME)
  const primary = page.getByTestId('sync-primary')
  console.log('button before:', (await primary.innerText()).replace(/\s+/g, ' '))
  const t0 = Date.now()
  await primary.click()
  await page.waitForTimeout(3000)
  console.log('button while fetching (3 s):', (await primary.innerText()).replace(/\s+/g, ' '), '| helper processes:', helpers())
  await shot(page, `${TAG}-fetching`)
  const message = page.getByText(/The connection stalled/).first()
  await message.waitFor({ timeout: 150000 })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  await page.waitForTimeout(1000)
  console.log(`timeout shown after ${secs} s (from the click)`)
  const alert = page.locator('[role=alert], [role=status]').filter({ hasText: /stalled/ })
  console.log('message:', JSON.stringify(await alert.allInnerTexts()))
  const details = page.locator('details').filter({ has: page.locator('.sync-detail') })
  if (await details.count()) { await details.locator('summary').click(); console.log('detail block:', JSON.stringify(await details.innerText())) } else console.log('detail block: none (git wrote no stderr)')
  console.log('button after:', (await primary.innerText()).replace(/\s+/g, ' '))
  await shot(page, `${TAG}-stall-timeout`)
  await page.waitForTimeout(2000)
  console.log('helper processes 3 s after the timeout:', helpers())
} catch (error) {
  await shot(page, `${TAG}-error`)
  throw error
} finally {
  await close()
  console.log('uptime after:', uptime())
}
