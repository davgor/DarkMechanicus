/**
 * Launching cult runs over the real pieces (`__mocks__/cultRig.ts`): desktop workspaces (the sanctum's in db mode, on a
 * folder that is not a Git repository), real chat grants with mailbox binding, the cult store on a real app database,
 * the sanctum registry on disk, and the terminal session manager on the fake PTY host (`terminalSessionsRig`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dbProjectDir } from '../../core/repo/storageMode'
import { chatRecordSchema, type ChatRecord } from '../../shared/agents/chat'
import type { CultInput } from '../../shared/cults/cult'
import { removeScratch } from '../../test/removeScratch'
import { resolveLaunchFolder } from '../agents/launchFolder'
import { terminalFilePaths } from '../terminals/terminalFiles'
import { eventually, settle } from '../terminals/__mocks__/terminalSessionsRig'
import type { FakePty } from '../terminals/__mocks__/fakePtyHost'
import { CHARTER, CHEAPEST, cultHarness, disposeCultHarness, folderCultInput, MAGOS_MODEL, ptyOf as ptyIn, type CultHarness } from './__mocks__/cultRig'
import { cultControlPath } from './cultControl'
import { createCultLauncher, EXIT_KEYS_AFTER_MS, GRACEFUL_EXIT_MS, type CultLauncher } from './cultLauncher'

let h: CultHarness

beforeEach(async () => {
  h = await cultHarness()
})

afterEach(async () => {
  await disposeCultHarness(h)
})

function folderCult(overrides: Partial<CultInput> = {}): CultInput {
  return folderCultInput(h, overrides)
}

function sanctumCult(): CultInput {
  return folderCult({ name: 'Sanctum Choir', scope: 'sanctum', folderPath: null })
}

function ptyOf(chat: ChatRecord): FakePty {
  return ptyIn(h, chat)
}

async function grantsIn(folder: string) {
  return h.pool.get(folder).listGrants()
}

function instructionsOf(chat: ChatRecord): string {
  return readFileSync(terminalFilePaths(h.rig.userData, chat.id, 'darwin').instructions, 'utf8')
}

describe('cult launcher: a folder cult run', () => {
  it('starts the Magos in the folder with an orchestrator grant without Allow save, the charter first and its model', async () => {
    const cult = h.cults.createCult(folderCult())
    const { run, magos } = await h.launcher.launch(cult.id)

    expect(run.state).toBe('running')
    expect(magos.start.state).toBe('running')
    expect(magos.chat).toMatchObject({ folder: h.rig.repo, agent: 'omp', role: 'orchestrator', allowSave: false, title: 'Magos Ferrum', model: MAGOS_MODEL, firstPrompt: CHARTER, cultRunId: run.id, cultRole: 'magos' })
    const args = ptyOf(magos.chat).spec.args as string[]
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', MAGOS_MODEL])
    expect(args.at(-1)).toBe(CHARTER)
    expect(ptyOf(magos.chat).spec.cwd).toBe(h.rig.repo)
    const [grant] = (await grantsIn(h.rig.repo)).filter((candidate) => h.rig.store.getChat(magos.chat)?.grantIds?.includes(candidate.id))
    expect(grant).toMatchObject({ role: 'orchestrator', allowSave: false, active: true })
    expect(h.rig.store.getChat(magos.chat)?.endpointId).toEqual(expect.any(String))
    expect(instructionsOf(magos.chat)).toContain('## Cult rules: Magos')
    expect(instructionsOf(magos.chat)).toContain('You are "Magos Ferrum"')
    expect(instructionsOf(magos.chat)).not.toContain(CHARTER)
    expect(h.cults.listMembers(run.id)).toEqual([expect.objectContaining({ chatId: magos.chat.id, role: 'magos', displayName: 'Magos Ferrum', model: MAGOS_MODEL })])
  })

  it('starts an acolyte with a worker grant, its mission first, the cheapest model by default, as a member of the run', async () => {
    const cult = h.cults.createCult(folderCult())
    const { run } = await h.launcher.launch(cult.id)
    const acolyte = await h.launcher.startAcolyte(run, { name: 'Acolyte Tests', mission: 'Write the parser tests.' })

    expect(acolyte.start.state).toBe('running')
    expect(acolyte.chat).toMatchObject({ role: 'worker', allowSave: false, title: 'Acolyte Tests', model: CHEAPEST, firstPrompt: 'Write the parser tests.', cultRunId: run.id, cultRole: 'acolyte' })
    const args = ptyOf(acolyte.chat).spec.args as string[]
    expect(args).toContain(CHEAPEST)
    expect(args.at(-1)).toBe('Write the parser tests.')
    const grant = (await grantsIn(h.rig.repo)).find((candidate) => h.rig.store.getChat(acolyte.chat)?.grantIds?.includes(candidate.id))
    expect(grant).toMatchObject({ role: 'worker', allowSave: false, active: true })
    expect(instructionsOf(acolyte.chat)).toContain('You are "Acolyte Tests", an acolyte of the cult "Order of the Cog". Your Magos is "Magos Ferrum".')
    expect(h.cults.listMembers(run.id).map((member) => [member.displayName, member.role, member.mission, member.model])).toEqual([
      ['Magos Ferrum', 'magos', '', MAGOS_MODEL],
      ['Acolyte Tests', 'acolyte', 'Write the parser tests.', CHEAPEST]
    ])
  })

  it('names an unnamed acolyte, and refuses a model id that cannot go on a command line', async () => {
    const { run } = await h.launcher.launch(h.cults.createCult(folderCult()).id)
    const named = await h.launcher.startAcolyte(run, { mission: 'Sweep the nave.' })

    expect(named.member.displayName).toMatch(/^Acolyte /)
    expect(named.chat.title).toBe(named.member.displayName)
    await expect(h.launcher.startAcolyte(run, { mission: 'x', model: '--dangerous' })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('cult launcher: member chats stay out of folder chat lists', () => {
  it('lists the folder ordinary chats only, in the folder list and in every-chat listing', async () => {
    const ordinary = h.rig.newChat('omp', 'Ordinary chat')
    const { magos } = await h.launcher.launch(h.cults.createCult(folderCult()).id)

    const listed = await h.handlers.list(h.rig.repo)
    const all = await h.handlers.listAll()
    expect(listed.ok && listed.data.map((chat) => chat.id)).toEqual([ordinary.id])
    expect(all.ok && all.data.map((chat) => chat.id)).toEqual([ordinary.id])
    expect(h.rig.store.listChats(h.rig.repo).map((chat) => chat.id)).toContain(magos.chat.id)
  })

  it('loads a legacy chat record with no cult fields, and lists it', async () => {
    const legacy = { id: 'chat_legacy', folder: h.rig.repo, agent: 'claude', model: null, role: 'worker', allowSave: false, title: 'Old', createdAt: 'a', updatedAt: 'b', sessionId: null }
    const parsed = chatRecordSchema.parse(legacy)

    expect(parsed.cultRunId).toBeUndefined()
    expect(parsed.cultRole).toBeUndefined()
    const stored = h.rig.store.createChat({ folder: h.rig.repo, agent: 'claude', model: null, role: 'worker', allowSave: false, title: 'Old' })
    expect(Object.keys(h.rig.reopenedStore().getChat(stored)!)).not.toContain('cultRunId')
    const listed = await h.handlers.list(h.rig.repo)
    expect(listed.ok && listed.data.map((chat) => chat.id)).toEqual([stored.id])
  })
})

describe('cult launcher: a sanctum run', () => {
  it('creates and registers a db-mode sanctum on a non-Git folder and starts the Magos in it', async () => {
    const cult = h.cults.createCult(sanctumCult())
    const { run, magos } = await h.launcher.launch(cult.id)
    const sanctum = join(realpathSync.native(h.rig.userData), 'cults', cult.id)

    expect(run.workDir).toBe(sanctum)
    expect(h.sanctums.resolve(sanctum)).toBe(sanctum)
    expect(JSON.parse(readFileSync(join(h.rig.userData, 'cults', 'sanctums.json'), 'utf8')).sanctums).toEqual([cult.id])
    expect(existsSync(join(sanctum, '.git'))).toBe(false)
    expect(readdirSync(sanctum)).toEqual([])
    expect(existsSync(join(dbProjectDir(sanctum, h.dmHome), 'project.json'))).toBe(true)
    expect(magos.start.state).toBe('running')
    expect(ptyOf(magos.chat).spec.cwd).toBe(sanctum)
    expect((await grantsIn(sanctum)).find((grant) => h.rig.store.getChat(magos.chat)?.grantIds?.includes(grant.id))).toMatchObject({ role: 'orchestrator', allowSave: false })
    expect(h.gates.list().map((folder) => folder.path)).toEqual([h.rig.repo])
  })

  it('ends the run, then deleting the cult removes its member chats, grants, sanctum and database project', async () => {
    const cult = h.cults.createCult(sanctumCult())
    const { run, magos } = await h.launcher.launch(cult.id)
    const acolyte = await h.launcher.startAcolyte(run, { name: 'Acolyte Psalm', mission: 'Sing.' })
    const sanctum = run.workDir
    await expect(h.launcher.deleteCult(cult.id)).rejects.toMatchObject({ code: 'active_run_exists' })

    h.cults.transitionRun(run.id, { type: 'shutdown', reason: 'stopped' })
    h.cults.transitionRun(run.id, { type: 'finish' })
    const grantIds = [magos.chat, acolyte.chat].flatMap((chat) => h.rig.store.getChat(chat)?.grantIds ?? [])
    expect(grantIds).toHaveLength(2)
    await h.launcher.deleteCult(cult.id)

    expect(h.rig.store.getChat(magos.chat)).toBeNull()
    expect(h.rig.store.getChat(acolyte.chat)).toBeNull()
    expect(h.rig.revoked).toEqual(expect.arrayContaining(grantIds))
    // Their trees were killed (a fake PTY only records it), and the sanctum's database went with the cult, grants and all.
    expect([ptyOf(magos.chat).kills, ptyOf(acolyte.chat).kills]).toEqual([1, 1])
    expect(existsSync(sanctum)).toBe(false)
    expect(existsSync(dbProjectDir(sanctum, h.dmHome))).toBe(false)
    expect(h.sanctums.resolve(sanctum)).toBeNull()
    expect(h.cults.getCult(cult.id)).toBeNull()
  })
})

describe('cult launcher: only a registered sanctum passes the untracked-folder checks', () => {
  it('refuses an arbitrary untracked path, an unregistered folder under the sanctum root and a removed sanctum', async () => {
    const stranger = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-untracked-')))
    const squatter = join(realpathSync.native(h.rig.userData), 'cults', 'ct_00000000000000000000000000')
    mkdirSync(squatter, { recursive: true })
    const sanctum = await h.sanctums.create('ct_11111111111111111111111111')
    try {
      for (const path of [stranger, squatter]) {
        expect(h.gates.resolve(path)).toBeNull()
        await expect(h.handlers.list(path)).resolves.toMatchObject({ ok: false, error: { code: 'unauthorized' } })
        expect(() => resolveLaunchFolder({ folder: path }, { trackedFolder: (p) => h.gates.resolve(p) })).toThrow(/is no longer tracked/)
      }
      expect(h.gates.resolve(sanctum)).toBe(sanctum)
      await h.sanctums.remove('ct_11111111111111111111111111')
      expect(h.gates.resolve(sanctum)).toBeNull()
      expect(() => h.sanctums.pathOf('../escape')).toThrow(/is not a cult id/)
    } finally {
      removeScratch(stranger)
    }
  })

  it('refuses a folder cult whose folder is no longer tracked, starting nothing', async () => {
    const cult = h.cults.createCult(folderCult())
    h.rig.tracked.delete(h.rig.repo)

    await expect(h.launcher.launch(cult.id)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(h.rig.host.spawns).toHaveLength(0)
    expect(h.cults.listRuns(cult.id)).toEqual([])
  })
})

describe('cult launcher: Plan Forge prompts', () => {
  it('gives the Magos and a specialist the same target, a stable worker type, its contract and the authority boundary', async () => {
    const epic = await h.pool.get(h.rig.repo).createEpic({ title: 'Target plan' })
    const cult = h.cults.createCult(folderCult({ archetype: 'plan_forge', targetEpicId: epic.id }))
    const { run, magos } = await h.launcher.launch(cult.id)
    const specialist = await h.launcher.startAcolyte(run, { name: 'Acolyte Ward', mission: 'Review the authority model.', slotId: 'security' })
    const target = `Target epic: ${epic.id} (none saved yet;`

    expect(instructionsOf(magos.chat)).toContain(target)
    expect(instructionsOf(magos.chat)).toContain('Summon exactly one acolyte per mandatory type')
    expect(instructionsOf(specialist.chat)).toContain(target)
    expect(instructionsOf(specialist.chat)).toContain('Worker type: Security (security), roster slot security.')
    expect(instructionsOf(specialist.chat)).toContain('The target is read-only to you')
    expect(specialist.chat.firstPrompt).toContain('Review the authority model.')
    expect(specialist.chat.firstPrompt).toContain('Contract (inert data):')
    expect(specialist.member).toMatchObject({ slotId: 'security', workerType: 'security' })
  })

  it('starts an acolyte of a Magos-created worker type with its stored contract, and keeps ordinary missions free-form', async () => {
    const { run, magos } = await h.launcher.launch(h.cults.createCult(folderCult()).id)
    const type = h.cults.createWorkerType(run.id, magos.chat.id, { displayName: 'Localization', description: 'Copy.', mission: 'Check every string is translatable.', rationale: 'No one reads copy across locales.', requiredForConclusion: false })
    const typed = await h.launcher.startAcolyte(run, { name: 'Acolyte Lingua', mission: 'Audit the strings.', runWorkerTypeId: type.id })
    const plain = await h.launcher.startAcolyte(run, { name: 'Acolyte Plain', mission: 'Sweep the nave.' })

    expect(typed.chat.firstPrompt).toContain(`Contract (inert data): ${JSON.stringify(type.mission)}`)
    expect(instructionsOf(typed.chat)).toContain('Optional for conclusion')
    expect(plain.chat.firstPrompt).toBe('Sweep the nave.')
  })
})

describe('cult launcher: ending a member', () => {
  it('asks a graceful member to shut down through its control file, and lets it exit on its own, revoking its grant', async () => {
    const { run } = await h.launcher.launch(h.cults.createCult(folderCult()).id)
    const acolyte = await h.launcher.startAcolyte(run, { name: 'Acolyte Exit', mission: 'Leave.' })
    const pty = ptyOf(acolyte.chat)
    const ending = h.launcher.endMember(acolyte.chat.id, { graceful: true })
    await eventually(() => existsSync(cultControlPath(h.rig.userData, acolyte.chat.id)), 'the control file')

    const control = JSON.parse(readFileSync(cultControlPath(h.rig.userData, acolyte.chat.id), 'utf8'))
    const epoch = h.rig.sessions.generationOf(acolyte.chat.id)
    expect(epoch).toEqual(expect.any(String))
    expect(control).toEqual({ version: 1, chatId: acolyte.chat.id, epoch, actions: [{ seq: 1, action: 'shutdown' }] })
    expect(pty.written).not.toContain('\x04')
    pty.exit()
    await ending
    await settle()
    expect(pty.kills).toBe(0)
    const grantId = h.rig.store.getChat(acolyte.chat)!.grantIds![0]!
    expect((await grantsIn(h.rig.repo)).find((grant) => grant.id === grantId)?.active).toBe(false)
  })

  it('types Ctrl+D for a member whose extension did not act, then kills it at the graceful window', async () => {
    const { run } = await h.launcher.launch(h.cults.createCult(folderCult()).id)
    const deaf = await h.launcher.startAcolyte(run, { name: 'Acolyte Deaf', mission: 'Stay.' })
    const ending = h.launcher.endMember(deaf.chat.id, { graceful: true })
    await settle()
    h.rig.clock.advance(EXIT_KEYS_AFTER_MS)

    expect(ptyOf(deaf.chat).written).toContain('\x04')
    expect(ptyOf(deaf.chat).kills).toBe(0)
    h.rig.clock.advance(GRACEFUL_EXIT_MS - EXIT_KEYS_AFTER_MS)
    await ending
    expect(ptyOf(deaf.chat).kills).toBe(1)
  })

  it('kills a member that does not exit within the graceful window, and at once without it', async () => {
    const { run } = await h.launcher.launch(h.cults.createCult(folderCult()).id)
    const stubborn = await h.launcher.startAcolyte(run, { name: 'Acolyte Stubborn', mission: 'Stay.' })
    const ending = h.launcher.endMember(stubborn.chat.id, { graceful: true })
    await settle()
    h.rig.clock.advance(GRACEFUL_EXIT_MS)
    await ending

    expect(ptyOf(stubborn.chat).kills).toBe(1)
    const abrupt = await h.launcher.startAcolyte(run, { name: 'Acolyte Abrupt', mission: 'Stay.' })
    await h.launcher.endMember(abrupt.chat.id, { graceful: false })
    expect(ptyOf(abrupt.chat).written).not.toContain('\x04')
    expect(ptyOf(abrupt.chat).kills).toBe(1)
  })
})

/** A launcher over the harness's pieces with some dependencies replaced, for failures the real ones never produce. */
function launcherWith(overrides: Partial<Parameters<typeof createCultLauncher>[0]>): CultLauncher {
  return createCultLauncher({
    cults: h.cults, folders: { resolve: (path) => (h.rig.tracked.has(path) ? path : null) }, sanctums: h.sanctums, chats: h.records,
    terminals: h.rig.sessions, control: h.control, workspaceFor: (folder) => h.pool.get(folder), closeWorkspace: (folder) => h.pool.close(folder),
    cheapestModel: async () => CHEAPEST, userData: h.rig.userData, dmHome: h.dmHome, ...overrides
  })
}

function endRun(runId: string): void {
  h.cults.transitionRun(runId, { type: 'shutdown', reason: 'stopped' })
  h.cults.transitionRun(runId, { type: 'finish' })
}

describe('cult launcher: refusals', () => {
  it('refuses an unknown cult, and a folder cult that has no folder, starting nothing', async () => {
    const cult = h.cults.createCult(folderCult())

    await expect(h.launcher.launch('ct_00000000000000000000000000')).rejects.toMatchObject({ code: 'not_found', message: 'No cult ct_00000000000000000000000000.' })
    await expect(h.launcher.prepareWorkspace({ ...cult, folderPath: null })).rejects.toMatchObject({ code: 'invalid_state', message: 'Cult Order of the Cog has no folder.' })
    expect(h.rig.host.spawns).toHaveLength(0)
  })

  it('refuses an acolyte of a roster slot the cult lacks, or of a worker type the run lacks, adding no member', async () => {
    const { run } = await h.launcher.launch(h.cults.createCult(folderCult()).id)

    await expect(h.launcher.startAcolyte(run, { mission: 'x', slotId: 'astropath' })).rejects.toMatchObject({ code: 'invalid_input', message: 'The cult has no roster slot astropath.' })
    await expect(h.launcher.startAcolyte(run, { mission: 'x', runWorkerTypeId: 'wt_missing' })).rejects.toMatchObject({ code: 'invalid_input', message: 'The run has no worker type wt_missing.' })
    expect(h.cults.listMembers(run.id).map((member) => member.role)).toEqual(['magos'])
  })
})

describe('cult launcher: the Magos', () => {
  it('runs on the cheapest model when the cult names none', async () => {
    const { magos } = await h.launcher.launch(h.cults.createCult(folderCult({ magosModelId: null })).id)

    expect(magos.chat.model).toBe(CHEAPEST)
    expect(magos.member.model).toBe(CHEAPEST)
  })

  it('ends the run as failed with the reason when the Magos cannot start', async () => {
    const cult = h.cults.createCult(folderCult())
    h.rig.host.failNextSpawn(new Error('posix_spawnp failed.'))

    await expect(h.launcher.launch(cult.id)).rejects.toMatchObject({ code: 'internal_error', message: 'The Magos did not start: posix_spawnp failed.' })
    const [run] = h.cults.listRuns(cult.id)
    expect(run).toMatchObject({ state: 'ended', endReason: 'failed' })
    expect(h.cults.pageEvents(run!.id).events.find((event) => event.kind === 'ended')?.summary).toBe('The Magos did not start: posix_spawnp failed.')
  })

  it('ends the run as failed with the default summary when binding throws a non-error', async () => {
    const cult = h.cults.createCult(folderCult())
    const launcher = launcherWith({ bindTarget: () => Promise.reject('target gone') })

    await expect(launcher.launch(cult.id)).rejects.toBe('target gone')
    const [run] = h.cults.listRuns(cult.id)
    expect(run).toMatchObject({ state: 'ended', endReason: 'failed' })
    expect(h.cults.pageEvents(run!.id).events.find((event) => event.kind === 'ended')?.summary).toBe('Run ended (failed).')
    expect(h.rig.host.spawns).toHaveLength(0)
  })
})

describe('cult launcher: reruns and deletion', () => {
  it('reuses a sanctum and its db project for the next run', async () => {
    const cult = h.cults.createCult(sanctumCult())
    const first = await h.launcher.launch(cult.id)
    const projectFile = join(dbProjectDir(first.run.workDir, h.dmHome), 'project.json')
    const project = readFileSync(projectFile, 'utf8')
    endRun(first.run.id)
    const second = await h.launcher.launch(cult.id)

    expect(second.run.workDir).toBe(first.run.workDir)
    expect(second.run.state).toBe('running')
    expect(readFileSync(projectFile, 'utf8')).toBe(project)
  })

  it('deletes a cult whose member chat is already gone', async () => {
    const cult = h.cults.createCult(folderCult())
    const { run, magos } = await h.launcher.launch(cult.id)
    endRun(run.id)
    await h.records.deleteChat(magos.chat)

    await h.launcher.deleteCult(cult.id)
    expect(h.cults.getCult(cult.id)).toBeNull()
  })

  it('keeps the cult when deleting a member chat fails for another reason', async () => {
    const cult = h.cults.createCult(folderCult())
    const { run } = await h.launcher.launch(cult.id)
    endRun(run.id)
    const launcher = launcherWith({ chats: { createChat: h.records.createChat, deleteChat: () => Promise.reject(new Error('disk full')) } })

    await expect(launcher.deleteCult(cult.id)).rejects.toThrow('disk full')
    expect(h.cults.getCult(cult.id)).not.toBeNull()
  })
})
