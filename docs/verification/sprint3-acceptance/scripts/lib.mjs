import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from '/tmp/sc-epic/pw/shot.mjs'

export const WT = '/Users/davidgorden/Documents/GitHub/DarkMechanicus-worktrees/source-control-sprint-3'
export const S = '/private/tmp/sc-epic/scratch/DM-149'
export const OUT = '/tmp/sc-epic/shots'

// Signed-out GitHub: gh points at an empty config and no token env reaches the app.
const GH_EMPTY = join(S, 'gh-empty')
mkdirSync(GH_EMPTY, { recursive: true })
export const SIGNED_OUT_ENV = { GH_CONFIG_DIR: GH_EMPTY, GH_TOKEN: '', GITHUB_TOKEN: '' }

export function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).replace(/\s+$/, '')
}

export function uptime() {
  return execFileSync('uptime', { encoding: 'utf8' }).trim()
}

/** Launches the built app with a fresh profile tracking `folders`, the clone parent preset to `cloneParent`. */
export async function start(folders, { cloneParent, env = SIGNED_OUT_ENV } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'dm-149-'))
  const entries = folders.map((path) => ({ path, addedAt: new Date().toISOString() }))
  writeFileSync(join(profile, 'folders.json'), JSON.stringify({ version: 1, folders: entries }))
  if (cloneParent) writeFileSync(join(profile, 'clone.json'), JSON.stringify({ version: 1, parent: cloneParent }))
  const session = await launch({ worktree: WT, userDataDir: profile, env })
  console.log('userData:', await session.app.evaluate(({ app }) => app.getPath('userData')))
  await session.page.setViewportSize?.({ width: 1280, height: 800 })
  const close = async () => { await session.close(); rmSync(profile, { recursive: true, force: true }) }
  return { ...session, close }
}

export async function openRepo(page, name) {
  await page.getByText(name, { exact: true }).first().click()
  await page.getByRole('tab', { name: /Source control/i }).or(page.getByRole('button', { name: /Source control/i })).first().click()
  await page.getByTestId('sync-primary').waitFor({ timeout: 30000 })
  await page.waitForTimeout(1500)
}

export async function shot(page, name) {
  await page.waitForTimeout(400)
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(OUT, `DM-149-${name}.png`) })
  console.log('shot:', `DM-149-${name}.png`)
}
