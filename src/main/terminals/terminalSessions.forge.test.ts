import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DM_CLIENT_DESCRIPTOR_ENV } from '../../../resources/skitarii/extension/dmClient'
import { parseWorldMailDescriptor } from '../../../resources/skitarii/extension/worldDmClient'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import { createForge, updateForge } from '../desktop/forgeManifest'
import { eventually, recorder, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

let rig: TerminalRig
let member: string
let other: string
beforeEach(() => {
  rig = terminalRig({ agents: [builtInAgent('omp'), builtInAgent('claude')], deps: () => ({ forgeResolverFolders: () => [member] }) })
  member = join(rig.repo, 'Tickets')
  other = join(rig.root, 'Other')
  mkdirSync(member)
  mkdirSync(other)
  createForge(rig.repo, 'example')
  updateForge(rig.repo, world => world.projects.push({ folder: 'Tickets', repository: 'example/code' }))
  rig.tracked.add(member)
  rig.tracked.add(other)
  rig.reach = [member, other]
})
afterEach(() => rig.cleanup())

describe('Forge World root agent terminals', () => {
  it('starts in the world with only member grants and private scratch tokens, preserving the root chat identity', async () => {
    const chat = rig.newChat('omp')
    const { pty } = await startTerminal(rig, chat)
    expect(pty.spec.cwd).toBe(rig.repo)
    expect(rig.reachIssued[0]?.map(target => target.folder)).toEqual([member])
    expect(rig.reachIssued[0]?.[0]?.tokenFile).toContain(join(rig.userData, 'agents', 'scratch', chat.id))
    expect(rig.grantChats).toEqual([])
    expect(rig.reopenedStore().getChat(chat)).toMatchObject({ folder: rig.repo, grantIds: ['gr_1'] })
    const descriptorPath = pty.spec.env[DM_CLIENT_DESCRIPTOR_ENV]!
    expect(parseWorldMailDescriptor(descriptorPath, readFileSync(descriptorPath, 'utf8'))?.routes.map(route => route.descriptor.folder)).toEqual([member])
    const instructions = readFileSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`), 'utf8')
    expect(instructions).toContain('This chat is scoped to this Forge World')
    expect(instructions).toContain('**worker**')
    expect(instructions).toContain('may not save plans')
    expect(instructions).toContain('https://github.com/example/code.git')
    expect(instructions).not.toContain(other)
    expect(instructions).toContain('## Skitarii mail')
    expect(instructions).not.toContain('not tied to a project')
    expect(existsSync(join(rig.repo, '.dm'))).toBe(false)
    expect(existsSync(join(rig.repo, '.darkmechanicus'))).toBe(false)
  })

  it('starts an empty world without unrelated grants and explains the actual scope', async () => {
    rig.reach = [other]
    const chat = rig.newChat()
    await startTerminal(rig, chat)
    expect(rig.grantsAsked).toBe(0)
    const instructions = readFileSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`), 'utf8')
    expect(instructions).toContain('No member project is available and set up')
    expect(instructions).not.toContain('holds an orchestrator grant')
    expect(instructions).not.toContain(other)
  })

})

describe('Forge World grant lifecycle', () => {
  it('immediately stops root and member chats together when the world is untracked, leaving unrelated agents alone', async () => {
    const world = await startTerminal(rig, rig.newChat())
    const projectChat = rig.store.createChat({ folder: member, agent: 'claude', model: null, title: 'Project work', role: 'worker', allowSave: false })
    const project = await startTerminal(rig, projectChat)
    const elsewhere = rig.store.createChat({ folder: other, agent: 'claude', model: null, title: 'Other work', role: 'worker', allowSave: false })
    const independent = await startTerminal(rig, elsewhere)
    const released = rig.sessions.releaseFolder(rig.repo, () => { rig.tracked.delete(rig.repo); rig.tracked.delete(member) }, [member])
    world.pty.exit()
    project.pty.exit()
    await released
    expect(world.pty.kills).toBe(1)
    expect(project.pty.kills).toBe(1)
    expect(independent.pty.kills).toBe(0)
    expect(rig.revoked.sort()).toEqual(['gr_1', 'gr_2'])
  })

  it('stops and revokes member grants when one of its scoped folders is untracked', async () => {
    const { pty } = await startTerminal(rig, rig.newChat())
    const release = rig.sessions.releaseFolder(member, () => rig.tracked.delete(member))
    pty.exit()
    await release
    expect(pty.kills).toBe(1)
    expect(rig.revoked).toEqual(['gr_1'])
  })

  it('renews and revokes the world grants through the normal lifecycle', async () => {
    const { pty } = await startTerminal(rig, rig.newChat())
    rig.clock.advance(60 * 60_000)
    await eventually(() => rig.renewed.length === 1, 'member grant renewal')
    expect(rig.renewed).toEqual(['gr_1'])
    pty.exit()
    await eventually(() => rig.revoked.length === 1, 'member grant revoke')
    expect(rig.revoked).toEqual(['gr_1'])
  })

  it('refuses a root start when a member leaves its scope during authentication, before any grant', async () => {
    const held = rig.holdAuth()
    const heard = recorder()
    expect(await rig.sessions.attach(rig.newChat(), heard.listener)).toEqual({ state: 'checking' })
    rig.reach = [other]
    held.open({ state: 'signed_in', reason: 'Signed in.' })
    await eventually(() => heard.events.length > 0, 'the refused start')
    expect(heard.events).toEqual([expect.objectContaining({ kind: 'not_started', state: 'refused' })])
    expect(rig.grantsAsked).toBe(0)
    expect(rig.host.spawns).toEqual([])
  })

})

describe('Forge World member agent context', () => {
  it('starts a background root resolver using only cached world members while a manifest is conflicted', async () => {
    writeFileSync(join(rig.repo, 'forge-world.json'), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> remote\n')
    const chat = rig.newChat('omp')
    rig.store.updateChat(chat, { forgeResolver: rig.repo })
    const answer = await rig.sessions.start(chat, { kickoff: 'Resolve the repository merge on main' })
    expect(answer).toMatchObject({ state: 'running' })
    expect(rig.host.last().spec.cwd).toBe(rig.repo)
    expect(rig.reachIssued[0]?.map(target => target.folder)).toEqual([member])
    const instructions = readFileSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`), 'utf8')
    expect(instructions).toContain('manifest is unreadable during conflict repair')
    expect(instructions).not.toContain(other)
    expect(await rig.sessions.attach(rig.newChat())).toMatchObject({ state: 'refused' })
    expect(rig.host.spawns).toHaveLength(1)
    rig.clock.advance(60 * 60_000)
    await eventually(() => rig.renewed.length === 1, 'conflict resolver member grant renewal')
    expect(rig.host.last().kills).toBe(0)
  })

  it('starts the trusted conflict resolver on its existing member grant while keeping root scope parsing strict', async () => {
    writeFileSync(join(rig.repo, 'forge-world.json'), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> remote\n')
    const chat = rig.store.createChat({ folder: member, agent: 'omp', model: null, title: 'Repair sync', role: 'worker', allowSave: false })
    rig.store.updateChat(chat, { forgeResolver: rig.repo })
    const { pty } = await startTerminal(rig, chat)
    expect(pty.spec.cwd).toBe(member)
    expect(rig.reachIssued).toEqual([])
    expect(rig.grantChats).toEqual([expect.objectContaining({ id: chat.id })])
    const instructions = readFileSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`), 'utf8')
    expect(instructions).toContain('manifest is unreadable during conflict repair')
    expect(instructions).not.toContain('Clone when needed:')
    expect(await rig.sessions.attach(rig.newChat())).toMatchObject({ state: 'refused' })
    expect(rig.host.spawns).toHaveLength(1)
  })

  it.each(['manual', 'card', 'run'] as const)('supplies code directions to a %s member chat while retaining its project mailbox', async kind => {
    const chat = rig.store.createChat({ folder: member, agent: 'omp', model: null, title: 'Member work', role: 'orchestrator', allowSave: false,
      ...(kind === 'run' ? { runId: 'rn_1' } : {}), ...(kind === 'card' ? { cardId: 'kc_1' } : {}) })
    const { pty } = await startTerminal(rig, chat)
    expect(pty.spec.cwd).toBe(member)
    expect(rig.reachIssued).toEqual([])
    expect(rig.grantChats).toEqual([expect.objectContaining({ id: chat.id, agent: 'omp' })])
    expect(pty.spec.env[DM_CLIENT_DESCRIPTOR_ENV]).toBeDefined()
    const instructions = readFileSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`), 'utf8')
    expect(instructions).toContain('https://github.com/example/code.git')
    expect(instructions).toContain('pinned to ticket folder ' + JSON.stringify(member))
    expect(instructions).toContain('Other repository links are context, not additional grants')
    expect(instructions).toContain('## Skitarii mail')
    expect(instructions).not.toContain('This chat is scoped to this Forge World')
  })
})
