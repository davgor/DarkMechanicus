import { describe, expect, it } from 'vitest'
import type { Workspace } from '../../core/workspace'
import { createWorkspacePool } from './workspacePool'

interface FakeState {
  beats: number
  closes: number
}

/** Paths whose next open / heartbeat / close throws; tests edit these between calls. */
interface Faults {
  open: string[]
  heartbeat: string[]
  close: string[]
}

function createWorld(): {
  faults: Faults
  opened: string[]
  states: Map<string, FakeState>
  errors: { path: string; message: string }[]
  open: (repoRoot: string) => Workspace
  onError: (path: string, error: unknown) => void
} {
  const faults: Faults = { open: [], heartbeat: [], close: [] }
  const opened: string[] = []
  const states = new Map<string, FakeState>()
  const errors: { path: string; message: string }[] = []
  const open = (repoRoot: string): Workspace => {
    opened.push(repoRoot)
    if (faults.open.includes(repoRoot)) {
      throw new Error(`cannot open ${repoRoot}`)
    }
    const state: FakeState = { beats: 0, closes: 0 }
    states.set(repoRoot, state)
    const workspace = {
      repoRoot,
      heartbeat(): void {
        if (faults.heartbeat.includes(repoRoot)) {
          throw new Error(`heartbeat failed for ${repoRoot}`)
        }
        state.beats += 1
      },
      close(): void {
        state.closes += 1
        if (faults.close.includes(repoRoot)) {
          throw new Error(`close failed for ${repoRoot}`)
        }
      }
    }
    return workspace as unknown as Workspace
  }
  const onError = (path: string, error: unknown): void => {
    errors.push({ path, message: error instanceof Error ? error.message : String(error) })
  }
  return { faults, opened, states, errors, open, onError }
}

describe('createWorkspacePool get', () => {
  it('opens lazily and caches one workspace per path', () => {
    const world = createWorld()
    const pool = createWorkspacePool(world.open)
    expect(world.opened).toEqual([])

    const a = pool.get('/repos/a')
    const again = pool.get('/repos/a')
    const b = pool.get('/repos/b')

    expect(again).toBe(a)
    expect(b).not.toBe(a)
    expect(a.repoRoot).toBe('/repos/a')
    expect(b.repoRoot).toBe('/repos/b')
    expect(world.opened).toEqual(['/repos/a', '/repos/b'])
  })

  it('does not cache a failed open, so the next call retries', () => {
    const world = createWorld()
    const pool = createWorkspacePool(world.open)
    world.faults.open.push('/repos/a')

    expect(() => pool.get('/repos/a')).toThrow('cannot open /repos/a')

    world.faults.open.length = 0
    expect(pool.get('/repos/a').repoRoot).toBe('/repos/a')
    expect(world.opened).toEqual(['/repos/a', '/repos/a'])
  })
})

describe('createWorkspacePool heartbeatAll', () => {
  it('marks every open workspace alive and leaves unopened paths alone', () => {
    const world = createWorld()
    const pool = createWorkspacePool(world.open)
    pool.get('/repos/a')
    pool.get('/repos/b')

    pool.heartbeatAll()
    pool.heartbeatAll()

    expect(world.states.get('/repos/a')?.beats).toBe(2)
    expect(world.states.get('/repos/b')?.beats).toBe(2)
    expect(world.states.size).toBe(2)
  })

  it('keeps beating the others when one fails and reports the failure', () => {
    const world = createWorld()
    const pool = createWorkspacePool(world.open, world.onError)
    pool.get('/repos/a')
    pool.get('/repos/b')
    world.faults.heartbeat.push('/repos/a')

    pool.heartbeatAll()

    expect(world.states.get('/repos/b')?.beats).toBe(1)
    expect(world.errors).toEqual([{ path: '/repos/a', message: 'heartbeat failed for /repos/a' }])
  })

  it('swallows failures quietly when no error sink is given', () => {
    const world = createWorld()
    const pool = createWorkspacePool(world.open)
    pool.get('/repos/a')
    world.faults.heartbeat.push('/repos/a')

    expect(() => pool.heartbeatAll()).not.toThrow()
  })
})

describe('createWorkspacePool close', () => {
  it('closes only that workspace and forgets it so the next get reopens', () => {
    const world = createWorld()
    const pool = createWorkspacePool(world.open, world.onError)
    const first = pool.get('/repos/a')
    const firstState = world.states.get('/repos/a')
    pool.get('/repos/b')

    pool.close('/repos/a')

    expect(firstState?.closes).toBe(1)
    expect(world.states.get('/repos/b')?.closes).toBe(0)
    expect(pool.get('/repos/a')).not.toBe(first)
    expect(world.opened).toEqual(['/repos/a', '/repos/b', '/repos/a'])
    expect(world.errors).toEqual([])
  })

  it('does nothing for a path that was never opened', () => {
    const world = createWorld()
    const pool = createWorkspacePool(world.open, world.onError)

    pool.close('/repos/nowhere')

    expect(world.errors).toEqual([])
    expect(world.opened).toEqual([])
  })

  it('reports a failing close but still forgets the workspace', () => {
    const world = createWorld()
    const pool = createWorkspacePool(world.open, world.onError)
    pool.get('/repos/a')
    world.faults.close.push('/repos/a')

    pool.close('/repos/a')
    pool.close('/repos/a')

    expect(world.states.get('/repos/a')?.closes).toBe(1)
    expect(world.errors).toEqual([{ path: '/repos/a', message: 'close failed for /repos/a' }])
  })
})

describe('createWorkspacePool closeAll', () => {
  it('closes every workspace even when one fails, and empties the pool', () => {
    const world = createWorld()
    const pool = createWorkspacePool(world.open, world.onError)
    pool.get('/repos/a')
    pool.get('/repos/b')
    pool.get('/repos/c')
    world.faults.close.push('/repos/b')

    pool.closeAll()
    pool.closeAll()
    pool.heartbeatAll()

    expect([...world.states.values()].map((state) => [state.closes, state.beats])).toEqual([
      [1, 0],
      [1, 0],
      [1, 0]
    ])
    expect(world.errors).toEqual([{ path: '/repos/b', message: 'close failed for /repos/b' }])
    expect(world.opened).toEqual(['/repos/a', '/repos/b', '/repos/c'])
    expect(pool.get('/repos/a').repoRoot).toBe('/repos/a')
    expect(world.opened).toHaveLength(4)
  })
})
