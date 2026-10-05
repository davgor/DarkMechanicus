/**
 * An orchestrator chat as the chat store records it: one `ChatItem` per transcript line, in the order
 * the lines were appended (a tool call is written again, by the same id, when it finishes, and a thread
 * when it ends). Start run launched the chat for `RUN_ID`. Its main thread starts the run, claims two
 * tickets and starts a worker subagent for each, handing it the ticket's execution packet; the two
 * workers run side by side, heartbeat, and submit.
 *
 * Composed from recorded shapes, not captured live. The item shapes are the ones the Claude adapter
 * emits (`adapters/claudeTranscript.ts`): tool calls `claude_tool_<tool_use id>` with the input as the
 * model gave it and the result text cut to 500 characters, a `thread` item `claude_thread_<tool_use id>`
 * right after its spawning Agent call (its `parentItemId`), and the subagent's items carrying the
 * thread's id. The Agent input (`description`, `subagent_type`, `run_in_background`, `prompt`) is the
 * one the DM-96 recording of two parallel subagents shows (`adapters/__mocks__/claudeSubagents.ts`), and
 * the Dark Mechanicus results are the server's JSON text (`src/mcp/result.ts`). The ids are made up,
 * and the claim tokens in the packets are masked, as stored. Not shipped.
 */
import type { ChatItem } from '../../../shared/agents/chat'
import { CLAIM_TOKEN_MASK } from '../claimTokenMask'

export const RUN_ID = 'rn_01k8zq3v7c2m5n9p4r6t8w0xyb'
export const ATTEMPT_A = 'at_01k8zq4a1b2c3d4e5f6g7h8j9k'
export const ATTEMPT_B = 'at_01k8zq5m2n3p4q5r6s7t8v9w0x'
const EPIC_ID = 'ep_01k8zq2a3b4c5d6e7f8g9h0j1k'
const TICKET_A = 'tk_01k8zq2m3n4p5q6r7s8t9v0w1x'
const TICKET_B = 'tk_01k8zq2y3z4a5b6c7d8e9f0g1h'

const SPAWN_A = 'toolu_01Hq7XbN2vKpR4sT9wYcLm3D'
const SPAWN_B = 'toolu_01Tz5FgJ8kWqA2nV6xBdPe7R'
/** The worker threads, as the adapter names them after their spawning Agent calls. */
export const THREAD_A = `claude_thread_${SPAWN_A}`
export const THREAD_B = `claude_thread_${SPAWN_B}`

const AT = '2026-10-05T12:00:00.000Z'
const MAX_RESULT_CHARS = 500

/** A tool result as the adapter keeps it: the text, cut to 500 characters. */
function resultText(payload: unknown): string {
  const text = JSON.stringify(payload)
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text
}

type ToolCall = Extract<ChatItem, { kind: 'tool_call' }>

function call(id: string, name: string, input: ToolCall['input'], threadId?: string): ToolCall {
  return { id: `claude_tool_${id}`, at: AT, kind: 'tool_call', name, input, status: 'running', resultSummary: null, ...(threadId === undefined ? {} : { threadId }) }
}

function done(item: ToolCall, result: unknown): ToolCall {
  return { ...item, status: 'completed', resultSummary: typeof result === 'string' ? result : resultText(result) }
}

const runView = {
  id: RUN_ID,
  number: 1,
  epicId: EPIC_ID,
  revisionId: 'rv_01k8zq2c3d4e5f6g7h8j9k0m1n',
  revisionNumber: 3,
  state: 'running',
  activeSprintId: 'sp_01k8zq2p3q4r5s6t7v8w9x0y1z',
  activeSprintOrdinal: 1,
  sprintCount: 2,
  host: { label: 'Claude Code desktop', type: 'claude-code', catalogId: 'hc_01k8zq2e3f4g5h6j7k8m9n0p1q' },
  skillVersion: '0.16.0',
  ownerMachineId: 'machine-1',
  ownedByThisMachine: true,
  pauseReason: null,
  autoContinue: false,
  createdAt: AT,
  startedAt: AT,
  updatedAt: AT,
  endedAt: null,
  counts: { total: 6, ready: 2, running: 0, accepted: 0 }
}

function claimResult(attemptId: string, ticketId: string): unknown {
  return {
    ok: true,
    data: {
      attempt: {
        id: attemptId,
        runId: RUN_ID,
        ticketId,
        number: 1,
        kind: 'work',
        state: 'running',
        fencingToken: 1,
        worker: { label: 'Claude Code subagent', modelId: 'claude-sonnet-5', hostId: 'claude-code-desktop', effort: 'medium' }
      },
      packet: { runId: RUN_ID, attemptId, claimToken: CLAIM_TOKEN_MASK, heartbeatIntervalSeconds: 600 }
    }
  }
}

function claim(id: string, ticketId: string): ToolCall {
  return call(id, 'mcp__darkmechanicus__claim_ticket', {
    runId: RUN_ID,
    ticketId,
    worker: { label: 'Claude Code subagent', modelId: 'claude-sonnet-5', hostId: 'claude-code-desktop', catalogRevision: '2026-10-05', effort: 'medium' }
  })
}

/** What the orchestrator tells a worker: the skill to follow and the ticket's execution packet, its token masked as stored. */
function workerPrompt(ticket: string, attemptId: string, ticketId: string): string {
  const packet = { runId: RUN_ID, attemptId, claimToken: CLAIM_TOKEN_MASK, heartbeatIntervalSeconds: 600, ticket: { id: ticketId, title: `${ticket}: the ticket` } }
  return [
    `You are the Dark Mechanicus worker for ticket ${ticket}. Follow the darkmechanicus-worker skill.`,
    'Work in a worktree of your own, branched from the sprint integration branch.',
    '',
    'Execution packet:',
    JSON.stringify(packet),
    '',
    'Call heartbeat_attempt while you work, then submit_attempt with your outputs and evidence.'
  ].join('\n')
}

function spawn(id: string, ticket: string, attemptId: string, ticketId: string): ToolCall {
  return call(id, 'Agent', {
    description: `${ticket} worker`,
    subagent_type: 'general-purpose',
    run_in_background: false,
    prompt: workerPrompt(ticket, attemptId, ticketId)
  })
}

function thread(spawnId: string, label: string, state: 'running' | 'done'): ChatItem {
  return { id: `claude_thread_${spawnId}`, at: AT, kind: 'thread', parentItemId: `claude_tool_${spawnId}`, label, state }
}

function heartbeat(id: string, attemptId: string, threadId: string): ToolCall {
  return call(id, 'mcp__darkmechanicus__heartbeat_attempt', { attemptId, claimToken: CLAIM_TOKEN_MASK, leaseSeconds: 3600, progress: { note: 'writing the tests' } }, threadId)
}

function submit(id: string, attemptId: string, threadId: string): ToolCall {
  return call(id, 'mcp__darkmechanicus__submit_attempt', { attemptId, claimToken: CLAIM_TOKEN_MASK, outputs: { summary: 'Done.', branch: 'work' } }, threadId)
}

const startRun = call('toolu_01Start8RunQ2wE4rT6yU8iO0p', 'mcp__darkmechanicus__start_run', { epicId: EPIC_ID })
const claimA = claim('toolu_01ClaimAq3W5eR7tY9uI1oP2a', TICKET_A)
const claimB = claim('toolu_01ClaimBz4X6cV8bN0mQ2wE4r', TICKET_B)
const spawnA = spawn(SPAWN_A, 'DM-12', ATTEMPT_A, TICKET_A)
const spawnB = spawn(SPAWN_B, 'DM-13', ATTEMPT_B, TICKET_B)
const beatA = heartbeat('toolu_01BeatAa1S2d3F4g5H6j7K8l', ATTEMPT_A, THREAD_A)
const beatB = heartbeat('toolu_01BeatBb9Z8x7C6v5B4n3M2q', ATTEMPT_B, THREAD_B)
const submitA = submit('toolu_01SubmitA1q2W3e4R5t6Y7u8', ATTEMPT_A, THREAD_A)
const submitB = submit('toolu_01SubmitB9o8I7u6Y5t4R3e2', ATTEMPT_B, THREAD_B)
const submitted = { ok: true, data: { state: 'submitted' } }

export const ORCHESTRATOR_CHAT_ITEMS: readonly ChatItem[] = [
  {
    id: 'item_kickoff',
    at: AT,
    kind: 'user_message',
    text: `Run this Dark Mechanicus epic as its orchestrator.\n\nEpic: Agents (${EPIC_ID})\nBranch: agents\nRun: ${RUN_ID}, queued from the desktop app`
  },
  { id: 'claude_msg_01_0', at: AT, kind: 'assistant_text', text: 'Starting the queued run.' },
  startRun,
  done(startRun, { ok: true, data: runView }),
  claimA,
  done(claimA, claimResult(ATTEMPT_A, TICKET_A)),
  claimB,
  done(claimB, claimResult(ATTEMPT_B, TICKET_B)),
  spawnA,
  thread(SPAWN_A, 'DM-12 worker', 'running'),
  spawnB,
  thread(SPAWN_B, 'DM-13 worker', 'running'),
  beatA,
  beatB,
  done(beatA, { ok: true, data: { id: ATTEMPT_A, state: 'running' } }),
  done(beatB, { ok: true, data: { id: ATTEMPT_B, state: 'running' } }),
  { id: 'claude_msg_02_0', at: AT, kind: 'assistant_text', text: 'Tests are written and pass.', threadId: THREAD_B },
  submitB,
  done(submitB, submitted),
  submitA,
  done(submitA, submitted),
  thread(SPAWN_B, 'DM-13 worker', 'done'),
  done(spawnB, 'DM-13 is submitted: two commits on dm-13, the targeted checks pass.'),
  thread(SPAWN_A, 'DM-12 worker', 'done'),
  done(spawnA, 'DM-12 is submitted: one commit on dm-12, the targeted checks pass.'),
  { id: 'claude_msg_03_0', at: AT, kind: 'assistant_text', text: 'Both workers submitted; reviewing their results.' }
]
