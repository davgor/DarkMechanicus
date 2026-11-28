/**
 * The member's cult tools (`resources/skitarii/extension/cultTools.ts`): their argument checks refuse a call before
 * anything runs, and a refusal by main comes back as inert data. Also the member's wake gate
 * (`resources/skitarii/extension/cultWake.ts`) taking nothing from a malformed or foreign wake file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cultRoleOf, cultTools } from '../../../resources/skitarii/extension/cultTools'
import { CULT_WAKE_FILE, cultWakeGate } from '../../../resources/skitarii/extension/cultWake'
import { DM_CLIENT_DESCRIPTOR_ENV, type DmCallResult, type DmClient } from '../../../resources/skitarii/extension/dmClient'
import type { ToolResult, TypeBuilder } from '../../../resources/skitarii/extension/messaging'
import { writeDmClientDescriptor } from './terminalFiles'

/** OMP's `pi.typebox.Type`, as plain schema objects. */
const fakeType: TypeBuilder = {
  Object: (properties, options) => ({ type: 'object', properties, ...options }),
  String: (options) => ({ type: 'string', ...options }),
  Integer: (options) => ({ type: 'integer', ...options }),
  Boolean: (options) => ({ type: 'boolean', ...options }),
  Array: (items, options) => ({ type: 'array', items, ...options }),
  Optional: (schema) => ({ optional: schema }),
  Null: () => ({ type: 'null' }),
  Union: (schemas) => ({ anyOf: schemas })
}

const ITEM = { workerType: 'security', recommendation: 'Rotate the keys.', decision: 'accepted', reason: 'Cheap and safe.' }

function magos(answer: DmCallResult<unknown> = { ok: true, data: { done: true } }) {
  const runs: { command: string; input: unknown }[] = []
  const client = {
    run: async (command: string, input: unknown) => {
      runs.push({ command, input })
      return answer
    }
  } as DmClient
  const tools = cultTools(client, fakeType, 'magos')
  const call = (name: string, params: unknown): Promise<ToolResult> => tools.find((tool) => tool.name === name)!.execute('c', params)
  return { runs, call }
}

const textOf = (result: ToolResult): string => result.content.map((part) => part.text).join('')

const UNKNOWN_OR_COUNT: [string, string, Record<string, unknown>, string][] = [
  ['an argument the tool does not take', 'cult_order_all', { body: 'Report.', runId: 'cr_1' }, 'Unknown argument "runId".'],
  ['no acolytes asked for', 'cult_petition', { kind: 'acolytes', additional: 0, reason: 'More.' }, 'Argument "additional" is missing or not valid.'],
  ['25 acolytes asked for', 'cult_petition', { kind: 'acolytes', additional: 25, reason: 'More.' }, 'Argument "additional" is missing or not valid.'],
  ['a fractional acolyte count', 'cult_petition', { kind: 'acolytes', additional: 1.5, reason: 'More.' }, 'Argument "additional" is missing or not valid.']
]

const INVALID: [string, string, Record<string, unknown>, string][] = [
  ['an unknown petition kind', 'cult_petition', { kind: 'servitors', reason: 'More.' }, 'kind'],
  ['a fractional draft revision', 'cult_record_synthesis', { draftRevision: 1.5, recommendations: [ITEM] }, 'draftRevision'],
  ['a zero draft revision', 'cult_record_synthesis', { draftRevision: 0, recommendations: [ITEM] }, 'draftRevision'],
  ['recommendations that are not a list', 'cult_record_synthesis', { draftRevision: 1, recommendations: ITEM }, 'recommendations'],
  ['no recommendations', 'cult_record_synthesis', { draftRevision: 1, recommendations: [] }, 'recommendations'],
  ['97 recommendations', 'cult_record_synthesis', { draftRevision: 1, recommendations: Array.from({ length: 97 }, () => ITEM) }, 'recommendations'],
  ['a null recommendation', 'cult_record_synthesis', { draftRevision: 1, recommendations: [null] }, 'recommendations'],
  ['a text recommendation', 'cult_record_synthesis', { draftRevision: 1, recommendations: ['Rotate the keys.'] }, 'recommendations'],
  ['a nested list recommendation', 'cult_record_synthesis', { draftRevision: 1, recommendations: [[ITEM]] }, 'recommendations'],
  ['an extra key', 'cult_record_synthesis', { draftRevision: 1, recommendations: [{ ...ITEM, runId: 'cr_1' }] }, 'recommendations'],
  ['an undecided item', 'cult_record_synthesis', { draftRevision: 1, recommendations: [{ ...ITEM, decision: 'deferred' }] }, 'recommendations'],
  ['a blank worker type', 'cult_record_synthesis', { draftRevision: 1, recommendations: [{ ...ITEM, workerType: ' ' }] }, 'recommendations'],
  ['an overlong recommendation', 'cult_record_synthesis', { draftRevision: 1, recommendations: [{ ...ITEM, recommendation: 'x'.repeat(2001) }] }, 'recommendations'],
  ['a numeric reason', 'cult_record_synthesis', { draftRevision: 1, recommendations: [{ ...ITEM, reason: 5 }] }, 'recommendations']
]

describe('cult tool arguments', () => {
  it('passes every petition kind and a synthesis with both decisions on to main unchanged', async () => {
    const m = magos()
    const synthesis = { draftRevision: 3, recommendations: [ITEM, { ...ITEM, decision: 'rejected' }] }
    for (const params of [{ kind: 'allow_save', reason: 'Save it.' }, { kind: 'folder_access', folder: '/w/other', reason: 'Read it.' }]) {
      expect((await m.call('cult_petition', params)).isError).toBeUndefined()
    }
    expect((await m.call('cult_record_synthesis', synthesis)).isError).toBeUndefined()
    expect(m.runs).toEqual([
      { command: 'cult_petition', input: { kind: 'allow_save', reason: 'Save it.' } },
      { command: 'cult_petition', input: { kind: 'folder_access', folder: '/w/other', reason: 'Read it.' } },
      { command: 'cult_record_synthesis', input: synthesis }
    ])
  })

  it('runs a tool without arguments as an empty object, and refuses arguments that are not one object', async () => {
    const m = magos()
    expect((await m.call('cult_status', undefined)).isError).toBeUndefined()
    for (const params of ['status', [1], 7]) {
      const refused = await m.call('cult_status', params)
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toBe('cult_status refused the call: Arguments must be one JSON object. Nothing was run.')
    }
    expect(m.runs).toEqual([{ command: 'cult_status', input: {} }])
  })

  it.each(UNKNOWN_OR_COUNT)('refuses %s, running nothing', async (_name, tool, params, message) => {
    const m = magos()
    const refused = await m.call(tool, params)

    expect(textOf(refused)).toBe(`${tool} refused the call: ${message} Nothing was run.`)
    expect(m.runs).toEqual([])
  })

  it.each(INVALID)('refuses %s, running nothing', async (_name, tool, params, key) => {
    const m = magos()
    const refused = await m.call(tool, params)

    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toBe(`${tool} refused the call: Argument "${key}" is missing or not valid. Nothing was run.`)
    expect(m.runs).toEqual([])
  })

  it('reports main refusing a call as inert data with its source, code and message', async () => {
    const m = magos({ ok: false, error: { source: 'dm', code: 'run_paused', message: 'The cult run is paused.' } })
    const result = await m.call('cult_order_all', { body: 'Report.' })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/^cult_order_all failed:\n/)
    expect(textOf(result)).toContain('run_paused')
    expect(textOf(result)).toContain('The cult run is paused.')
  })
})

describe('the cult role of a launch', () => {
  it('gives an acolyte its three tools and any other chat none', () => {
    const client = {} as DmClient

    expect(cultTools(client, fakeType, 'acolyte').map((tool) => tool.name)).toEqual(['cult_status', 'cult_conclude_service', 'cult_shrine'])
    expect(cultTools(client, fakeType, undefined)).toEqual([])
  })

  it('reads the role from the descriptor main wrote', async () => {
    const path = await writeDmClientDescriptor({
      userData: join(root, 'userData'), chatId: 'chat-1', generation: 'launch-1', folder: root, platform: process.platform, cultRole: 'acolyte',
      cli: { command: process.execPath, args: [join(root, 'app', 'out', 'main', 'cli.js'), '--repo', root], env: { ELECTRON_RUN_AS_NODE: '1' } }
    })

    expect(await cultRoleOf({ [DM_CLIENT_DESCRIPTOR_ENV]: path }, (file) => readFile(file, 'utf8'))).toBe('acolyte')
  })

  it('has none without a descriptor, or with one that cannot be read or is not valid', async () => {
    const env = { [DM_CLIENT_DESCRIPTOR_ENV]: '/u/agents/omp/chat-1/dm-client/launch-1.json' }

    expect(await cultRoleOf({}, async () => '{}')).toBeUndefined()
    expect(await cultRoleOf(env, () => Promise.reject(new Error('ENOENT')))).toBeUndefined()
    expect(await cultRoleOf(env, async () => '{"cultRole":"magos"}')).toBeUndefined()
  })
})

describe('the cult wake gate', () => {
  const descriptor = '/u/agents/omp/chat-1/dm-client/launch-1.json'
  const wake = (extra: Record<string, unknown> = {}): string => JSON.stringify({ version: 1, chatId: 'chat-1', epoch: 'launch-1', wake: 1, ...extra })

  it.each([
    ['too large', JSON.stringify({ version: 1, chatId: 'chat-1', epoch: 'launch-1', wake: 1, pad: 'x'.repeat(4096) })],
    ['not JSON', '{'],
    ['null', 'null'],
    ['a list', '[1]'],
    ['a number', '7'],
    ['missing a key', JSON.stringify({ version: 1, chatId: 'chat-1', epoch: 'launch-1' })],
    ['an extra key', wake({ note: 'x' })],
    ['a renamed key', JSON.stringify({ version: 1, chatId: 'chat-1', epoch: 'launch-1', wakes: 1 })],
    ['another version', wake({ version: 2 })],
    ['another chat', wake({ chatId: 'chat-2' })],
    ['another launch', wake({ epoch: 'launch-0' })],
    ['a zero wake', wake({ wake: 0 })],
    ['a fractional wake', wake({ wake: 1.5 })],
    ['a text wake', wake({ wake: '1' })]
  ])('takes nothing from a wake file that is %s', async (_name, text) => {
    const gate = cultWakeGate({ [DM_CLIENT_DESCRIPTOR_ENV]: descriptor }, async () => text)!

    expect(await gate.take()).toBe(false)
  })

  it('reads the wake file beside the descriptor from disk by default, taking each armed wake once', async () => {
    const chatDir = join(root, 'agents', 'omp', 'chat-1')
    mkdirSync(join(chatDir, 'dm-client'), { recursive: true })
    const gate = cultWakeGate({ [DM_CLIENT_DESCRIPTOR_ENV]: join(chatDir, 'dm-client', 'launch-1.json') })!
    expect(await gate.take()).toBe(false)
    writeFileSync(join(chatDir, CULT_WAKE_FILE), wake({ wake: null }))
    expect(await gate.take()).toBe(false)
    writeFileSync(join(chatDir, CULT_WAKE_FILE), wake({ wake: 2 }))

    expect(await gate.take()).toBe(true)
    expect(await gate.take()).toBe(false)
  })

  it('has no gate without an absolute JSON descriptor path', () => {
    expect(cultWakeGate({})).toBeNull()
    expect(cultWakeGate({ [DM_CLIENT_DESCRIPTOR_ENV]: 'chat-1/dm-client/launch-1.json' })).toBeNull()
    expect(cultWakeGate({ [DM_CLIENT_DESCRIPTOR_ENV]: '/u/agents/omp/chat-1/dm-client/launch-1.txt' })).toBeNull()
  })
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dm-cult-tools-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
