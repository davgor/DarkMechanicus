/**
 * ACP exchanges as `agent acp` speaks them, in the shapes the Cursor ACP page and the Agent Client
 * Protocol specification give. Built from those documents, not captured from a live CLI (the
 * Cursor CLI is not installed where these were written). Not shipped.
 */
import { resolve } from 'node:path'
import type { McpServerSpec } from '../../../shared/agents/chat'
import { agent, client, type Frame } from './replayAcpAgent'

export const FOLDER = resolve('/work/repo')
export const CLIENT_VERSION = '9.9.9'

export const DM_SERVER: McpServerSpec = {
  command: 'node',
  args: ['mcp.js', '--role', 'worker', '--label', 'Cursor · Chat'],
  env: { DM_HOME: '/state' }
}

/** The same server as ACP's `mcpServers` lists it. */
export const ACP_DM_SERVER = {
  name: 'darkmechanicus',
  command: 'node',
  args: ['mcp.js', '--role', 'worker', '--label', 'Cursor · Chat'],
  env: [{ name: 'DM_HOME', value: '/state' }]
}

const PERMISSION_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
]

/** initialize + authenticate, request ids 1 and 2. */
export function handshake(loadSupported = true): Frame[] {
  return [
    client({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'dark-mechanicus', version: CLIENT_VERSION }
      }
    }),
    agent({
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: loadSupported,
          promptCapabilities: { image: true },
          mcpCapabilities: { http: true, sse: true }
        },
        authMethods: [{ id: 'cursor_login', name: 'Cursor Login', description: 'Authenticate using existing Cursor login' }]
      }
    }),
    client({ id: 2, method: 'authenticate', params: { methodId: 'cursor_login' } }),
    agent({ id: 2, result: {} })
  ]
}

export function newSession(id: number, sessionId: string): Frame[] {
  return [
    client({ id, method: 'session/new', params: { cwd: FOLDER, mcpServers: [ACP_DM_SERVER] } }),
    agent({ id, result: { sessionId, modes: { currentModeId: 'agent', availableModes: [] } } })
  ]
}

/** session/load: the history is replayed as updates before the (null) answer. */
export function loadSession(id: number, sessionId: string, history: Frame[] = []): Frame[] {
  return [
    client({ id, method: 'session/load', params: { sessionId, cwd: FOLDER, mcpServers: [ACP_DM_SERVER] } }),
    ...history,
    agent({ id, result: null })
  ]
}

export function failedLoad(id: number, sessionId: string): Frame[] {
  return [
    client({ id, method: 'session/load', params: { sessionId, cwd: FOLDER, mcpServers: [ACP_DM_SERVER] } }),
    agent({ id, error: { code: -32602, message: 'Session not found' } })
  ]
}

export function update(sessionId: string, body: Record<string, unknown>): Frame {
  return agent({ method: 'session/update', params: { sessionId, update: body } })
}

export function say(sessionId: string, text: string, messageId?: string): Frame {
  const content = { type: 'text', text }
  return update(sessionId, { sessionUpdate: 'agent_message_chunk', ...(messageId === undefined ? {} : { messageId }), content })
}

export function prompt(id: number, sessionId: string, text: string): Frame {
  return client({ id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } })
}

export function turnEnd(id: number, stopReason = 'end_turn'): Frame {
  return agent({ id, result: { stopReason } })
}

/** The agent asks permission to run a command (agent-side request id `requestId`). */
export function askToRun(sessionId: string, requestId: number, toolCallId: string, command: string): Frame {
  return agent({
    id: requestId,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId, title: `Run \`${command}\``, kind: 'execute', status: 'pending', rawInput: { command } },
      options: PERMISSION_OPTIONS
    }
  })
}

export function selected(requestId: number, optionId: string): Frame {
  return client({ id: requestId, result: { outcome: { outcome: 'selected', optionId } } })
}

export function cancelled(requestId: number): Frame {
  return client({ id: requestId, result: { outcome: { outcome: 'cancelled' } } })
}
