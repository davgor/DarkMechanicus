import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refuseRenames, refuseUntilLocked, releaseRenames, renamesAsked } from '../../test/busyRename'
import { scratchDir } from '../../test/gitScratch'
import { bindForge, forgeBindingFile, withForgeTransfer } from './forgeBinding'
import { RENAME_PAUSES_MS, type RenameRetryNote } from './forgeManifest'
import { projectKey } from './storageMode'

// vi.mock factories run before the file's static imports, so the helper is loaded from inside the factory.
vi.mock('node:fs', async original => (await import('../../test/busyRename')).withBusyRename(await original()))

let scratch: ReturnType<typeof scratchDir>
let home: string
let source: string
let member: string
let checkoutHint: string
const onRetry = vi.fn<RenameRetryNote>()

beforeEach(() => {
  onRetry.mockReset()
  scratch = scratchDir('forge-binding-')
  home = join(scratch.path, 'home')
  source = join(scratch.path, 'code')
  member = join(scratch.path, 'world', 'code')
  checkoutHint = join(member, '.darkmechanicus', 'local', 'source-checkout.json')
  mkdirSync(source)
  mkdirSync(join(member, '.darkmechanicus', 'local'), { recursive: true })
})

afterEach(() => {
  releaseRenames()
  scratch.cleanup()
})

describe('bindForge with a busy rename', () => {
  it.each([
    ['the binding', ['EPERM'], () => forgeBindingFile(home, source)],
    ['the checkout hint', ['', 'EPERM'], () => checkoutHint]
  ])('asks again after one busy refusal onto %s and binds within 300 ms', (_target, codes, target) => {
    refuseRenames(...codes)
    const started = performance.now()
    bindForge(home, source, { member, note: 'pointer', onRetry })
    expect(performance.now() - started).toBeLessThan(300)
    expect(renamesAsked()).toBe(3)
    expect(onRetry.mock.calls).toEqual([['EPERM', target()]])
    expect(JSON.parse(readFileSync(forgeBindingFile(home, source), 'utf8')).member).toBe(member)
    expect(JSON.parse(readFileSync(checkoutHint, 'utf8'))).toEqual({ checkout: source })
  })

  it('throws that the binding stayed locked after the bound and leaves it unchanged', () => {
    bindForge(home, source, { member, note: 'pointer' })
    const before = readFileSync(forgeBindingFile(home, source), 'utf8')
    const codes = refuseUntilLocked(RENAME_PAUSES_MS.length + 1)
    expect(() => bindForge(home, source, { member: join(scratch.path, 'elsewhere'), note: 'pointer', onRetry })).toThrow(/stayed locked for 2550 ms \(EPERM: rename refused\)/)
    expect(renamesAsked()).toBe(codes.length)
    const file = forgeBindingFile(home, source)
    expect(onRetry.mock.calls).toEqual(codes.slice(0, -1).map((code) => [code, file]))
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('throws any other error at once without asking again', () => {
    bindForge(home, source, { member, note: 'pointer' })
    const before = readFileSync(forgeBindingFile(home, source), 'utf8')
    refuseRenames('ENOENT')
    expect(() => bindForge(home, source, { member, note: 'pointer', onRetry })).toThrow('ENOENT: rename refused')
    expect(renamesAsked()).toBe(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(readFileSync(forgeBindingFile(home, source), 'utf8')).toBe(before)
  })
})

describe('withForgeTransfer advancing over a busy rename', () => {
  const moveFile = (): string => join(home, 'forge-bindings', projectKey(source) + '.move.json')
  const phase = (): number => JSON.parse(readFileSync(moveFile(), 'utf8')).phase

  it('asks again after one busy refusal and records the phase within 300 ms', async () => {
    await withForgeTransfer(home, source, { target: member, force: false, onRetry }, async (_phase, advance) => {
      refuseRenames('EBUSY')
      const started = performance.now()
      advance(2)
      expect(performance.now() - started).toBeLessThan(300)
      expect(renamesAsked()).toBe(2)
      expect(phase()).toBe(2)
    })
    expect(onRetry.mock.calls).toEqual([['EBUSY', moveFile()]])
  })

  it('throws that the move record stayed locked after the bound and keeps the recorded phase', async () => {
    let codes: string[] = []
    await withForgeTransfer(home, source, { target: member, force: false, onRetry }, async (_phase, advance) => {
      codes = refuseUntilLocked(RENAME_PAUSES_MS.length + 1)
      expect(() => advance(2)).toThrow('stayed locked for 2550 ms')
      expect(renamesAsked()).toBe(codes.length)
      expect(phase()).toBe(0)
    })
    expect(onRetry.mock.calls).toEqual(codes.slice(0, -1).map((code) => [code, moveFile()]))
  })

  it('throws any other error at once without asking again', async () => {
    await withForgeTransfer(home, source, { target: member, force: false, onRetry }, async (_phase, advance) => {
      refuseRenames('ENOENT')
      expect(() => advance(2)).toThrow('ENOENT: rename refused')
      expect(renamesAsked()).toBe(1)
      expect(phase()).toBe(0)
    })
    expect(onRetry).not.toHaveBeenCalled()
    expect(readdirSync(join(home, 'forge-bindings')).filter(name => name.endsWith('.move.json'))).toEqual([])
  })
})
