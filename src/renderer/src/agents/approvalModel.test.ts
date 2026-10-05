import { describe, expect, it } from 'vitest'
import type { ApprovalRequestItem, ChatItem } from '../../../shared/agents/chat'
import { answerView, approvalDetail, transcriptRows } from './approvalModel'

const AT = '2026-03-01T10:00:00.000Z'
const FOLDER = '/home/u/alpha'

type Outcome = 'allow_once' | 'allow_chat' | 'deny' | 'cancelled'
type DecisionItem = Extract<ChatItem, { kind: 'approval_decision' }>

function request(patch: Partial<ApprovalRequestItem> = {}): ApprovalRequestItem {
  return { id: 'r1', at: AT, kind: 'approval_request', requestId: 'req', category: 'command', tool: 'Bash', summary: 'Run npm test', ...patch }
}

function decision(requestId: string, outcome: Outcome, automatic?: boolean): DecisionItem {
  return { id: `d_${requestId}`, at: AT, kind: 'approval_decision', requestId, decision: outcome, ...(automatic === undefined ? {} : { automatic }) }
}

describe('approvalDetail for commands', () => {
  it('shows the exact command and, when the vendor names none, the chat folder as the working directory', () => {
    const detail = approvalDetail(request({ input: { command: 'npm test -- --run', description: 'Run the tests' } }), FOLDER)
    expect(detail).toMatchObject({ heading: 'Run a command', command: 'npm test -- --run', workingDirectory: FOLDER, note: 'Run the tests', files: [], diff: null })
  })

  it('uses the working directory the vendor sent, and a command given as an argument list', () => {
    const detail = approvalDetail(request({ input: { command: ['git', 'status'], cwd: '/work/sub' } }), FOLDER)
    expect(detail).toMatchObject({ command: 'git status', workingDirectory: '/work/sub' })
  })

  it('falls back to the summary when the request carries no command', () => {
    const detail = approvalDetail(request(), FOLDER)
    expect(detail).toMatchObject({ command: null, workingDirectory: FOLDER, summary: 'Run npm test' })
  })
})

describe('approvalDetail for edits', () => {
  const edit = (input: ApprovalRequestItem['input'], patch: Partial<ApprovalRequestItem> = {}): ReturnType<typeof approvalDetail> =>
    approvalDetail(request({ category: 'file_edit', tool: 'Edit', summary: 'Edit /src/a.ts', ...patch, input }), FOLDER)

  it('names the file and summarizes a replacement, with the changed lines', () => {
    const detail = edit({ file_path: '/src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2\nconst b = 3' })
    expect(detail).toMatchObject({ heading: 'Edit a file', files: ['/src/a.ts'], command: null, workingDirectory: null })
    expect(detail.diff).toEqual({
      text: 'Replaces 1 line with 2 lines',
      lines: [
        { sign: '-', text: 'const a = 1' },
        { sign: '+', text: 'const a = 2' },
        { sign: '+', text: 'const b = 3' }
      ],
      hidden: 0
    })
  })

  it('summarizes a whole-file write and a multi-edit', () => {
    expect(edit({ file_path: '/src/new.ts', content: 'a\nb\nc' }, { tool: 'Write' }).diff?.text).toBe('Writes 3 lines')
    const multi = edit({
      file_path: '/src/a.ts',
      edits: [
        { old_string: 'x', new_string: 'y' },
        { old_string: 'p\nq', new_string: 'r' }
      ]
    })
    expect(multi.diff?.text).toBe('Replaces 3 lines with 2 lines in 2 edits')
  })

  it('says only what was added or removed when a side is empty', () => {
    expect(edit({ file_path: '/a', old_string: '', new_string: 'x\ny' }).diff?.text).toBe('Adds 2 lines')
    expect(edit({ file_path: '/a', old_string: 'x', new_string: '' }).diff?.text).toBe('Removes 1 line')
  })

  it('keeps the preview short and counts what it left out', () => {
    const big = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')
    const detail = edit({ file_path: '/a', content: big }, { tool: 'Write' })
    expect(detail.diff?.lines).toHaveLength(12)
    expect(detail.diff?.hidden).toBe(18)
  })

  it('lists the files of a vendor that sends only paths, and says so when there are several', () => {
    const detail = edit({ files: ['/a.ts', '/b.ts'], reason: 'Needs write access' }, { tool: 'apply_patch', summary: 'Edit 2 files (/a.ts, /b.ts)' })
    expect(detail).toMatchObject({ heading: 'Edit files', files: ['/a.ts', '/b.ts'], diff: null, note: 'Needs write access' })
  })

  it('renders a request with no detail at all from its summary alone', () => {
    const detail = edit(undefined)
    expect(detail).toMatchObject({ heading: 'Edit a file', files: [], diff: null, note: null, summary: 'Edit /src/a.ts' })
  })
})

describe('approvalDetail for other requests', () => {
  it('names the tool and keeps the summary', () => {
    const detail = approvalDetail(request({ category: 'other', tool: 'WebFetch', summary: 'Use WebFetch', input: { url: 'https://example.com' } }), FOLDER)
    expect(detail).toMatchObject({ heading: 'Use WebFetch', command: null, workingDirectory: null, files: [], summary: 'Use WebFetch' })
  })

  it('ignores detail that is not text', () => {
    const detail = approvalDetail(request({ category: 'file_edit', input: { file_path: 7, command: { a: 1 }, files: [1, 'ok'], edits: 'no' } }), FOLDER)
    expect(detail).toMatchObject({ files: ['ok'], command: null, diff: null })
  })
})

describe('transcriptRows', () => {
  it('puts an answer on its request and drops the decision row, keeping the order of everything else', () => {
    const answer = decision('a', 'allow_once')
    const first: ChatItem = { id: 'u1', at: AT, kind: 'user_message', text: 'hi' }
    const second: ChatItem = { id: 'u2', at: AT, kind: 'user_message', text: 'again' }
    const rows = transcriptRows([first, request({ requestId: 'a' }), second, answer])
    expect(rows.map((row) => row.entry.id)).toEqual(['u1', 'r1', 'u2'])
    expect(rows[1]?.answer).toBe(answer)
  })

  it('leaves a request without a decision unanswered, and keeps a decision whose request is not in the transcript', () => {
    const orphan = decision('gone', 'cancelled')
    const rows = transcriptRows([request({ requestId: 'b' }), orphan])
    expect(rows.map((row) => [row.entry.id, row.answer])).toEqual([
      ['r1', null],
      [orphan.id, null]
    ])
  })
})

describe('answerView', () => {
  it('words each decision, with the state color it shares with the rest of the app', () => {
    expect(answerView(decision('a', 'allow_once'))).toMatchObject({ state: 'accepted', label: 'Allowed once', detail: null })
    expect(answerView(decision('a', 'allow_chat'))).toMatchObject({ state: 'accepted', label: 'Allowed for this chat' })
    expect(answerView(decision('a', 'deny'))).toMatchObject({ state: 'blocked', label: 'Denied' })
  })

  it('says when an earlier Allow for this chat answered, and when no answer reached the agent', () => {
    expect(answerView(decision('a', 'allow_chat', true))).toMatchObject({
      label: 'Allowed for this chat',
      detail: 'Answered automatically by an earlier Allow for this chat.'
    })
    expect(answerView(decision('a', 'cancelled'))).toMatchObject({ state: 'canceled', label: 'Cancelled', detail: 'No answer reached the agent.' })
  })
})
