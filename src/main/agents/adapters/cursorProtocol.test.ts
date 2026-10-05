import { describe, expect, it } from 'vitest'
import { chooseOptionId, isSafeModelId, parseModelList, permissionDetails, summarizeInput, toolNameOf } from './cursorProtocol'

const OPTIONS = [
  { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
]

describe('isSafeModelId', () => {
  it('accepts plain and parameterised model ids and nothing that cmd.exe or an option parser would act on', () => {
    expect(isSafeModelId('gpt-5.4[reasoning=medium,fast=false]')).toBe(true)
    expect(isSafeModelId('claude-4.5-sonnet')).toBe(true)
    expect(isSafeModelId('a & b')).toBe(false)
    expect(isSafeModelId('--force')).toBe(false)
    expect(isSafeModelId('x'.repeat(201))).toBe(false)
  })
})

describe('parseModelList', () => {
  const OUTPUT = [
    'Available models',
    '',
    'auto - Auto',
    'composer-2.5 - Composer 2.5 (current)',
    'gpt-5.3-codex - GPT-5.3 Codex  (default)',
    'claude-opus-4-7[thinking=true,effort=high] - Opus 4.7 Thinking High',
    '',
    'Tip: use --model <id> to switch.'
  ].join('\n')

  it('reads "id - label" lines and drops headers, tips and the current/default markers', () => {
    expect(parseModelList(OUTPUT)).toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'composer-2.5', label: 'Composer 2.5' },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { id: 'claude-opus-4-7[thinking=true,effort=high]', label: 'Opus 4.7 Thinking High' }
    ])
  })

  it('strips terminal colour codes and reads tab separated and bare id lines', () => {
    const esc = String.fromCharCode(27)

    expect(parseModelList(`${esc}[1mo3${esc}[0m\tO3\ngemini-3-pro\r\n`)).toEqual([
      { id: 'o3', label: 'O3' },
      { id: 'gemini-3-pro', label: 'gemini-3-pro' }
    ])
  })

  it('keeps each id once and leaves out ids that could not be launched safely', () => {
    const output = ['a - First', 'a - Second', 'b&calc - Hostile', 'ok - Fine'].join('\n')

    expect(parseModelList(output)).toEqual([
      { id: 'a', label: 'First' },
      { id: 'ok', label: 'Fine' }
    ])
  })

  it('finds nothing in output without models', () => {
    expect(parseModelList('Not signed in. Run `agent login`.\n')).toEqual([])
    expect(parseModelList('')).toEqual([])
  })
})

describe('chooseOptionId', () => {
  it('maps the three decisions to the option of that kind', () => {
    expect(chooseOptionId(OPTIONS, 'allow_once')).toBe('allow-once')
    expect(chooseOptionId(OPTIONS, 'allow_chat')).toBe('allow-always')
    expect(chooseOptionId(OPTIONS, 'deny')).toBe('reject-once')
  })

  it('goes by kind, not by what the option is called', () => {
    const renamed = [
      { optionId: 'x1', kind: 'reject_once' },
      { optionId: 'x2', kind: 'allow_always' },
      { optionId: 'x3', kind: 'allow_once' }
    ]

    expect(chooseOptionId(renamed, 'allow_once')).toBe('x3')
    expect(chooseOptionId(renamed, 'allow_chat')).toBe('x2')
    expect(chooseOptionId(renamed, 'deny')).toBe('x1')
  })

  it('goes by the documented option id when an option has no kind', () => {
    expect(chooseOptionId([{ optionId: 'reject-once' }, { optionId: 'allow-once' }], 'deny')).toBe('reject-once')
  })

  it('settles for allowing once when there is no way to allow always, and for reject always when once is missing', () => {
    expect(chooseOptionId([OPTIONS[0], OPTIONS[2]], 'allow_chat')).toBe('allow-once')
    expect(chooseOptionId([{ optionId: 'r', kind: 'reject_always' }], 'deny')).toBe('r')
  })

  it('never turns a refusal into an allowance, nor an allowance into a refusal', () => {
    expect(chooseOptionId([OPTIONS[0], OPTIONS[1]], 'deny')).toBeNull()
    expect(chooseOptionId([OPTIONS[2]], 'allow_once')).toBeNull()
  })

  it('skips option entries that are not options', () => {
    expect(chooseOptionId([null, 'x', { optionId: 5 }, { name: 'no id' }], 'allow_once')).toBe('allow-once')
  })

  it('uses the documented ids when the request listed no options at all', () => {
    expect(chooseOptionId(undefined, 'allow_once')).toBe('allow-once')
    expect(chooseOptionId([], 'allow_chat')).toBe('allow-always')
    expect(chooseOptionId('nonsense', 'deny')).toBe('reject-once')
  })
})

describe('permissionDetails', () => {
  it('files commands, edits and everything else under the three approval categories', () => {
    const detail = (kind: string) => permissionDetails({ toolCall: { toolCallId: 'c', title: 'T', kind } })

    expect(detail('execute')).toMatchObject({ category: 'command', tool: 'Shell' })
    expect(detail('edit')).toMatchObject({ category: 'file_edit', tool: 'Edit' })
    expect(detail('delete')).toMatchObject({ category: 'file_edit', tool: 'Delete' })
    expect(detail('move')).toMatchObject({ category: 'file_edit', tool: 'Move' })
    expect(detail('read')).toMatchObject({ category: 'other', tool: 'Read' })
    expect(detail('fetch')).toMatchObject({ category: 'other', tool: 'Fetch' })
    expect(detail('other')).toMatchObject({ category: 'other', tool: 'T' })
  })

  it('carries the call id, title and raw input', () => {
    const details = permissionDetails({
      toolCall: { toolCallId: 'call_9', title: 'Run `ls`', kind: 'execute', rawInput: { command: 'ls', cwd: '/work' } }
    })

    expect(details).toEqual({
      toolCallId: 'call_9',
      category: 'command',
      tool: 'Shell',
      summary: 'Run `ls`',
      input: { command: 'ls', cwd: '/work' }
    })
  })
})

describe('permissionDetails: tools and missing parts', () => {
  it('names an MCP tool by its server and tool when the call says so', () => {
    const details = permissionDetails({
      toolCall: {
        toolCallId: 'c',
        title: 'Tool call',
        kind: 'other',
        rawInput: { providerIdentifier: 'darkmechanicus', toolName: 'get_ticket' }
      }
    })

    expect(details.tool).toBe('darkmechanicus:get_ticket')
  })

  it('still describes a request that arrived without its tool call', () => {
    expect(permissionDetails({})).toEqual({
      toolCallId: null,
      category: 'other',
      tool: 'tool',
      summary: 'Cursor asks to use a tool',
      input: undefined
    })
    expect(permissionDetails('garbage')).toMatchObject({ category: 'other', tool: 'tool' })
  })

  it('keeps a long title and long input values to a size the transcript can hold', () => {
    const details = permissionDetails({
      toolCall: {
        toolCallId: 'c',
        title: 'x'.repeat(1000),
        kind: 'edit',
        rawInput: { content: 'y'.repeat(50_000), nested: { deep: 'z'.repeat(50_000) } }
      }
    })

    expect(details.summary.length).toBeLessThan(400)
    const input = JSON.stringify(details.input)
    expect(input.length).toBeLessThan(10_000)
    expect(input).toContain('y')
  })
})

describe('toolNameOf', () => {
  it('names a call by its kind, falling back to its title, and then to a plain word', () => {
    expect(toolNameOf({ kind: 'search', title: 'Grep' })).toBe('Search')
    expect(toolNameOf({ kind: 'other', title: 'Do a thing' })).toBe('Do a thing')
    expect(toolNameOf({})).toBe('tool')
  })
})

describe('summarizeInput', () => {
  it('keeps numbers, booleans, nulls and short lists, and cuts what is deeper or longer than a transcript needs', () => {
    const input = { n: 1, ok: true, none: null, list: Array.from({ length: 80 }, (_, index) => index), deep: { a: { b: { c: { d: 'x' } } } } }

    const summary = summarizeInput(input)

    expect(summary).toMatchObject({ n: 1, ok: true, none: null, deep: { a: { b: { c: '…' } } } })
    expect(summary?.list).toHaveLength(50)
  })

  it('has nothing to say about a raw input that is not an object', () => {
    expect(summarizeInput('ls')).toBeUndefined()
    expect(summarizeInput(['ls'])).toBeUndefined()
    expect(summarizeInput(undefined)).toBeUndefined()
  })
})

describe('parseModelList: labels that say nothing', () => {
  it('labels a model by its id when its label is only a marker', () => {
    expect(parseModelList('auto - (current)\ncomposer-2 - (default, current)\nnamed - Named')).toEqual([
      { id: 'auto', label: 'auto' },
      { id: 'composer-2', label: 'composer-2' },
      { id: 'named', label: 'Named' }
    ])
  })
})
