import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { openWorkspace } from '../../core/workspace'
import { DM_PROJECT, machine, markerCheckout, projectFileOf, writeProject, type Machine } from '../../test/crossRepoWorld'
import { gitIn } from '../../test/gitScratch'
import { removeScratch } from '../../test/removeScratch'
import { linkDirectory } from '../../test/tempRepo'

const OTHER_PROJECT = 'pj_000000000000000000000000x1'

let m: Machine

beforeEach(() => {
  m = machine()
})

afterEach(() => {
  m.cleanup()
})

/** A tracked marker checkout of the Dark Mechanicus source, at `name` under the machine root. */
function trackedCheckout(name = 'dm', projectId: string | null = DM_PROJECT): string {
  return m.registry.track(markerCheckout(join(m.root, name), { projectId })).folder.path
}

function thrown(action: () => unknown): DomainError {
  try {
    action()
  } catch (error) {
    if (error instanceof DomainError) return error
    throw error
  }
  throw new Error('expected a DomainError')
}

describe('DM-189 c1: associating a tracked or selected checkout after validation', () => {
  it('associates a tracked Dark Mechanicus checkout and keeps the portable target apart from the local path', () => {
    const path = trackedCheckout()
    const choice = m.checkouts.associate(path, false)
    expect(choice.outcome).toBe('associated')
    if (choice.outcome !== 'associated') return
    expect(choice.checkout.status).toBe('available')
    expect(choice.checkout.target).toEqual({ kind: 'darkmechanicus_source', projectId: DM_PROJECT, projectName: 'DarkMechanicus' })
    expect(choice.folder.path).toBe(path)
    const stored = JSON.parse(m.association() ?? 'null') as { version: number; checkout: { target: unknown; local: { path: string; associatedAt: string } } }
    expect(stored.version).toBe(1)
    expect(stored.checkout.target).toEqual({ kind: 'darkmechanicus_source', projectId: DM_PROJECT, projectName: 'DarkMechanicus' })
    expect(JSON.stringify(stored.checkout.target)).not.toContain(m.root)
    expect(stored.checkout.local.path).toBe(path)
    expect(m.checkouts.requireAvailable()).toEqual({ path, target: { kind: 'darkmechanicus_source', projectId: DM_PROJECT, projectName: 'DarkMechanicus' } })
  })

  it('refuses a folder that is not tracked (untracked) and writes no association', () => {
    const path = markerCheckout(join(m.root, 'dm'))
    const choice = m.checkouts.associate(path, false)
    expect(choice).toMatchObject({ outcome: 'refused', problem: 'untracked' })
    expect(m.association()).toBeNull()
    expect(m.checkouts.view().status).toBe('none')
  })

  it('screens a selected folder in full before it is tracked: the source passes, nothing is tracked by screening', () => {
    const path = markerCheckout(join(m.root, 'dm'))
    expect(m.checkouts.screen(path)).toBeNull()
    expect(m.registry.list()).toEqual([])
  })

  it('reports a source checkout without a project record as needing initialization, then associates it once set up through the workspace', async () => {
    const path = trackedCheckout('dm', null)
    gitIn(path, 'init', '--quiet')
    const before = m.checkouts.associate(path, true)
    expect(before).toMatchObject({ outcome: 'needs_initialization', added: true })
    expect(m.association()).toBeNull()
    const workspace = openWorkspace({ repoRoot: path, role: 'desktop', label: 'Desktop', transport: 'desktop', homeDir: m.dmHome, autoReconcile: false })
    try {
      const result = (await workspace.initializeRepository({ name: 'DarkMechanicus' })) as { projectId: string }
      const after = m.checkouts.associate(path, false)
      expect(after.outcome).toBe('associated')
      if (after.outcome !== 'associated') return
      expect(after.checkout.target?.projectId).toBe(result.projectId)
    } finally {
      workspace.close()
    }
  })
})

describe('DM-189 c2: canonical aliases resolve to one target', () => {
  it('resolves a trailing separator, a .. detour and a directory link to the same target, and re-choosing writes nothing', () => {
    const path = trackedCheckout()
    const first = m.checkouts.associate(path, false)
    expect(first.outcome).toBe('associated')
    const text = m.association()
    const link = join(m.root, 'alias')
    linkDirectory(path, link)
    for (const alias of [`${path}${sep}`, join(path, '..', 'dm'), link]) {
      const tracked = m.registry.track(alias)
      expect(tracked).toMatchObject({ added: false, folder: { path } })
      const again = m.checkouts.associate(tracked.folder.path, false)
      expect(again).toMatchObject({ outcome: 'associated', checkout: { target: { projectId: DM_PROJECT } } })
    }
    expect(m.association()).toBe(text)
    expect(m.registry.list()).toHaveLength(1)
  })

  it('refuses a non-canonical path handed to associate as relocated, naming the canonical folder', () => {
    const path = trackedCheckout()
    const link = join(m.root, 'alias')
    linkDirectory(path, link)
    expect(m.checkouts.associate(link, false)).toMatchObject({ outcome: 'refused', problem: 'relocated' })
  })
})

describe('DM-189 c2: revalidation before mutation', () => {
  it('makes a moved checkout unavailable (missing) and requireAvailable fails not_found before any write', () => {
    const path = trackedCheckout()
    m.checkouts.associate(path, false)
    renameSync(path, join(m.root, 'moved'))
    expect(m.checkouts.view()).toMatchObject({ status: 'unavailable', problem: 'missing', target: { projectId: DM_PROJECT } })
    const error = thrown(() => m.checkouts.requireAvailable())
    expect(error.code).toBe('not_found')
    expect(error.details).toMatchObject({ problem: 'missing', path })
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a path replaced by a link to another folder (relocated, project_mismatch)', () => {
    const path = trackedCheckout()
    m.checkouts.associate(path, false)
    const elsewhere = markerCheckout(join(m.root, 'elsewhere'))
    renameSync(path, join(m.root, 'old'))
    linkDirectory(elsewhere, path)
    expect(m.checkouts.view()).toMatchObject({ status: 'unavailable', problem: 'relocated' })
    const error = thrown(() => m.checkouts.requireAvailable())
    expect(error.code).toBe('project_mismatch')
    expect(error.details).toMatchObject({ problem: 'relocated' })
  })

  it('refuses a checkout that now holds another project (replaced)', () => {
    const path = trackedCheckout()
    m.checkouts.associate(path, false)
    writeProject(path, OTHER_PROJECT)
    const error = thrown(() => m.checkouts.requireAvailable())
    expect(error.code).toBe('project_mismatch')
    expect(error.details).toMatchObject({ problem: 'project_mismatch' })
    expect(error.message).toContain(OTHER_PROJECT)
  })

  it('refuses a checkout whose project record became unreadable or is gone', () => {
    const path = trackedCheckout()
    m.checkouts.associate(path, false)
    writeFileSync(projectFileOf(path), '{ not json')
    expect(thrown(() => m.checkouts.requireAvailable()).details).toMatchObject({ problem: 'unreadable_project' })
    rmSync(projectFileOf(path))
    const error = thrown(() => m.checkouts.requireAvailable())
    expect(error.code).toBe('not_initialized')
    expect(error.details).toMatchObject({ problem: 'not_initialized' })
  })

  it('refuses a checkout that is no longer tracked (unauthorized)', () => {
    const path = trackedCheckout()
    m.checkouts.associate(path, false)
    m.registry.untrack(path)
    const error = thrown(() => m.checkouts.requireAvailable())
    expect(error.code).toBe('unauthorized')
    expect(error.details).toMatchObject({ problem: 'untracked' })
  })
})

/** Whether this machine's temp folder resolves names case-insensitively (a case-only rename keeps the folder there). */
function caseInsensitiveTemp(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'dm-case-probe-'))
  try {
    return existsSync(probe.toUpperCase()) && existsSync(probe.toLowerCase())
  } finally {
    removeScratch(probe)
  }
}

const caseSensitive = !caseInsensitiveTemp()

describe('DM-189 c2: a case-only rename (renamed) versus a link that leads elsewhere (relocated)', () => {
  it.skipIf(caseSensitive)('classifies a checkout renamed by letter case only as renamed, naming its new spelling', () => {
    const path = trackedCheckout('dm')
    m.checkouts.associate(path, false)
    renameSync(path, join(m.root, 'dm-moving'))
    renameSync(join(m.root, 'dm-moving'), join(m.root, 'DM'))
    const canonical = join(m.root, 'DM')
    const view = m.checkouts.view()
    expect(view).toMatchObject({ status: 'unavailable', problem: 'renamed', local: { path } })
    expect(view.message).toBe(`${path} is now named ${canonical}: only the letter case changed.`)
    expect(view.recovery).toBe(`Choose the checkout again at ${canonical}; nothing is written to it until it checks out.`)
    const error = thrown(() => m.checkouts.requireAvailable())
    expect(error.code).toBe('invalid_state')
    expect(error.details).toMatchObject({ problem: 'renamed', path })
  })

  it.skipIf(caseSensitive)('refuses a path handed to associate in another letter case as renamed, not relocated', () => {
    const path = trackedCheckout('dm')
    const variant = join(m.root, 'DM')
    expect(m.checkouts.associate(variant, false)).toMatchObject({ outcome: 'refused', problem: 'renamed', message: `${variant} is now named ${path}: only the letter case changed.` })
    expect(m.association()).toBeNull()
  })

  it('classifies a path replaced by a link to another folder of the same name in another case as relocated', () => {
    const path = trackedCheckout('dm')
    m.checkouts.associate(path, false)
    renameSync(path, join(m.root, 'old'))
    mkdirSync(join(m.root, 'sub'))
    const lookalike = markerCheckout(join(m.root, 'sub', 'DM'))
    linkDirectory(lookalike, path)
    const view = m.checkouts.view()
    expect(view).toMatchObject({ status: 'unavailable', problem: 'relocated' })
    expect(view.message).toBe(`${path} now leads to ${lookalike}: a link or junction on the way changed.`)
    const error = thrown(() => m.checkouts.requireAvailable())
    expect(error.code).toBe('project_mismatch')
    expect(error.details).toMatchObject({ problem: 'relocated', path })
  })
})

describe('DM-189 c3: installed apps, unrelated repositories and missing clones stay unavailable', () => {
  it('refuses the running app folder and a folder inside it as installed_app', () => {
    const app = markerCheckout(join(m.root, 'app'))
    m.installed.push(app)
    expect(m.checkouts.screen(app)).toMatchObject({ problem: 'installed_app' })
    mkdirSync(join(app, 'resources'))
    expect(m.checkouts.screen(join(app, 'resources'))).toMatchObject({ problem: 'installed_app' })
  })

  it('refuses a folder laid out like an installed app (resources/app.asar), even with the source markers', () => {
    const path = markerCheckout(join(m.root, 'packed'))
    mkdirSync(join(path, 'resources'))
    writeFileSync(join(path, 'resources', 'app.asar'), '')
    const refusal = m.checkouts.screen(path)
    expect(refusal).toMatchObject({ problem: 'installed_app' })
    expect(refusal?.recovery).toContain('Clone the Dark Mechanicus repository with Git yourself')
  })

  it('refuses the dark-mechanicus package without its sources outside Git as installed_app', () => {
    const path = markerCheckout(join(m.root, 'unpacked'), { sources: false, git: false, projectId: null })
    expect(m.checkouts.screen(path)).toMatchObject({ problem: 'installed_app' })
  })

  it('refuses an unrelated repository, a folder merely named like the app, and a copy outside Git as not_dm_source', () => {
    const other = markerCheckout(join(m.root, 'other'), { packageName: 'shop' })
    expect(m.checkouts.screen(other)?.message).toContain('no package.json naming the dark-mechanicus package')
    const named = join(m.root, 'DarkMechanicus')
    mkdirSync(named)
    expect(m.checkouts.screen(named)).toMatchObject({ problem: 'not_dm_source' })
    const noSources = markerCheckout(join(m.root, 'nosrc'), { sources: false })
    expect(m.checkouts.screen(noSources)?.message).toContain('the Dark Mechanicus source files are missing')
    const noGit = markerCheckout(join(m.root, 'nogit'), { git: false })
    expect(m.checkouts.screen(noGit)?.message).toContain('it is not a Git checkout')
  })
})

describe('DM-189 c3: missing clones and unrelated repositories, no clone or redirect', () => {
  it('refuses a tracked unrelated repository on associate and stores nothing', () => {
    const other = m.registry.track(markerCheckout(join(m.root, 'other'), { packageName: 'shop' })).folder.path
    expect(m.checkouts.associate(other, false)).toMatchObject({ outcome: 'refused', problem: 'not_dm_source' })
    expect(m.association()).toBeNull()
  })

  it('refuses a missing clone with a clone-it-yourself recovery and never creates or clones it', () => {
    const gone = join(m.root, 'never-cloned')
    const refusal = m.checkouts.screen(gone)
    expect(refusal).toMatchObject({ outcome: 'refused', problem: 'missing' })
    expect(refusal?.recovery).toContain('Clone the Dark Mechanicus repository with Git yourself, then choose that clone.')
    expect(m.checkouts.associate(gone, false)).toMatchObject({ problem: 'missing' })
    expect(existsSync(gone)).toBe(false)
    expect(m.registry.list()).toEqual([])
    expect(m.association()).toBeNull()
  })

  it('never redirects to another valid checkout of the same project when the associated one is gone', () => {
    const path = trackedCheckout()
    m.checkouts.associate(path, false)
    trackedCheckout('second')
    rmSync(path, { recursive: true, force: true })
    expect(m.checkouts.view()).toMatchObject({ status: 'unavailable', problem: 'missing', local: { path } })
    expect(thrown(() => m.checkouts.requireAvailable()).code).toBe('not_found')
  })

  it('shows no association before one is chosen and after clearing, with the choose-first recovery', () => {
    expect(m.checkouts.view()).toMatchObject({ status: 'none', target: null, recovery: 'Choose your Dark Mechanicus checkout (a Git clone of Dark Mechanicus on this machine).' })
    expect(thrown(() => m.checkouts.requireAvailable()).code).toBe('not_found')
    const path = trackedCheckout()
    m.checkouts.associate(path, false)
    expect(m.checkouts.clear().status).toBe('none')
    expect(existsSync(path)).toBe(true)
    expect(m.checkouts.view().status).toBe('none')
  })
})

describe('DM-273: what a chosen folder and the stored association are, read as they stand', () => {
  it('refuses a file chosen in place of a folder as missing', () => {
    const file = join(m.root, 'notes.txt')
    writeFileSync(file, 'not a folder')
    expect(m.checkouts.screen(file)).toMatchObject({ outcome: 'refused', problem: 'missing', message: `No folder exists at ${file}. Dark Mechanicus never looks for a moved checkout or clones one.` })
  })

  it('refuses a package.json whose name is not a string as not the source', () => {
    const path = markerCheckout(join(m.root, 'odd'))
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 7 }))
    expect(m.checkouts.screen(path)).toMatchObject({ problem: 'not_dm_source', message: expect.stringContaining('no package.json naming the dark-mechanicus package') })
  })

  it('refuses a project file that is JSON but not a project record (unreadable_project) and stores nothing', () => {
    const path = trackedCheckout()
    writeFileSync(projectFileOf(path), JSON.stringify({ projectId: 'not-a-project-id' }))
    expect(m.checkouts.associate(path, false)).toMatchObject({ outcome: 'refused', problem: 'unreadable_project', message: `${projectFileOf(path)} is not a valid Dark Mechanicus project record.` })
    expect(m.association()).toBeNull()
  })

  it('skips an installed app folder that does not exist, and refuses every folder under an app installed at a drive root', () => {
    const path = markerCheckout(join(m.root, 'dm'))
    m.installed.push(join(m.root, 'not-installed'))
    expect(m.checkouts.screen(path)).toBeNull()
    m.installed.push(parse(path).root)
    expect(m.checkouts.screen(path)).toMatchObject({ problem: 'installed_app' })
  })

  it('reads an association file of another shape as no association, and persists an explicit clear', () => {
    mkdirSync(m.userData, { recursive: true })
    writeFileSync(m.associationFile, JSON.stringify({ version: 1, checkout: { local: 'elsewhere' } }))
    expect(m.checkouts.view()).toMatchObject({ status: 'none', target: null })
    rmSync(m.associationFile)
    expect(m.checkouts.clear().status).toBe('none')
    expect(JSON.parse(m.association()!)).toEqual({ version: 1, checkout: null })
  })
})
