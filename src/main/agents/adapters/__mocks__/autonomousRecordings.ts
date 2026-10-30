/**
 * ACP exchanges as `a8s start <folder> --mode acp` speaks them, captured from the installed
 * Autonomous 0.79.0 (OMP 18.11.2) against a scratch Git repository. Findings are in
 * docs/reports/autonomous-acp.md. Not shipped, and nothing reads it yet: it is the
 * ground truth for the Autonomous adapter.
 *
 * Sanitized: the scratch folder is FOLDER (and REAL_FOLDER, the symlink-resolved path the shell
 * printed), session, message and tool-call ids are placeholders, `updatedAt` timestamps are
 * shifted, costs and wall times are rounded, and the client version is CLIENT_VERSION. Streamed
 * `agent_thought_chunk` / `agent_message_chunk` updates that shared a `messageId` are joined into
 * one frame each, and `available_commands_update` keeps 4 of the 60 commands it sent.
 * Everything else is as it crossed the wire, in order.
 */
import { agent, client, type Frame } from '../../__mocks__/replayAcpAgent'

const FOLDER = '/tmp/scratch'
/** What `pwd` printed: the scratch folder with its symlinks resolved (macOS `/tmp` is `/private/tmp`). */
const REAL_FOLDER = '/private/tmp/scratch'
const CLIENT_VERSION = '9.9.9'
const SESSION_ID = '00000000-0000-7000-8000-000000000001'
const SESSION_PARAMS = { cwd: FOLDER, mcpServers: [] }

/** Ask-every-time, as `--approval-mode always-ask` launches it. */
const LAUNCH_ARGV = ['start', FOLDER, '--mode', 'acp', '--approval-mode', 'always-ask']

/** The four options every `session/request_permission` offered. */
const PERMISSION_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' }
]

const MODE_OPTIONS = [
  {
    value: 'default',
    name: 'Default',
    description: 'Standard ACP headless mode'
  },
  {
    value: 'plan',
    name: 'Plan',
    description: 'Read-only planning mode that drafts a plan to a markdown file before any code changes'
  }
]

const MODEL_OPTIONS = [
  {
    value: 'anthropic/claude-fable-5-1',
    name: 'Claude Fable 5.1',
    description: 'anthropic/claude-fable-5-1'
  },
  {
    value: 'anthropic/claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    description: 'anthropic/claude-haiku-5-5'
  },
  {
    value: 'anthropic/claude-opus-5-5',
    name: 'Claude Opus 5.5',
    description: 'anthropic/claude-opus-5-5'
  },
  {
    value: 'anthropic/claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    description: 'anthropic/claude-sonnet-5-5'
  }
]

const THINKING_OPTIONS = [
  { value: 'off', name: 'Off' },
  { value: 'auto', name: 'Auto', description: 'Auto-detect per prompt' },
  { value: 'low', name: 'low' },
  { value: 'medium', name: 'medium' },
  { value: 'high', name: 'high' },
  { value: 'xhigh', name: 'xhigh' },
  { value: 'max', name: 'max' }
]

function configOptions(model: string): Record<string, unknown>[] {
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: MODE_OPTIONS
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: MODEL_OPTIONS
    },
    {
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: 'xhigh',
      options: THINKING_OPTIONS
    }
  ]
}

const MODES = {
  availableModes: MODE_OPTIONS.map(({ value, name, description }) => ({
    id: value,
    name,
    description
  })),
  currentModeId: 'default'
}

function update(body: Record<string, unknown>): Frame {
  return agent({
    method: 'session/update',
    params: { sessionId: SESSION_ID, update: body }
  })
}

function text(value: string): Record<string, unknown> {
  return { type: 'content', content: { type: 'text', text: value } }
}

function prompt(id: number, value: string): Frame {
  return client({
    id,
    method: 'session/prompt',
    params: { sessionId: SESSION_ID, prompt: [{ type: 'text', text: value }] }
  })
}

function askToRun(requestId: number, toolCallId: string, command: string, rawInput: Record<string, unknown>): Frame {
  return agent({
    id: requestId,
    method: 'session/request_permission',
    params: {
      sessionId: SESSION_ID,
      toolCall: {
        toolCallId,
        title: command,
        kind: 'execute',
        status: 'pending',
        rawInput,
        content: [text(`$ ${command}`)],
        locations: []
      },
      options: PERMISSION_OPTIONS
    }
  })
}

function selected(requestId: number, optionId: string): Frame {
  return client({
    id: requestId,
    result: { outcome: { outcome: 'selected', optionId } }
  })
}

/** Sent during session/new and session/load, before their results. */
const HIVEMIND_NOTICE = update({
  sessionUpdate: 'agent_message_chunk',
  content: {
    type: 'text',
    text: 'Hivemind is Off. Anonymous usage metrics are separate. Enable sharing in a terminal before the first turn.\n\n'
  }
})

const COMMANDS_UPDATE = update({
  sessionUpdate: 'available_commands_update',
  availableCommands: [
    {
      name: 'fast',
      description: 'Toggle fast mode',
      input: { hint: '[on|ultra|off|status]' }
    },
    {
      name: 'usage',
      description: 'Show token usage',
      input: { hint: '[show|reset [provider/credential-id|provider/active]]' }
    },
    { name: 'context', description: 'Show context usage' },
    {
      name: 'compact',
      description: 'Compact the conversation',
      input: { hint: '[soft|remote|snapcompact] [focus]' }
    }
  ]
})

/** initialize + authenticate (the one listed method), request ids 1 and 2; the same in every process. */
const HANDSHAKE: Frame[] = [
  client({
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: { name: 'dark-mechanicus', version: CLIENT_VERSION }
    }
  }),
  agent({
    id: 1,
    result: {
      protocolVersion: 1,
      agentInfo: {
        name: 'Autonomous',
        title: 'Autonomous',
        version: '18.11.2'
      },
      authMethods: [
        {
          id: 'agent',
          name: 'Use existing local credentials',
          description: 'Authenticate via the provider keys/OAuth state already configured under ~/.omp.'
        }
      ],
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} }
      }
    }
  }),
  client({ id: 2, method: 'authenticate', params: { methodId: 'agent' } }),
  agent({ id: 2, result: {} })
]

/** session/new: the notice arrives first, for a session id the client has not been told yet. */
const NEW_SESSION: Frame[] = [
  client({ id: 3, method: 'session/new', params: SESSION_PARAMS }),
  HIVEMIND_NOTICE,
  agent({
    id: 3,
    result: {
      sessionId: SESSION_ID,
      configOptions: configOptions('anthropic/claude-opus-5-5'),
      modes: MODES
    }
  })
]

const PWD_OUTPUT = `${REAL_FOLDER}\n`
const PWD_CONTENT = [text('$ pwd'), text(PWD_OUTPUT), text(REAL_FOLDER)]
const PWD_DETAILS = {
  wallTimeNoticeEmitted: false,
  timeoutSeconds: 300,
  wallTimeMs: 237.27
}

/**
 * Turn 1: "run pwd, then create hello.txt". `pwd` is asked about and allowed; the write is
 * refused by a8s without any permission request (see the report), so the second permission
 * answer, a reject, is recorded in LOAD_SESSION's turn instead.
 */
const PROMPT_TURN: Frame[] = [
  prompt(
    4,
    'Run the shell command `pwd`. Then create a file named hello.txt containing "hi" in the current folder. Use one tool call for each step. Be brief.'
  ),
  COMMANDS_UPDATE,
  update({
    sessionUpdate: 'session_info_update',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }),
  askToRun(0, 'toolu_pwd', 'pwd', { command: 'pwd' }),
  selected(0, 'allow_once'),
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_pwd',
    title: '$ pwd',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'pwd' },
    content: [text('$ pwd')]
  }),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_pwd',
    status: 'in_progress',
    rawOutput: { content: [{ type: 'text', text: PWD_OUTPUT }], details: {} },
    content: PWD_CONTENT
  }),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_pwd',
    status: 'in_progress',
    rawOutput: {
      content: [{ type: 'text', text: PWD_OUTPUT }],
      details: PWD_DETAILS
    },
    content: PWD_CONTENT
  }),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_pwd',
    status: 'completed',
    rawOutput: {
      content: [{ type: 'text', text: PWD_OUTPUT }],
      details: PWD_DETAILS
    },
    content: PWD_CONTENT
  }),
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_write',
    title: 'Creating hello.txt',
    kind: 'edit',
    status: 'pending',
    rawInput: { path: 'hello.txt', content: 'hi' },
    locations: [{ path: `${REAL_FOLDER}/hello.txt` }]
  }),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_write',
    status: 'failed',
    rawOutput: {
      content: [{ type: 'text', text: 'Tool call denied by user: write' }],
      details: {}
    },
    content: [text('Tool call denied by user: write')]
  }),
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: {
      type: 'text',
      text: "The user denied the write, so I shouldn't retry with bash either — I'll respect that decision and just give a brief report.\n\n"
    },
    messageId: 'message-1'
  }),
  update({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: `\`pwd\` printed \`${REAL_FOLDER}\`.\n\nI didn't create \`hello.txt\`: you denied the write. I didn't retry another way.`
    },
    messageId: 'message-1'
  }),
  update({
    sessionUpdate: 'usage_update',
    size: 1000000,
    used: 20951,
    cost: { amount: 0.18, currency: 'USD' }
  }),
  update({
    sessionUpdate: 'session_info_update',
    updatedAt: '2026-01-01T00:00:08.000Z'
  }),
  agent({
    id: 4,
    result: {
      stopReason: 'end_turn',
      usage: {
        inputTokens: 8,
        outputTokens: 301,
        totalTokens: 62780,
        cachedReadTokens: 41522,
        cachedWriteTokens: 20949
      }
    }
  })
]

/**
 * Turn 2: `session/cancel` sent while the `sleep 60` permission request was open, then that
 * request answered as cancelled. The turn ends with stopReason `cancelled`.
 */
const CANCEL_TURN: Frame[] = [
  prompt(5, 'Run the shell command `sleep 60` and then say done.'),
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: {
      type: 'text',
      text: "I'll run a 60-second sleep, giving it a longer timeout of around 90 seconds since non-pty calls past 60s shift to background.\n\n"
    },
    messageId: 'message-2'
  }),
  askToRun(1, 'toolu_sleep', 'sleep 60', { command: 'sleep 60', timeout: 90 }),
  client({ method: 'session/cancel', params: { sessionId: SESSION_ID } }),
  client({ id: 1, result: { outcome: { outcome: 'cancelled' } } }),
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_sleep',
    title: '$ sleep 60',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'sleep 60', timeout: 90 },
    content: [text('$ sleep 60')]
  }),
  agent({
    id: 5,
    result: {
      stopReason: 'cancelled',
      usage: {
        inputTokens: 4,
        outputTokens: 147,
        totalTokens: 21246,
        cachedReadTokens: 20949,
        cachedWriteTokens: 146
      }
    }
  })
]

/**
 * A new process (HANDSHAKE again, ids 1 and 2), then `session/load` of the same id. The history
 * is replayed as updates (user turns as `user_message_chunk`, no permission requests) before the
 * answer, which carries configOptions and modes but no sessionId. Then the model is switched
 * with `session/set_config_option` and one turn runs, whose permission request is rejected.
 */
const LOAD_SESSION: Frame[] = [
  client({
    id: 3,
    method: 'session/load',
    params: { sessionId: SESSION_ID, ...SESSION_PARAMS }
  }),
  HIVEMIND_NOTICE,
  update({
    sessionUpdate: 'user_message_chunk',
    content: {
      type: 'text',
      text: 'Run the shell command `pwd`. Then create a file named hello.txt containing "hi" in the current folder. Use one tool call for each step. Be brief.'
    },
    messageId: 'message-3'
  }),
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_pwd',
    title: '$ pwd',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'pwd', i: 'Printing working directory' },
    content: [text('$ pwd')]
  }),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_pwd',
    status: 'completed',
    rawOutput: {
      content: [{ type: 'text', text: PWD_OUTPUT }],
      details: PWD_DETAILS
    },
    content: PWD_CONTENT
  }),
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_write',
    title: 'write: hello.txt',
    kind: 'edit',
    status: 'pending',
    rawInput: { path: 'hello.txt', content: 'hi', i: 'Creating hello.txt' },
    locations: [{ path: `${REAL_FOLDER}/hello.txt` }]
  }),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_write',
    status: 'failed',
    rawOutput: {
      content: [{ type: 'text', text: 'Tool call denied by user: write' }],
      details: {}
    },
    content: [text('Tool call denied by user: write')]
  }),
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: {
      type: 'text',
      text: "The user denied the write, so I shouldn't retry with bash either — I'll respect that decision and just give a brief report."
    },
    messageId: 'message-4'
  }),
  update({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: `\`pwd\` printed \`${REAL_FOLDER}\`.\n\nI didn't create \`hello.txt\`: you denied the write. I didn't retry another way.`
    },
    messageId: 'message-4'
  }),
  update({
    sessionUpdate: 'user_message_chunk',
    content: {
      type: 'text',
      text: 'Run the shell command `sleep 60` and then say done.'
    },
    messageId: 'message-5'
  }),
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: {
      type: 'text',
      text: "I'll run a 60-second sleep, giving it a longer timeout of around 90 seconds since non-pty calls past 60s shift to background."
    },
    messageId: 'message-6'
  }),
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_sleep',
    title: '$ sleep 60',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'sleep 60', i: 'Sleeping sixty seconds', timeout: 90 },
    content: [text('$ sleep 60')]
  }),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_sleep',
    status: 'failed',
    rawOutput: {
      content: [{ type: 'text', text: 'Permission request cancelled' }],
      details: {}
    },
    content: [text('$ sleep 60'), text('Permission request cancelled')]
  }),
  agent({
    id: 3,
    result: {
      configOptions: configOptions('anthropic/claude-opus-5-5'),
      modes: MODES
    }
  }),
  client({
    id: 4,
    method: 'session/set_config_option',
    params: {
      sessionId: SESSION_ID,
      configId: 'model',
      value: 'anthropic/claude-haiku-5-5'
    }
  }),
  update({
    sessionUpdate: 'config_option_update',
    configOptions: configOptions('anthropic/claude-haiku-5-5')
  }),
  agent({
    id: 4,
    result: { configOptions: configOptions('anthropic/claude-haiku-5-5') }
  }),
  prompt(5, 'Run the shell command `pwd` once. Be brief.'),
  COMMANDS_UPDATE,
  update({
    sessionUpdate: 'session_info_update',
    updatedAt: '2026-01-01T00:00:08.000Z'
  }),
  askToRun(0, 'toolu_pwd_again', 'pwd', { command: 'pwd' }),
  selected(0, 'reject_once'),
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_pwd_again',
    title: '$ pwd',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'pwd' },
    content: [text('$ pwd')]
  }),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_pwd_again',
    status: 'failed',
    rawOutput: {
      content: [{ type: 'text', text: 'Tool call rejected by user (bash)' }],
      details: {}
    },
    content: [text('$ pwd'), text('Tool call rejected by user (bash)')]
  }),
  update({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: '`pwd` was rejected by you, so nothing ran. Earlier this session, `sleep 60` was cancelled at the permission prompt, and the `hello.txt` write was denied; no files were created.'
    },
    messageId: 'message-7'
  }),
  update({
    sessionUpdate: 'usage_update',
    size: 100000,
    used: 21307,
    cost: { amount: 0.19, currency: 'USD' }
  }),
  update({
    sessionUpdate: 'session_info_update',
    updatedAt: '2026-01-01T00:01:14.000Z'
  }),
  agent({
    id: 5,
    result: {
      stopReason: 'end_turn',
      usage: {
        inputTokens: 6,
        outputTokens: 142,
        totalTokens: 42657,
        cachedReadTokens: 21204,
        cachedWriteTokens: 21305
      }
    }
  })
]

/** The recorded processes: the first opens the session and runs both turns, the second loads it. */
export const AUTONOMOUS_RECORDINGS = {
  folder: FOLDER,
  realFolder: REAL_FOLDER,
  clientVersion: CLIENT_VERSION,
  sessionId: SESSION_ID,
  launchArgv: LAUNCH_ARGV,
  versionLine: 'Autonomous 0.79.0 · darwin-arm64 · OMP 18.11.2',
  handshake: HANDSHAKE,
  newSession: NEW_SESSION,
  promptTurn: PROMPT_TURN,
  cancelTurn: CANCEL_TURN,
  loadSession: LOAD_SESSION,
  firstProcess: [...HANDSHAKE, ...NEW_SESSION, ...PROMPT_TURN, ...CANCEL_TURN],
  secondProcess: [...HANDSHAKE, ...LOAD_SESSION]
} as const
