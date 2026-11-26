import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
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
  it('lists the registered worktrees canonically, and a path in one is inside while an unregistered sibling is outside', () => {
    const { repo, worktree, sibling } = layout()
    const roots = createWorktreeRoots().rootsOf(repo)
    expect(roots).toEqual([repo, worktree])
    expect(roots).not.toContain(sibling)
    const exclusion = (path: string) => arbitrationExclusion({
      chat: { role: 'orchestrator', runId: 'rn_1' } as ChatRecord, agentKind: 'claude', prompt: write(path), folder: repo,
      settings: DEFAULT_NOTIFICATION_SETTINGS, platform: process.platform, allowedRoots: roots
    })
    expect(exclusion(join(worktree, 'src', 'a.ts'))).toBeNull()
    expect(exclusion(join(sibling, 'src', 'a.ts'))).toEqual({ reason: 'outside_folder' })
  })

  it('reads git at most once a minute per folder, and again after', () => {
    let now = 0
    const listPorcelain = vi.fn((_folder: string) => 'worktree /repo\nHEAD abc\n\nworktree /wt/dm-1\n')
    const roots = createWorktreeRoots({ listPorcelain, canonical: path => `canon:${path}`, now: () => now })
    expect(roots.rootsOf('/repo')).toEqual(['canon:/repo', 'canon:/wt/dm-1'])
    now = 59_999
    roots.rootsOf('/repo')
    expect(listPorcelain).toHaveBeenCalledOnce()
    roots.rootsOf('/other')
    now = 60_000
    roots.rootsOf('/repo')
    expect(listPorcelain.mock.calls.map(([folder]) => folder)).toEqual(['/repo', '/other', '/repo'])
  })

  it('a failing git gives no roots, and a worktree path that no longer resolves is dropped', () => {
    const failing = createWorktreeRoots({ listPorcelain: () => { throw new Error('not a repository') } })
    expect(failing.rootsOf('/repo')).toEqual([])
    const gone = createWorktreeRoots({
      listPorcelain: () => 'worktree /repo\r\nworktree /gone\r\n',
      canonical: path => { if (path === '/gone') throw new Error('ENOENT'); return path }
    })
    expect(gone.rootsOf('/repo')).toEqual(['/repo'])
  })
})
