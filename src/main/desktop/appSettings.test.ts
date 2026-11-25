import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../../core/db/database'
import { DomainError } from '../../core/errors'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings
} from '../../shared/desktop/notificationSettings'
import { openAppDatabase } from './appDatabase'
import { createAppSettings } from './appSettings'

const tempDirs: string[] = []
const openDbs: Db[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dm-appsettings-test-'))
  tempDirs.push(dir)
  return dir
}

function open(dir: string): Db {
  const db = openAppDatabase(dir)
  openDbs.push(db)
  return db
}

function rig(options: { dir?: string; confirm?: boolean; stored?: string } = {}) {
  const dir = options.dir ?? tempDir()
  const db = open(dir)
  if (options.stored !== undefined) {
    db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', 'notificationSettings', options.stored)
  }
  const confirm = vi.fn(async (_summary: string) => options.confirm ?? true)
  const logger = { warn: vi.fn() }
  const settings = createAppSettings({ db, confirm, logger })
  const stored = () => db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', 'notificationSettings')?.value
  return { dir, db, confirm, logger, settings, stored }
}

/** The defaults with `patch` applied to the arbitration block (and, optionally, the rest). */
function settingsWith(
  arbitration: Partial<NotificationSettings['arbitration']>,
  rest: Partial<Omit<NotificationSettings, 'arbitration'>> = {}
): NotificationSettings {
  const base = structuredClone(DEFAULT_NOTIFICATION_SETTINGS)
  return { ...base, ...rest, arbitration: { ...base.arbitration, ...arbitration } }
}

/** A restrictive stored value: arbitration off, two always-ask entries, some notes, one event off. */
const RESTRICTIVE = settingsWith(
  { enabled: false, alwaysAsk: ['bash:rm', 'git.push'], autoHandleNotes: 'Never approve deploys.' },
  { events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, run_stalled: false }, whenFocused: 'notify', sound: false }
)

async function codeOf(action: Promise<unknown>): Promise<string> {
  const error = await action.then(() => undefined, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(DomainError)
  return (error as DomainError).code
}

describe('app settings: reading', () => {
  it('gives the defaults when nothing is stored, without a warning', () => {
    const { settings, logger } = rig()
    expect(settings.notifications()).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(settings.notifications()).toEqual({
      version: 1,
      events: { approval_needed: true, question: true, checkpoint_ready: true, run_failed: true, run_stalled: true },
      sound: true,
      whenFocused: 'skip',
      arbitration: { enabled: true, alwaysAsk: [], autoHandleNotes: '' }
    })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('gives the defaults for corrupt JSON, logged once and never thrown', () => {
    const { settings, logger } = rig({ stored: '{"version":1,"events":' })
    expect(settings.notifications()).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(settings.notifications()).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('gives the defaults for JSON that is not an object', () => {
    for (const stored of ['null', '[1,2]', '"text"', '42']) {
      const { settings, logger } = rig({ stored })
      expect(settings.notifications(), stored).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
      expect(logger.warn, stored).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps the always-ask list and other valid parts of a value missing one event key', () => {
    const { checkpoint_ready: _dropped, ...events } = RESTRICTIVE.events
    const { settings, logger } = rig({ stored: JSON.stringify({ ...RESTRICTIVE, events }) })
    expect(settings.notifications()).toEqual({
      ...RESTRICTIVE,
      events: { ...RESTRICTIVE.events, checkpoint_ready: true }
    })
    expect(settings.notifications().arbitration).toEqual(RESTRICTIVE.arbitration)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('keeps a valid arbitration block next to an unknown event key (a later version) and other invalid parts', () => {
    const stored = { ...RESTRICTIVE, version: 2, events: { ...RESTRICTIVE.events, browser_site: true }, sound: 'loud' }
    const { settings } = rig({ stored: JSON.stringify(stored) })
    expect(settings.notifications()).toEqual({ ...RESTRICTIVE, version: 1, sound: true })
  })

  it('reads an unparsable arbitration block as arbitration off, keeping the valid always-ask entries', () => {
    const stored = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      arbitration: { enabled: 'yes', alwaysAsk: ['bash:rm', 'bad entry!', 7, 'git.push'], autoHandleNotes: 'Keep.', extra: 1 }
    }
    const { settings, logger } = rig({ stored: JSON.stringify(stored) })
    expect(settings.notifications().arbitration).toEqual({
      enabled: false,
      alwaysAsk: ['bash:rm', 'git.push'],
      autoHandleNotes: 'Keep.'
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('reads a missing or non-object arbitration block as arbitration off, never the looser default', () => {
    for (const arbitration of [undefined, null, 'on', ['bash:rm']]) {
      const { settings } = rig({ stored: JSON.stringify({ ...DEFAULT_NOTIFICATION_SETTINGS, arbitration }) })
      expect(settings.notifications().arbitration, String(arbitration)).toEqual({
        enabled: false,
        alwaysAsk: [],
        autoHandleNotes: ''
      })
    }
  })

  it('caches the value: a later database write is not read until a save', () => {
    const { settings, db } = rig({ stored: JSON.stringify(RESTRICTIVE) })
    expect(settings.notifications()).toEqual(RESTRICTIVE)
    db.run('UPDATE app_meta SET value = ? WHERE key = ?', JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS), 'notificationSettings')
    expect(settings.notifications()).toEqual(RESTRICTIVE)
  })

  it('hands out a frozen value that no consumer can change in place', () => {
    const { settings } = rig()
    const value = settings.notifications()
    expect(() => {
      value.arbitration.alwaysAsk.push('bash:rm')
    }).toThrow(TypeError)
    expect(DEFAULT_NOTIFICATION_SETTINGS.arbitration.alwaysAsk).toEqual([])
  })
})

describe('app settings: saving', () => {
  it('round-trips a save and keeps it after the database is reopened', async () => {
    const first = rig({ stored: JSON.stringify(RESTRICTIVE) })
    const next = settingsWith(
      { ...RESTRICTIVE.arbitration, alwaysAsk: [...RESTRICTIVE.arbitration.alwaysAsk, 'npm:publish'] },
      { events: RESTRICTIVE.events, whenFocused: RESTRICTIVE.whenFocused, sound: true }
    )
    const saved = await first.settings.setNotifications(next)
    expect(saved).toEqual(next)
    expect(first.settings.notifications()).toEqual(next)
    expect(JSON.parse(first.stored() ?? '')).toEqual(next)
    first.db.close()
    openDbs.splice(openDbs.indexOf(first.db), 1)

    const reopened = rig({ dir: first.dir })
    expect(reopened.settings.notifications()).toEqual(next)
    expect(reopened.logger.warn).not.toHaveBeenCalled()
  })

  it('calls onChange after a save with the saved value, and not after unsubscribing', async () => {
    const { settings } = rig()
    const seen: NotificationSettings[] = []
    const off = settings.onChange((value) => seen.push(value))
    const quiet = settingsWith({}, { sound: false })
    await settings.setNotifications(quiet)
    expect(seen).toEqual([quiet])
    off()
    await settings.setNotifications(settingsWith({}, { sound: true }))
    expect(seen).toHaveLength(1)
  })

  it('trims always-ask entries as the schema does', async () => {
    const { settings } = rig()
    await settings.setNotifications(settingsWith({ alwaysAsk: ['  bash:rm  '] }))
    expect(settings.notifications().arbitration.alwaysAsk).toEqual(['bash:rm'])
  })
})

describe('app settings: loosening needs the native confirmation', () => {
  const loosenings: Array<[string, NotificationSettings]> = [
    ['arbitration turned on', { ...RESTRICTIVE, arbitration: { ...RESTRICTIVE.arbitration, enabled: true } }],
    ['an always-ask entry removed', { ...RESTRICTIVE, arbitration: { ...RESTRICTIVE.arbitration, alwaysAsk: ['git.push'] } }],
    ['the auto-handle notes changed', { ...RESTRICTIVE, arbitration: { ...RESTRICTIVE.arbitration, autoHandleNotes: 'Approve anything.' } }],
    ['the auto-handle notes cleared', { ...RESTRICTIVE, arbitration: { ...RESTRICTIVE.arbitration, autoHandleNotes: '' } }]
  ]

  it.each(loosenings)('%s asks confirm and saves on a yes', async (_name, next) => {
    const { settings, confirm, stored } = rig({ stored: JSON.stringify(RESTRICTIVE), confirm: true })
    await expect(settings.setNotifications(next)).resolves.toEqual(next)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).not.toBe('')
    expect(settings.notifications()).toEqual(next)
    expect(JSON.parse(stored() ?? '')).toEqual(next)
  })

  it.each(loosenings)('%s declined throws cancelled and changes nothing', async (_name, next) => {
    const { settings, confirm, stored } = rig({ stored: JSON.stringify(RESTRICTIVE), confirm: false })
    const listener = vi.fn()
    settings.onChange(listener)
    const before = stored()
    const error = await settings.setNotifications(next).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code: 'cancelled', message: 'The change was not confirmed.' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(settings.notifications()).toEqual(RESTRICTIVE)
    expect(stored()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('names every loosening change in one confirmation', async () => {
    const { settings, confirm } = rig({ stored: JSON.stringify(RESTRICTIVE) })
    await settings.setNotifications({ ...RESTRICTIVE, arbitration: { enabled: true, alwaysAsk: [], autoHandleNotes: '' } })
    expect(confirm).toHaveBeenCalledTimes(1)
    const summary = confirm.mock.calls[0][0]
    expect(summary).toContain('Magos arbiter')
    expect(summary).toContain('bash:rm, git.push')
    expect(summary).toContain('notes')
  })

  it('compares against the stored value, not the defaults: loosening from corrupt-arbitration-off asks', async () => {
    const stored = { ...DEFAULT_NOTIFICATION_SETTINGS, arbitration: { enabled: 'yes', alwaysAsk: ['bash:rm'] } }
    const { settings, confirm } = rig({ stored: JSON.stringify(stored), confirm: false })
    expect(await codeOf(settings.setNotifications(settingsWith({ enabled: true, alwaysAsk: ['bash:rm'] })))).toBe('cancelled')
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})

describe('app settings: tightening saves without a confirmation', () => {
  const tightenings: Array<[string, NotificationSettings]> = [
    ['arbitration turned off', settingsWith({ enabled: false })],
    ['an always-ask entry added', settingsWith({ alwaysAsk: ['bash:rm'] })],
    ['events, sound and focus changed', settingsWith({}, {
      events: { approval_needed: false, question: false, checkpoint_ready: false, run_failed: false, run_stalled: false },
      sound: false,
      whenFocused: 'notify'
    })],
    ['the same value saved again', settingsWith({})]
  ]

  it.each(tightenings)('%s never calls confirm', async (_name, next) => {
    const { settings, confirm } = rig({ confirm: false })
    await expect(settings.setNotifications(next)).resolves.toEqual(next)
    expect(settings.notifications()).toEqual(next)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('reordering the always-ask list removes nothing and never confirms', async () => {
    const { settings, confirm } = rig({ stored: JSON.stringify(RESTRICTIVE), confirm: false })
    const reordered = { ...RESTRICTIVE, arbitration: { ...RESTRICTIVE.arbitration, alwaysAsk: ['git.push', 'bash:rm'] } }
    await expect(settings.setNotifications(reordered)).resolves.toEqual(reordered)
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('app settings: invalid shapes', () => {
  const invalid: Array<[string, unknown]> = [
    ['an extra top-level key', { ...DEFAULT_NOTIFICATION_SETTINGS, extra: true }],
    ['an extra event key', { ...DEFAULT_NOTIFICATION_SETTINGS, events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, browser_site: true } }],
    ['an extra arbitration key', { ...DEFAULT_NOTIFICATION_SETTINGS, arbitration: { ...DEFAULT_NOTIFICATION_SETTINGS.arbitration, trusted: true } }],
    ['51 always-ask entries', settingsWith({ alwaysAsk: Array.from({ length: 51 }, (_, i) => `tool.${i}`) })],
    ['notes of 4,001 characters', settingsWith({ autoHandleNotes: 'x'.repeat(4001) })],
    ['an always-ask entry with a space', settingsWith({ alwaysAsk: ['rm -rf'] })],
    ['an empty always-ask entry', settingsWith({ alwaysAsk: ['   '] })],
    ['an always-ask entry of 101 characters', settingsWith({ alwaysAsk: ['a'.repeat(101)] })],
    ['version 2', { ...DEFAULT_NOTIFICATION_SETTINGS, version: 2 }],
    ['an unknown whenFocused', { ...DEFAULT_NOTIFICATION_SETTINGS, whenFocused: 'always' }],
    ['a missing event', { ...DEFAULT_NOTIFICATION_SETTINGS, events: { approval_needed: true } }],
    ['null', null],
    ['a string', 'arbitration off']
  ]

  it.each(invalid)('%s is invalid_input, never confirmed, and changes nothing', async (_name, next) => {
    const { settings, confirm, stored } = rig({ stored: JSON.stringify(RESTRICTIVE) })
    expect(await codeOf(settings.setNotifications(next))).toBe('invalid_input')
    expect(confirm).not.toHaveBeenCalled()
    expect(settings.notifications()).toEqual(RESTRICTIVE)
    expect(JSON.parse(stored() ?? '')).toEqual(RESTRICTIVE)
  })

  it('accepts exactly 50 always-ask entries and notes of 4,000 characters', async () => {
    const { settings } = rig()
    const next = settingsWith({ alwaysAsk: Array.from({ length: 50 }, (_, i) => `tool.${i}`), autoHandleNotes: 'x'.repeat(4000) })
    await expect(settings.setNotifications(next)).resolves.toEqual(next)
  })
})

describe('app settings: saves run one at a time', () => {
  it('a tightening sent while a loosening waits for the person is compared with the outcome', async () => {
    const { settings, confirm } = rig({ stored: JSON.stringify(RESTRICTIVE) })
    // The node tsconfig lib predates Promise.withResolvers, so the person's pending answer is held by the executor.
    let answer: (yes: boolean) => void = () => {}
    confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const loosened = { ...RESTRICTIVE, arbitration: { ...RESTRICTIVE.arbitration, enabled: true } }
    const first = settings.setNotifications(loosened)
    const second = settings.setNotifications({ ...loosened, sound: true })
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    answer(false)
    expect(await codeOf(first)).toBe('cancelled')
    // The second save still turns arbitration on relative to the unchanged value, so it asks again.
    await expect(second).resolves.toEqual({ ...loosened, sound: true })
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})
