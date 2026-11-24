import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { agentChanges, FILE_TOOLS } from './agentChanges'

type Tool = Extract<ChatItem, { kind: 'tool_call' }>
const chat = { kind: 'chat' } as const
function call(id: string, name: string, input: Tool['input'], extra: Partial<Tool> = {}): Tool {
  return { id, at: '2026-11-24T00:00:00.000Z', kind: 'tool_call', name, input, status: 'completed', resultSummary: null, ...extra }
}
function thread(id: string, threadId?: string): ChatItem {
  return { id, at: '2026-11-24T00:00:00.000Z', kind: 'thread', label: id, parentItemId: `spawn-${id}`, state: 'done', threadId }
}

function goldenCalls(protocol: string): ChatItem[] {
  const items: ChatItem[] = []
  const lines = readFileSync(join(process.cwd(), 'src', 'main', 'agentChat', '__fixtures__', protocol, 'edit.out.jsonl'), 'utf8').trim().split(/\r?\n/)
  for (const line of lines) {
    const frame = JSON.parse(line)
    if (frame.type === 'assistant') {
      const tools = frame.message.content.filter((block: { type: string }) => block.type === 'tool_use')
      for (const block of tools) items.push(call(block.id, block.name, block.input))
    } else if (frame.type === 'tool_execution_start') {
      items.push(call(frame.toolCallId, frame.toolName, frame.args))
    }
  }
  return items
}

  it('counts two Edits and one Write once, using the newest tool and newest-first order', () => {
    expect(agentChanges([
      call('1', 'Edit', { file_path: 'C:\\Repo\\src\\a.ts' }),
      call('2', 'Edit', { file_path: 'src/a.ts' }),
      call('3', 'Edit', { file_path: 'b.ts' }),
      call('4', 'Write', { file_path: 'c:/repo/src/a.ts' })
    ], chat, 'c:/repo')).toEqual([
      { path: 'src/a.ts', absolutePath: 'c:/repo/src/a.ts', inFolder: true, tool: 'Write', kind: 'written', count: 3 },
      { path: 'b.ts', absolutePath: 'c:/repo/b.ts', inFolder: true, tool: 'Edit', kind: 'edited', count: 1 }
    ])
  })

  it('derives calls from both edit golden fixtures and supports MultiEdit', () => {
    const items = ['claude', 'omp'].flatMap(goldenCalls)
    items.push(call('multi', 'MultiEdit', { file_path: 'multi.ts' }))
    expect(FILE_TOOLS).toEqual({ Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path', edit: 'path', write: 'path' })
    expect(agentChanges(items, chat, 'C:/fixture/repo')).toEqual([
      { path: 'multi.ts', absolutePath: 'C:/fixture/repo/multi.ts', inFolder: true, tool: 'MultiEdit', kind: 'edited', count: 1 },
      { path: 'b.txt', absolutePath: 'C:/fixture/repo/b.txt', inFolder: true, tool: 'write', kind: 'written', count: 2 },
      { path: 'a.txt', absolutePath: 'C:/fixture/repo/a.txt', inFolder: true, tool: 'edit', kind: 'edited', count: 2 },
      { path: 'book.ipynb', absolutePath: 'C:/fixture/repo/book.ipynb', inFolder: true, tool: 'NotebookEdit', kind: 'edited', count: 1 }
    ])
  })

  it('ignores failed, running, denied, cancelled, shell and malformed path calls', () => {
    const items = (['failed', 'running', 'denied', 'cancelled'] as const).map(status => call(status, 'Edit', { file_path: `${status}.ts` }, { status }))
    items.push(call('shell', 'Bash', { file_path: 'shell.ts' }), call('numeric', 'Edit', { file_path: 42 }), call('missing', 'Write', {}), call('empty', 'edit', { path: '' }), call('blank', 'write', { path: '  ' }), call('null', 'Edit', { file_path: null }), call('prototype', 'constructor', { file_path: 'bad' }))
    expect(agentChanges(items, chat, '/repo')).toEqual([])
  })

  it('includes nested helpers only in their worker scope and all threads in chat scope', () => {
    const items = [
      thread('helper', 'worker'), thread('deep', 'helper'), thread('worker'), thread('other'),
      call('root', 'Edit', { file_path: 'root' }),
      call('worker-file', 'Edit', { file_path: 'worker' }, { threadId: 'worker' }),
      call('helper-file', 'Edit', { file_path: 'helper' }, { threadId: 'helper' }),
      call('deep-file', 'Write', { file_path: 'deep' }, { threadId: 'deep' }),
      call('other-file', 'Edit', { file_path: 'other' }, { threadId: 'other' })
    ]
    expect(agentChanges(items, { kind: 'thread', threadId: 'worker' }, '/repo').map(row => row.path)).toEqual(['deep', 'helper', 'worker'])
    expect(agentChanges(items, chat, '/repo').map(row => row.path)).toEqual(['other', 'deep', 'helper', 'worker', 'root'])
    expect(agentChanges(items, { kind: 'thread', threadId: 'absent' }, '/repo')).toEqual([])
  })

  it('normalizes Windows paths case-insensitively and leaves outside paths absolute', () => {
    expect(agentChanges([call('a', 'Edit', { file_path: 'C:\\Repo\\src\\a.ts' }), call('b', 'Write', { file_path: 'D:\\other\\b.ts' })], chat, 'c:/repo')).toEqual([
      { path: 'D:/other/b.ts', absolutePath: 'D:/other/b.ts', inFolder: false, tool: 'Write', kind: 'written', count: 1 },
      { path: 'src/a.ts', absolutePath: 'C:/Repo/src/a.ts', inFolder: true, tool: 'Edit', kind: 'edited', count: 1 }
    ])
  })

  it('handles POSIX paths, folder boundaries, relative escapes and root folders', () => {
    const paths = ['/home/u/repo/src/a.ts', '/home/u/repository/b.ts', '/Home/u/repo/a.ts', '../outside.ts', './src/b.ts']
    expect(agentChanges(paths.map((path, i) => call(String(i), 'write', { path })), chat, '/home/u/repo/').map(({ path, inFolder }) => ({ path, inFolder }))).toEqual([
      { path: 'src/b.ts', inFolder: true }, { path: '/home/u/outside.ts', inFolder: false },
      { path: '/Home/u/repo/a.ts', inFolder: false }, { path: '/home/u/repository/b.ts', inFolder: false }, { path: 'src/a.ts', inFolder: true }
    ])
    expect(agentChanges([call('root', 'write', { path: '/a.ts' })], chat, '/')[0].path).toBe('a.ts')
    expect(agentChanges([call('root', 'write', { path: 'C:\\a.ts' })], chat, 'c:/')[0].path).toBe('a.ts')
  })

  it('marks every project-less path outside and preserves relative paths without inventing a cwd', () => {
    const items = ['C:\\Repo\\a.ts', '/repo/a.ts', 'relative.ts'].map((path, i) => call(String(i), 'write', { path }))
    expect(agentChanges(items, chat, null).map(({ path, absolutePath, inFolder }) => ({ path, absolutePath, inFolder }))).toEqual([
      { path: 'relative.ts', absolutePath: 'relative.ts', inFolder: false },
      { path: '/repo/a.ts', absolutePath: '/repo/a.ts', inFolder: false },
      { path: 'C:/Repo/a.ts', absolutePath: 'C:/Repo/a.ts', inFolder: false }
    ])
  })
