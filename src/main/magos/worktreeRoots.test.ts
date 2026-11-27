import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingPrompt } from '../../shared/agents/agentChat'
import type { ChatRecord } from '../../shared/agents/chat'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../shared/desktop/notificationSettings'
import { removeScratch } from '../../test/removeScratch'
import { arbitrationExclusion } from './arbitrationRules'
import { createWorktreeRoots } from './worktreeRoots'

let root: string | undefined
afterEach(() => { if (root) removeScratch(root); root = undefined })

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore', windowsHide: true })
}

/** A repository with one registered worktree and one unregistered sibling folder beside it. */
function layout() {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-worktree-roots-')))
  const repo = join(root, 'repo'), worktree = join(root, 'wt', 'dm-1'), sibling = join(root, 'wt', 'dm-2')
  mkdirSync(repo)
  mkdirSync(sibling, { recursive: true })
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'a')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'worktree', 'add', '-q', worktree)
  return { repo, worktree: realpathSync.native(worktree), sibling }
}

function write(path: string): PendingPrompt {
  return { id: 'p1', kind: 'approval', title: 'Write', detail: '', threadId: null, callsign: null, attributed: true,
    arbitration: { state: 'off', reason: null }, options: [{ id: 'allow_once', label: 'Allow once' }],
    tool: { name: 'Write', input: { file_path: path, content: 'x' } } }
}

describe('worktree roots (red-team fix 20)', () => {
  it('lists the registered worktrees canonically, and a path in one is inside while an unregistered sibling is outside', async () => {
    const { repo, worktree, sibling } = layout()
    const roots = await createWorktreeRoots().rootsOf(repo)
    expect(roots).toEqual([repo, worktree])
    expect(roots).not.toContain(sibling)
    const exclusion = (path: string) => arbitrationExclusion({
      chat: { role: 'orchestrator', runId: 'rn_1' } as ChatRecord, agentKind: 'claude', prompt: write(path), folder: repo,
      settings: DEFAULT_NOTIFICATION_SETTINGS, platform: process.platform, allowedRoots: roots
    })
    expect(exclusion(join(worktree, 'src', 'a.ts'))).toBeNull()
    expect(exclusion(join(sibling, 'src', 'a.ts'))).toEqual({ reason: 'outside_folder' })
  })

  it('a tracked subfolder allows only that subfolder in each worktree, never a repository root (DM-1011)', async () => {
    const { repo, worktree } = layout()
    const sub = join(repo, 'sub')
    mkdirSync(sub)
    mkdirSync(join(worktree, 'sub'))
    const roots = await createWorktreeRoots().rootsOf(sub)
    expect(roots).toEqual([sub, join(worktree, 'sub')])
    const exclusion = (path: string) => arbitrationExclusion({
      chat: { role: 'orchestrator', runId: 'rn_1' } as ChatRecord, agentKind: 'claude', prompt: write(path), folder: sub,
      settings: DEFAULT_NOTIFICATION_SETTINGS, platform: process.platform, allowedRoots: roots
    })
    expect(exclusion(join(worktree, 'sub', 'a.ts'))).toBeNull()
    expect(exclusion(join(repo, 'other.txt'))).toEqual({ reason: 'outside_folder' })
    expect(exclusion(join(worktree, 'other.txt'))).toEqual({ reason: 'outside_folder' })
  })
})

describe('worktree roots: a link at the subfolder of another worktree (DM-1011)', () => {
  // A junction needs no privilege on Windows; a directory symlink needs Developer Mode or elevation there.
  for (const type of ['junction', 'dir'] as const) it(`a ${type} at wt/sub is never a root, and a Write through it escalates`, async context => {
    const { repo, worktree } = layout()
    const sub = join(repo, 'sub'), target = join(root!, 'outside')
    mkdirSync(sub)
    mkdirSync(target)
    try {
      symlinkSync(target, join(worktree, 'sub'), type)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip(`a ${type} link cannot be created here`)
      throw error
    }
    const roots = await createWorktreeRoots().rootsOf(sub)
    expect(roots).toEqual([sub])
    const exclusion = arbitrationExclusion({
      chat: { role: 'orchestrator', runId: 'rn_1' } as ChatRecord, agentKind: 'claude', prompt: write(join(target, 'key')), folder: sub,
      settings: DEFAULT_NOTIFICATION_SETTINGS, platform: process.platform, allowedRoots: roots
    })
    expect(exclusion).toEqual({ reason: 'outside_folder' })
  })
})

describe('worktree roots: git reads and caching', () => {
  it('drops a worktree that lacks the subfolder, and gives no roots for a folder in no listed worktree', async () => {
    const listPorcelain = async () => `worktree ${join('/', 'repo')}\nworktree ${join('/', 'wt', 'dm-1')}\n`
    const existing = new Set([join('/', 'repo'), join('/', 'repo', 'sub'), join('/', 'wt', 'dm-1'), join('/', 'other')])
    const canonical = async (path: string) => { if (!existing.has(path)) throw new Error('ENOENT'); return path }
    const roots = createWorktreeRoots({ listPorcelain, canonical })
    expect(await roots.rootsOf(join('/', 'repo', 'sub'))).toEqual([join('/', 'repo', 'sub')])
    expect(await roots.rootsOf(join('/', 'other'))).toEqual([])
  })

  it('runs git asynchronously, reads it at most once a minute per folder, and shares a read in flight', async () => {
    let now = 0
    let release!: (porcelain: string) => void
    const listPorcelain = vi.fn((_folder: string) => new Promise<string>(resolve => { release = resolve }))
    const roots = createWorktreeRoots({ listPorcelain, canonical: async path => path, now: () => now })
    const first = roots.rootsOf('/repo'), second = roots.rootsOf('/repo')
    expect(listPorcelain).toHaveBeenCalledOnce()
    release('worktree /repo\nHEAD abc\n\nworktree /wt/dm-1\n')
    expect(await first).toEqual(['/repo', '/wt/dm-1'])
    expect(await second).toEqual(['/repo', '/wt/dm-1'])
    now = 59_999
    await roots.rootsOf('/repo')
    expect(listPorcelain).toHaveBeenCalledOnce()
    const other = roots.rootsOf('/other')
    release('')
    await other
    now = 60_000
    const again = roots.rootsOf('/repo')
    release('worktree /repo\n')
    await again
    expect(listPorcelain.mock.calls.map(([folder]) => folder)).toEqual(['/repo', '/other', '/repo'])
  })

  it('a failing git gives no roots, and a worktree path that no longer resolves is dropped', async () => {
    const failing = createWorktreeRoots({ listPorcelain: async () => { throw new Error('not a repository') } })
    expect(await failing.rootsOf('/repo')).toEqual([])
    const gone = createWorktreeRoots({
      listPorcelain: async () => 'worktree /repo\r\nworktree /gone\r\n',
      canonical: async path => { if (path === '/gone') throw new Error('ENOENT'); return path }
    })
    expect(await gone.rootsOf('/repo')).toEqual(['/repo'])
  })
})
