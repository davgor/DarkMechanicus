import { describe, expect, it } from 'vitest'
import { asRecord, asText, clip, fileChangeOf, itemFor, reloginMessage, scopedId, turnEnd } from './codexItems'
import { RpcError } from './codexRpc'

const AT = '2026-10-03T12:00:00.000Z'

/** The transcript item for a thread item of turn `t1`. */
function itemOf(raw: unknown, phase: 'started' | 'completed' = 'completed') {
  return itemFor(raw, phase, 't1', AT)
}

describe('value helpers', () => {
  it('reads only plain objects as records and only non-empty strings as text', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([1])).toBeNull()
    expect(asRecord(null)).toBeNull()
    expect(asRecord('text')).toBeNull()
    expect(asText('hello')).toBe('hello')
    expect(asText('')).toBeNull()
    expect(asText(7)).toBeNull()
  })

  it('clips text past the limit with an ellipsis and leaves shorter text alone', () => {
    expect(clip('abc', 3)).toBe('abc')
    expect(clip('abcd', 3)).toBe('abc…')
    expect(clip('x'.repeat(301))).toBe(`${'x'.repeat(300)}…`)
  })

  it('namespaces an item id by its turn', () => {
    expect(scopedId('t1', 'i9')).toBe('t1:i9')
  })
})

describe('items that have no place in the transcript', () => {
  it('skips anything that is not an item with a type and an id', () => {
    expect(itemOf(null)).toBeNull()
    expect(itemOf('agentMessage')).toBeNull()
    expect(itemOf({ id: 'i1' })).toBeNull()
    expect(itemOf({ type: 'agentMessage' })).toBeNull()
  })

  it('skips item types this version does not know', () => {
    expect(itemOf({ type: 'reasoning', id: 'i1', summary: ['thinking'] })).toBeNull()
  })
})

describe('assistant messages and compaction', () => {
  it('shows an agent message once it is complete, under the turn-scoped id', () => {
    expect(itemOf({ type: 'agentMessage', id: 'm1', text: 'Done.' })).toEqual({
      id: 't1:m1',
      at: AT,
      kind: 'assistant_text',
      text: 'Done.'
    })
  })

  it('waits for a message to finish and skips one without text', () => {
    expect(itemOf({ type: 'agentMessage', id: 'm1', text: 'Partial' }, 'started')).toBeNull()
    expect(itemOf({ type: 'agentMessage', id: 'm1', text: '' })).toBeNull()
  })

  it('marks a finished compaction as a context reset and ignores its start', () => {
    expect(itemOf({ type: 'contextCompaction', id: 'c1' })).toEqual({
      id: 't1:c1',
      at: AT,
      kind: 'context_reset',
      reason: 'compact'
    })
    expect(itemOf({ type: 'contextCompaction', id: 'c1' }, 'started')).toBeNull()
  })
})

describe('command executions', () => {
  it('shows a running command with its working directory and no result yet', () => {
    expect(itemOf({ type: 'commandExecution', id: 'x1', command: 'npm test', cwd: '/repo', status: 'inProgress' }, 'started')).toEqual({
      id: 't1:x1',
      at: AT,
      kind: 'tool_call',
      name: 'command',
      input: { command: 'npm test', cwd: '/repo' },
      status: 'running',
      resultSummary: null
    })
  })

  it('treats an item with no status as running at its start and completed at its end', () => {
    const started = itemOf({ type: 'commandExecution', id: 'x1', command: 'ls' }, 'started')
    const completed = itemOf({ type: 'commandExecution', id: 'x1', command: 'ls' })

    expect(started).toMatchObject({ status: 'running', resultSummary: null })
    expect(completed).toMatchObject({ status: 'completed', resultSummary: 'Finished' })
  })

  it('omits a missing working directory and falls back to an empty command', () => {
    expect(itemOf({ type: 'commandExecution', id: 'x1' }, 'started')).toMatchObject({ input: { command: '' } })
    expect(itemOf({ type: 'commandExecution', id: 'x1', command: 'ls' }, 'started')).toMatchObject({ input: { command: 'ls' } })
    expect(itemOf({ type: 'commandExecution', id: 'x1', command: 'ls' }, 'started')).not.toHaveProperty('input.cwd')
  })

  it('reports the exit code and the clipped output of a finished command', () => {
    const output = 'o'.repeat(400)

    const done = itemOf({ type: 'commandExecution', id: 'x1', command: 'make', status: 'completed', exitCode: 0, aggregatedOutput: output })

    expect(done).toMatchObject({ status: 'completed', resultSummary: `Exit code 0\n${'o'.repeat(300)}…` })
  })

  it('reports a failed command by its exit code, or plainly when it has none', () => {
    expect(itemOf({ type: 'commandExecution', id: 'x1', command: 'make', status: 'failed', exitCode: 2 })).toMatchObject({
      status: 'failed',
      resultSummary: 'Exit code 2'
    })
    expect(itemOf({ type: 'commandExecution', id: 'x1', command: 'make', status: 'failed', aggregatedOutput: 'boom' })).toMatchObject({
      status: 'failed',
      resultSummary: 'Failed\nboom'
    })
  })

  it('says a refused command was declined', () => {
    expect(itemOf({ type: 'commandExecution', id: 'x1', command: 'rm -rf /', status: 'declined' })).toMatchObject({
      status: 'denied',
      resultSummary: 'Declined'
    })
  })

  it('clips a long command', () => {
    const shown = itemOf({ type: 'commandExecution', id: 'x1', command: 'c'.repeat(350) }, 'started')

    expect(shown).toMatchObject({ input: { command: `${'c'.repeat(300)}…` } })
  })
})

describe('file changes', () => {
  it('lists each file with how it changed, defaulting the kind to an update', () => {
    const shown = itemOf({
      type: 'fileChange',
      id: 'f1',
      changes: [
        { path: 'a.ts', kind: { type: 'add' } },
        { path: 'b.ts' },
        { path: 'c.ts', kind: {} }
      ]
    })

    expect(shown).toMatchObject({
      name: 'file_change',
      input: {
        files: [
          { path: 'a.ts', kind: 'add' },
          { path: 'b.ts', kind: 'update' },
          { path: 'c.ts', kind: 'update' }
        ]
      },
      status: 'completed',
      resultSummary: '3 files changed'
    })
  })

  it('counts a single file in the singular', () => {
    expect(itemOf({ type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }] })).toMatchObject({ resultSummary: '1 file changed' })
  })

  it('ignores changes without a path and tolerates a missing change list', () => {
    expect(itemOf({ type: 'fileChange', id: 'f1', changes: [{ kind: { type: 'add' } }, 'a.ts', null, { path: 'ok.ts' }] })).toMatchObject({
      input: { files: [{ path: 'ok.ts', kind: 'update' }] },
      resultSummary: '1 file changed'
    })
    expect(itemOf({ type: 'fileChange', id: 'f1' })).toMatchObject({ input: { files: [] }, resultSummary: '0 files changed' })
  })

})

describe('file change results', () => {
  it('lists at most 20 files but counts them all', () => {
    const changes = Array.from({ length: 25 }, (_, index) => ({ path: `f${index}.ts` }))
    const listed = changes.slice(0, 20).map(({ path }) => ({ path, kind: 'update' }))

    const shown = itemOf({ type: 'fileChange', id: 'f1', changes })

    expect(shown).toMatchObject({ input: { files: listed }, resultSummary: '25 files changed' })
  })

  it('has no result while the change is still running and calls a failure failed', () => {
    expect(itemOf({ type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }], status: 'inProgress' }, 'started')).toMatchObject({
      status: 'running',
      resultSummary: null
    })
    expect(itemOf({ type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }], status: 'failed' })).toMatchObject({
      status: 'failed',
      resultSummary: 'Failed'
    })
  })
})

describe('mcp and dynamic tool calls', () => {
  it('names an mcp call after its server and tool and shows its arguments and result text', () => {
    const shown = itemOf({
      type: 'mcpToolCall',
      id: 'm1',
      server: 'docs',
      tool: 'search',
      arguments: { query: 'rpc' },
      status: 'completed',
      result: { content: [{ type: 'text', text: 'first' }, { type: 'image' }, { type: 'text', text: 'second' }] }
    })

    expect(shown).toEqual({
      id: 't1:m1',
      at: AT,
      kind: 'tool_call',
      name: 'docs.search',
      input: { query: 'rpc' },
      status: 'completed',
      resultSummary: 'first\nsecond'
    })
  })

  it('falls back to generic names and to Completed when the result has no text', () => {
    expect(itemOf({ type: 'mcpToolCall', id: 'm1' })).toMatchObject({ name: 'mcp.tool', input: {}, resultSummary: 'Completed' })
    expect(itemOf({ type: 'mcpToolCall', id: 'm1', result: { content: 'plain' } })).toMatchObject({ resultSummary: 'Completed' })
    expect(itemOf({ type: 'mcpToolCall', id: 'm1', result: { content: [{ type: 'text', text: '' }] } })).toMatchObject({
      resultSummary: 'Completed'
    })
  })

  it('reports the error message of a failed mcp call, or a plain failure without one', () => {
    expect(itemOf({ type: 'mcpToolCall', id: 'm1', server: 's', tool: 't', status: 'failed', error: { message: 'no such table' } })).toMatchObject({
      status: 'failed',
      resultSummary: 'no such table'
    })
    expect(itemOf({ type: 'mcpToolCall', id: 'm1', server: 's', tool: 't', status: 'failed' })).toMatchObject({ resultSummary: 'Failed' })
  })

  it('shows arguments as they are, clipping a value that serializes past the limit', () => {
    const long = 'v'.repeat(400)

    const shown = itemOf({ type: 'mcpToolCall', id: 'm1', server: 's', tool: 't', arguments: { short: 1, long, nothing: undefined } })

    expect(shown).toMatchObject({ input: { short: 1, long: clip(JSON.stringify(long)), nothing: undefined } })
  })

})

describe('tool call arguments and dynamic tools', () => {
  it('shows arguments that are not an object under a value key', () => {
    expect(itemOf({ type: 'dynamicToolCall', id: 'd1', tool: 'run', arguments: 'ls -la' })).toMatchObject({ input: { value: 'ls -la' } })
    expect(itemOf({ type: 'dynamicToolCall', id: 'd1', tool: 'run', arguments: [1, 2] })).toMatchObject({ input: { value: '[1,2]' } })
    expect(itemOf({ type: 'dynamicToolCall', id: 'd1', tool: 'run', arguments: null })).toMatchObject({ input: {} })
  })

  it('names a dynamic tool call after its tool, falling back to tool, and completes it', () => {
    expect(itemOf({ type: 'dynamicToolCall', id: 'd1', tool: 'lookup', arguments: { id: 4 } })).toMatchObject({
      name: 'lookup',
      input: { id: 4 },
      status: 'completed',
      resultSummary: 'Completed'
    })
    expect(itemOf({ type: 'dynamicToolCall', id: 'd1' }, 'started')).toMatchObject({ name: 'tool', status: 'running', resultSummary: null })
    expect(itemOf({ type: 'dynamicToolCall', id: 'd1', status: 'declined' })).toMatchObject({ status: 'denied', resultSummary: 'Declined' })
  })
})

describe('web searches', () => {
  it('shows the query and never a result', () => {
    expect(itemOf({ type: 'webSearch', id: 'w1', query: 'vitest coverage' })).toMatchObject({
      name: 'web_search',
      input: { query: 'vitest coverage' },
      resultSummary: null
    })
    expect(itemOf({ type: 'webSearch', id: 'w1' }, 'started')).toMatchObject({ name: 'web_search', input: {}, resultSummary: null })
  })
})

describe('file change lookups', () => {
  it('names the id and files of a file-change item', () => {
    expect(fileChangeOf({ type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts', kind: { type: 'delete' } }] })).toEqual({
      id: 'f1',
      files: [{ path: 'a.ts', kind: 'delete' }]
    })
  })

  it('is null for any other item', () => {
    expect(fileChangeOf({ type: 'commandExecution', id: 'x1' })).toBeNull()
    expect(fileChangeOf({ type: 'fileChange' })).toBeNull()
    expect(fileChangeOf('fileChange')).toBeNull()
  })
})

describe('how a turn ended', () => {
  it('is a plain end for a turn that did not fail', () => {
    expect(turnEnd({ id: 'turn-1', status: 'completed' }, 'turn-1')).toEqual({ failure: null, signedOut: false })
    expect(turnEnd({ id: 'turn-1', status: 'interrupted' }, null)).toEqual({ failure: null, signedOut: false })
  })

  it('belongs to nobody when it is another turn or not a turn', () => {
    expect(turnEnd({ id: 'turn-2', status: 'completed' }, 'turn-1')).toBeNull()
    expect(turnEnd('turn-1', 'turn-1')).toBeNull()
    expect(turnEnd(null, null)).toBeNull()
  })

  it('accepts a turn without an id as the one being waited on', () => {
    expect(turnEnd({ status: 'completed' }, 'turn-1')).toEqual({ failure: null, signedOut: false })
  })

  it('carries the failure message, with a default when the turn gave none', () => {
    expect(turnEnd({ id: 'turn-1', status: 'failed', error: { message: 'quota exceeded' } }, 'turn-1')).toEqual({
      failure: 'quota exceeded',
      signedOut: false
    })
    expect(turnEnd({ id: 'turn-1', status: 'failed' }, 'turn-1')).toEqual({ failure: 'The Codex turn failed.', signedOut: false })
  })

  it('reads an unauthorized error as a rejected sign-in', () => {
    expect(turnEnd({ id: 'turn-1', status: 'failed', error: { message: 'x', codexErrorInfo: 'unauthorized' } }, 'turn-1')).toMatchObject({
      signedOut: true
    })
  })

  it('reads an HTTP failure with status 401 as a rejected sign-in and other statuses as not', () => {
    const failure = (kind: string, httpStatusCode: number) => ({
      id: 'turn-1',
      status: 'failed',
      error: { message: 'x', codexErrorInfo: { [kind]: { httpStatusCode } } }
    })

    expect(turnEnd(failure('responseStreamDisconnected', 401), 'turn-1')).toMatchObject({ signedOut: true })
    expect(turnEnd(failure('httpConnectionFailed', 500), 'turn-1')).toMatchObject({ signedOut: false })
    expect(turnEnd(failure('somethingElse', 401), 'turn-1')).toMatchObject({ signedOut: false })
    expect(turnEnd({ id: 'turn-1', status: 'failed', error: { codexErrorInfo: 'other' } }, 'turn-1')).toMatchObject({ signedOut: false })
  })
})

describe('relogin refusals', () => {
  it('uses the login own words when the app-server asks to log in again', () => {
    const error = new RpcError(-32000, 'refresh failed', { action: 'relogin', detail: 'Your session expired.' })

    expect(reloginMessage(error)).toBe('Your session expired.')
  })

  it('falls back to the error message when the refusal gives no detail', () => {
    expect(reloginMessage(new RpcError(-32000, 'refresh failed', { action: 'relogin' }))).toBe('refresh failed')
  })

  it('is null for any other error', () => {
    expect(reloginMessage(new RpcError(-32000, 'nope', { action: 'retry' }))).toBeNull()
    expect(reloginMessage(new RpcError(-32000, 'nope'))).toBeNull()
    expect(reloginMessage(new Error('relogin'))).toBeNull()
  })
})

const call = (fields: Record<string, unknown>) => ({
  type: 'collabAgentToolCall',
  id: 'a1',
  tool: 'spawnAgent',
  status: 'inProgress',
  senderThreadId: 'p',
  receiverThreadIds: [],
  prompt: null,
  model: null,
  agentsStates: {},
  ...fields
})

describe('the tools of an agent that works with subagents', () => {
  it('shows a collab call as a tool call named like the tool, with its task and the model asked for', () => {
    expect(itemOf(call({ prompt: 'Read a.txt', model: 'gpt-5' }), 'started')).toEqual({
      id: 't1:a1',
      at: AT,
      kind: 'tool_call',
      name: 'spawn_agent',
      input: { prompt: 'Read a.txt', model: 'gpt-5' },
      status: 'running',
      resultSummary: null
    })
  })

  it('leaves out a task that is missing and a model that is empty, and clips a long task', () => {
    expect(itemOf(call({ model: '' }), 'started')).toMatchObject({ input: {} })
    expect(itemOf(call({ prompt: 'p'.repeat(350) }), 'started')).toMatchObject({ input: { prompt: `${'p'.repeat(300)}…` } })
  })

  it('writes any tool name in snake case, whatever Codex adds', () => {
    expect(itemOf(call({ tool: 'wait' }))).toMatchObject({ name: 'wait' })
    expect(itemOf(call({ tool: 'closeAgent' }))).toMatchObject({ name: 'close_agent' })
    expect(itemOf(call({ tool: 'interruptAgent' }))).toMatchObject({ name: 'interrupt_agent' })
    expect(itemOf(call({ tool: undefined }))).toMatchObject({ name: 'collab_agent' })
  })

})

describe('what the tools of an agent that works with subagents report', () => {
  it('reports what the subagents said, or that the call completed, or that it failed', () => {
    const states = { x: { status: 'completed', message: 'Found alpha.' }, y: { status: 'errored', message: 'No file.' }, z: { status: 'running', message: null } }

    expect(itemOf(call({ status: 'completed', agentsStates: states }))).toMatchObject({ status: 'completed', resultSummary: 'Found alpha.\nNo file.' })
    expect(itemOf(call({ status: 'completed' }))).toMatchObject({ status: 'completed', resultSummary: 'Completed' })
    expect(itemOf(call({ status: 'failed' }))).toMatchObject({ status: 'failed', resultSummary: 'Failed' })
    expect(itemOf(call({ status: 'interrupted', agentsStates: { x: { status: 'interrupted', message: 'Stopped.' } } }))).toMatchObject({
      status: 'failed',
      resultSummary: 'Stopped.'
    })
  })

  it('clips what the subagents said', () => {
    const states = { x: { status: 'completed', message: 'm'.repeat(350) } }

    expect(itemOf(call({ status: 'completed', agentsStates: states }))).toMatchObject({ resultSummary: `${'m'.repeat(300)}…` })
  })

  it('shows the start of a v2 subagent as a finished spawn_agent call, and the rest of its activity as nothing', () => {
    const activity = (kind: string) => ({ type: 'subAgentActivity', id: 'call_9', kind, agentThreadId: 'c', agentPath: '/root/reader' })

    expect(itemOf(activity('started'))).toEqual({
      id: 't1:call_9',
      at: AT,
      kind: 'tool_call',
      name: 'spawn_agent',
      input: { agent: '/root/reader' },
      status: 'completed',
      resultSummary: null
    })
    expect(itemOf({ ...activity('started'), agentPath: undefined })).toMatchObject({ input: {} })
    expect(itemOf(activity('started'), 'started')).toBeNull()
    expect(itemOf(activity('completed'))).toBeNull()
    expect(itemOf(activity('interrupted'))).toBeNull()
    expect(itemOf(activity('interacted'))).toBeNull()
  })
})
