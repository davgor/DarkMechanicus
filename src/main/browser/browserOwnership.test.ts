import { describe, expect, it } from 'vitest'
import { CLAIM_TOKEN_MASK } from '../agents/claimTokenMask'
import { createBrowserOwnership, ownerLabel, type BrowserOwnership } from './browserOwnership'

const GRANT = `dmg_${'ab12'.repeat(16)}`
const CLAIM = `at_${'0'.repeat(26)}.${'Qz9'.repeat(11)}`
const worker = { role: 'worker' as const, title: 'DM-863 worker chat' }
const magos = { role: 'orchestrator' as const, runId: 'rn_1', title: 'Sprint run' }
const noKeys: ReadonlySet<string> = new Set()

function admitted(result: ReturnType<BrowserOwnership['beginAgentOp']>) {
  if (!result.ok) throw new Error(`refused: ${result.code}`)
  return result
}

describe('browser ownership transitions', () => {
  it('starts at none and the first agent op moves it to agent', () => {
    const own = createBrowserOwnership()
    expect(own.owner('c1')).toBe('none')
    expect(admitted(own.beginAgentOp('c1')).signal.aborted).toBe(false)
    expect(own.owner('c1')).toBe('agent')
    expect(own.beginAgentOp('c1').ok).toBe(true)
    expect(own.owner('c1')).toBe('agent')
    expect(own.owner('c2')).toBe('none')
  })

  it('moves agent to person through takeControl and back to agent through handBack', () => {
    const own = createBrowserOwnership()
    own.beginAgentOp('c1')
    expect(own.takeControl('c1')).toEqual(['detach_debugger'])
    expect(own.owner('c1')).toBe('person')
    expect(own.handBack('c1')).toEqual([])
    expect(own.owner('c1')).toBe('agent')
  })

  it('takes control from none and from stopped too (fix 58)', () => {
    const own = createBrowserOwnership()
    expect(own.takeControl('c1')).toEqual(['detach_debugger'])
    expect(own.owner('c1')).toBe('person')
    own.stop('c2')
    expect(own.takeControl('c2')).toEqual(['detach_debugger'])
    expect(own.owner('c2')).toBe('person')
  })

  it('a second takeControl while the person drives changes nothing', () => {
    const own = createBrowserOwnership()
    own.takeControl('c1')
    expect(own.takeControl('c1')).toEqual([])
    expect(own.owner('c1')).toBe('person')
  })
})

describe('browser ownership stop and hand back', () => {
  it('stops from every state and handBack moves stopped to none', () => {
    const own = createBrowserOwnership()
    const from = { none: 'a', agent: 'b', person: 'c', stopped: 'd' }
    own.beginAgentOp(from.agent)
    own.takeControl(from.person)
    own.stop(from.stopped)
    for (const chat of Object.values(from)) {
      expect(own.stop(chat)).toEqual(['detach_debugger', 'stop_loading'])
      expect(own.owner(chat)).toBe('stopped')
    }
    expect(own.handBack(from.stopped)).toEqual([])
    expect(own.owner(from.stopped)).toBe('none')
    expect(own.beginAgentOp(from.stopped).ok).toBe(true)
    expect(own.owner(from.stopped)).toBe('agent')
  })

  it('handBack in none or agent changes nothing', () => {
    const own = createBrowserOwnership()
    expect(own.handBack('c1')).toEqual([])
    expect(own.owner('c1')).toBe('none')
    own.beginAgentOp('c1')
    expect(own.handBack('c1')).toEqual([])
    expect(own.owner('c1')).toBe('agent')
  })
})

describe('agent ops', () => {
  it('stop aborts two in-flight signals in the same tick', () => {
    const own = createBrowserOwnership()
    const first = admitted(own.beginAgentOp('c1'))
    const second = admitted(own.beginAgentOp('c1'))
    const other = admitted(own.beginAgentOp('c2'))
    const seen: string[] = []
    first.signal.addEventListener('abort', () => seen.push('first'))
    second.signal.addEventListener('abort', () => seen.push('second'))
    own.stop('c1')
    expect(seen).toEqual(['first', 'second'])
    expect([first.signal.aborted, second.signal.aborted]).toEqual([true, true])
    expect(first.signal.reason).toBe('stopped')
    expect(other.signal.aborted).toBe(false)
  })

  it('takeControl aborts in-flight ops so no agent input lands after the person took over', () => {
    const own = createBrowserOwnership()
    const op = admitted(own.beginAgentOp('c1'))
    own.takeControl('c1')
    expect(op.signal.aborted).toBe(true)
    expect(op.signal.reason).toBe('paused_by_person')
  })

  it('an ended op is no longer aborted by a later stop', () => {
    const own = createBrowserOwnership()
    const op = admitted(own.beginAgentOp('c1'))
    op.end()
    own.stop('c1')
    expect(op.signal.aborted).toBe(false)
  })

  it('refuses ops after stop or takeControl synchronously, never a promise', () => {
    const own = createBrowserOwnership()
    own.stop('c1')
    own.takeControl('c2')
    const stopped = own.beginAgentOp('c1')
    const paused = own.beginAgentOp('c2')
    expect(stopped).not.toBeInstanceOf(Promise)
    expect(stopped).toEqual({ ok: false, code: 'stopped' })
    expect(paused).toEqual({ ok: false, code: 'paused_by_person' })
    expect([own.owner('c1'), own.owner('c2')]).toEqual(['stopped', 'person'])
  })

  it('forget aborts what is running and drops the chat state', () => {
    const own = createBrowserOwnership()
    const op = admitted(own.beginAgentOp('c1'))
    own.forget('c1')
    expect(op.signal.aborted).toBe(true)
    expect(own.owner('c1')).toBe('none')
  })
})

describe('ownerLabel', () => {
  const label = (input: Partial<Parameters<typeof ownerLabel>[0]>) =>
    ownerLabel({ owner: 'agent', chat: worker, as: undefined, boundTicketKeys: noKeys, ...input })

  it('reads You while the person drives and nothing when no agent drives', () => {
    expect(label({ owner: 'person', as: 'Acolyte:DM-1' })).toBe('You')
    expect(label({ owner: 'none' })).toBeNull()
    expect(label({ owner: 'stopped' })).toBeNull()
  })

  it('never yields Magos from as in a worker chat', () => {
    expect(label({ as: 'Magos' })).toBe('DM-863 worker chat')
    expect(label({ as: 'Magos', chat: { role: 'worker', title: '' } })).toBe('An agent chat')
    expect(label({ as: 'Magos', chat: { role: 'orchestrator', title: 'No run' } })).toBe('No run')
  })

  it('shows Magos only from an orchestrator chat record', () => {
    expect(label({ chat: magos })).toBe('Magos')
    expect(label({ chat: magos, as: 'Servitor-3' })).toBe('Magos')
  })

  it('shows an Acolyte key only when it is bound to the chat', () => {
    const bound = new Set(['DM-863'])
    expect(label({ as: 'Acolyte:DM-863 Model ownership', boundTicketKeys: bound })).toBe('Acolyte:DM-863')
    expect(label({ as: 'Inquisitor:DM-863 Review', boundTicketKeys: bound })).toBe('Inquisitor:DM-863')
    expect(label({ as: 'Acolyte:DM-999', boundTicketKeys: bound })).toBe('DM-863 worker chat')
    expect(label({ as: 'Acolyte:DM-863' })).toBe('DM-863 worker chat')
  })

  it('falls back to the chat name for an unparsable or absent label', () => {
    expect(label({ as: 'not a callsign' })).toBe('DM-863 worker chat')
    expect(label({ as: 'Servitor-2' })).toBe('DM-863 worker chat')
    expect(label({})).toBe('DM-863 worker chat')
  })

  it('masks grant and claim tokens in the label before clipping it to 40 characters', () => {
    const grant = label({ chat: { role: 'worker', title: `key ${GRANT}` } })
    expect(grant).toBe('key [grant token masked]')
    expect(grant).not.toContain('dmg_')
    const claim = label({ chat: { role: 'worker', title: `${'z'.repeat(30)} ${CLAIM}` } })
    expect(claim).toBe(`${'z'.repeat(30)} ${CLAIM_TOKEN_MASK}`.slice(0, 40))
    expect(claim).not.toContain('Qz9')
  })

  it('keeps labels plain text and at most 40 characters', () => {
    expect(label({ chat: { role: 'worker', title: `${'x'.repeat(39)}😀 tail` } })).toBe('x'.repeat(39))
    expect(label({ chat: { role: 'worker', title: 'a\u202Eb\u0007c\n d' } })).toBe('ab c d')
    expect(label({ chat: { role: 'worker', title: 'y'.repeat(60) } })).toHaveLength(40)
  })
})
