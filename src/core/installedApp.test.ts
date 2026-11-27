import { afterEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { readInstalledApp, recordInstalledApp } from './installedApp'
import { META_KEYS, setMeta } from './meta'

let harness: Harness | undefined
afterEach(() => {
  harness?.cleanup()
  harness = undefined
})

async function desktopCtx() {
  harness = createHarness()
  const desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'Observed' })
  return desktop.ctx()
}

it('reads back the observation the desktop recorded on this machine', async () => {
  const ctx = await desktopCtx()
  expect(readInstalledApp(ctx)).toBeNull()
  recordInstalledApp(ctx, { version: '0.88.0', packaged: true })
  expect(readInstalledApp(ctx)).toEqual({ version: '0.88.0', packaged: true, machineId: ctx.machineId, observedAt: ctx.clock.nowIso() })
  recordInstalledApp(ctx, { version: '0.88.1-dev', packaged: false })
  expect(readInstalledApp(ctx)).toMatchObject({ version: '0.88.1-dev', packaged: false })
})

it('ignores an observation from another machine', async () => {
  const ctx = await desktopCtx()
  recordInstalledApp(ctx, { version: '0.88.0', packaged: true })
  expect(readInstalledApp({ db: ctx.db, machineId: 'another-machine' })).toBeNull()
})

it.each([
  ['invalid JSON', '{nope'],
  ['a JSON array', '[]'],
  ['a non-boolean packaged', JSON.stringify({ version: '1', packaged: 'yes', machineId: 'm', observedAt: 't' })],
  ['a missing version', JSON.stringify({ packaged: true, machineId: 'm', observedAt: 't' })]
])('reads %s as no observation', async (_label, raw) => {
  const ctx = await desktopCtx()
  setMeta(ctx.db, META_KEYS.installedApp, raw)
  expect(readInstalledApp(ctx)).toBeNull()
})
