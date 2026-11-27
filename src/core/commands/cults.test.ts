/**
 * The cult member commands as the `dm` command table holds them: their strict input schemas, their snake_case and
 * camelCase names (`resolveCommand`), their `cult.act` capability, and the operation each relays to the desktop. An
 * input never names a run, a role or a sender; main derives them from the bound grant (`src/main/cults/cultControl.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import { resolveCommand, snakeCase } from '../../cli/main'
import type { NamingOperation, NamingReply } from '../../shared/agents/chatNaming'
import { CULT_OPERATION_NAMES, MAX_LONG_TEXT_BYTES, MAX_ORDER_BYTES } from '../../shared/cults/cultControl'
import { capabilitiesForRole } from '../authz'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { COMMAND_CAPABILITIES } from './capabilities'
import { cultCommands } from './cults'
import { COMMANDS } from './index'
import type { WorkspaceCore } from './types'

const CULT_COMMANDS = Object.keys(cultCommands) as (keyof typeof cultCommands)[]

describe('cult commands: registration', () => {
  it('registers each cult operation under its snake_case name and camelCase alias, with cult.act', () => {
    expect(CULT_COMMANDS.map((name) => snakeCase(name)).sort()).toEqual([...CULT_OPERATION_NAMES].sort())
    for (const name of CULT_COMMANDS) {
      expect(COMMANDS[name]).toBe(cultCommands[name])
      expect(resolveCommand(snakeCase(name))).toBe(name)
      expect(resolveCommand(name)).toBe(name)
      expect(COMMAND_CAPABILITIES[name]).toBe('cult.act')
    }
    expect(resolveCommand('summon_acolyte')).toBeNull()
  })

  it('gives cult.act to the Magos (orchestrator) and acolyte (worker) grants only', () => {
    expect(capabilitiesForRole('orchestrator')).toContain('cult.act')
    expect(capabilitiesForRole('worker')).toContain('cult.act')
    for (const role of ['desktop', 'reader', 'planner', 'reviewer'] as const) expect(capabilitiesForRole(role)).not.toContain('cult.act')
  })
})

const parse = (name: keyof typeof cultCommands, input: unknown) => COMMAND_SCHEMAS[name].safeParse(input)

describe('cult commands: input schemas', () => {
  it('refuses any run, role or sender in the input', () => {
    for (const name of CULT_COMMANDS) {
      for (const field of ['runId', 'role', 'sender', 'chatId', 'cultId']) {
        expect(parse(name, { [field]: 'x' }).success, `${name} with ${field}`).toBe(false)
      }
    }
    expect(parse('cultStatus', {}).success).toBe(true)
    expect(parse('cultListAcolytes', {}).success).toBe(true)
  })

  it('summon: a mission, an optional name, model, tier reason, and a slot or a run worker type', () => {
    expect(parse('cultSummonAcolyte', { mission: 'Sweep the nave.' }).success).toBe(true)
    expect(parse('cultSummonAcolyte', { mission: 'Sweep.', name: 'Acolyte Brass', model: 'anthropic/claude-fable-5', tierReason: 'Hard proof.', slotId: 'security' }).success).toBe(true)
    expect(parse('cultSummonAcolyte', {}).success).toBe(false)
    expect(parse('cultSummonAcolyte', { mission: '   ' }).success).toBe(false)
    expect(parse('cultSummonAcolyte', { mission: 'x', name: 'Two\nlines' }).success).toBe(false)
    expect(parse('cultSummonAcolyte', { mission: 'x', model: '--dangerous' }).success).toBe(false)
    expect(parse('cultSummonAcolyte', { mission: 'x', slotId: 'a b' }).success).toBe(false)
    expect(parse('cultSummonAcolyte', { mission: 'x', slotId: 'security', workerTypeId: 'wt_1' }).success).toBe(false)
  })

  it('petition: each kind with only its own field, and a reason', () => {
    expect(parse('cultPetition', { kind: 'acolytes', additional: 2, reason: 'More hands.' }).success).toBe(true)
    expect(parse('cultPetition', { kind: 'allow_save', reason: 'Save the plan.' }).success).toBe(true)
    expect(parse('cultPetition', { kind: 'folder_access', folder: '/srv/other', reason: 'Read it.' }).success).toBe(true)
    expect(parse('cultPetition', { kind: 'acolytes', reason: 'How many?' }).success).toBe(false)
    expect(parse('cultPetition', { kind: 'acolytes', additional: 0, reason: 'None.' }).success).toBe(false)
    expect(parse('cultPetition', { kind: 'allow_save', folder: '/srv', reason: 'x' }).success).toBe(false)
    expect(parse('cultPetition', { kind: 'folder_access', reason: 'Which?' }).success).toBe(false)
    expect(parse('cultPetition', { kind: 'allow_save' }).success).toBe(false)
    expect(parse('cultPetition', { kind: 'other', reason: 'x' }).success).toBe(false)
  })

  it('order_all: plain text of at most 16 KiB', () => {
    expect(parse('cultOrderAll', { body: 'Report at once.\nAll of you.' }).success).toBe(true)
    expect(parse('cultOrderAll', { body: 'é'.repeat(MAX_ORDER_BYTES / 2) }).success).toBe(true)
    expect(parse('cultOrderAll', { body: 'é'.repeat(MAX_ORDER_BYTES / 2 + 1) }).success).toBe(false)
    expect(parse('cultOrderAll', { body: ' \n ' }).success).toBe(false)
    expect(parse('cultOrderAll', { body: 'bell\u0007' }).success).toBe(false)
  })

  it('conclude_run and conclude_service: inert text of at most 32 KiB', () => {
    for (const [name, field] of [['cultConcludeRun', 'chronicle'], ['cultConcludeService', 'report']] as const) {
      expect(parse(name, { [field]: 'Done.\n\tAll of it.' }).success).toBe(true)
      expect(parse(name, { [field]: 'a'.repeat(MAX_LONG_TEXT_BYTES) }).success).toBe(true)
      expect(parse(name, { [field]: 'a'.repeat(MAX_LONG_TEXT_BYTES + 1) }).success).toBe(false)
      expect(parse(name, { [field]: 'escape\u001b[2J' }).success).toBe(false)
      expect(parse(name, { [field]: '\uD800' }).success).toBe(false)
    }
  })
})

/** A core whose session holds `capabilities`; its desktop answers each operation with `reply`, whatever that is. */
function core(capabilities: string[], reply: (operation: NamingOperation) => unknown) {
  const sent: NamingOperation[] = []
  const request = async (operation: NamingOperation): Promise<NamingReply> => {
    sent.push(operation)
    // The fake desktop may answer what no real one would; the command must still parse it.
    return reply(operation) as NamingReply
  }
  const workspace = { ctx: () => ({ session: { role: 'worker', capabilities: new Set(capabilities) } }), desktopClient: { request } } as unknown as WorkspaceCore
  return { workspace, sent }
}

describe('cult commands: relaying to the desktop', () => {
  it('sends the parsed input as the operation, with nothing added, and parses the typed result', async () => {
    const { workspace, sent } = core(['cult.act'], () => ({ version: 1, requestId: 'r', ok: true, data: { orderId: 'co_1', recipients: ['Acolyte Brass'] } }))
    expect(await cultCommands.cultOrderAll.run(workspace, { body: 'Report.' })).toEqual({ orderId: 'co_1', recipients: ['Acolyte Brass'] })
    expect(sent).toEqual([{ op: 'cult_order_all', args: { body: 'Report.' } }])
  })

  it('surfaces a typed refusal with its code and the available models', async () => {
    const { workspace } = core(['cult.act'], () => ({
      version: 1, requestId: 'r', ok: false,
      error: { source: 'dm', code: 'model_unavailable', message: 'That model is not a signed-in model.', details: { available: ['anthropic/claude-haiku-4-5'] } }
    }))
    await expect(cultCommands.cultSummonAcolyte.run(workspace, { mission: 'x', model: 'other/model' })).rejects.toMatchObject({
      code: 'model_unavailable', details: { available: ['anthropic/claude-haiku-4-5'] }
    })
  })

  it('refuses a session without cult.act before reaching the desktop, and an unexpected reply', async () => {
    const without = core(['read'], () => { throw new Error('not reached') })
    await expect(cultCommands.cultStatus.run(without.workspace)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(without.sent).toEqual([])
    const odd = core(['cult.act'], () => ({ version: 1, requestId: 'r', ok: true, data: { runId: 'leak' } }))
    await expect(cultCommands.cultStatus.run(odd.workspace)).rejects.toMatchObject({ code: 'internal_error' })
  })
})
