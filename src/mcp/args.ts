import { resolve } from 'node:path'
import type { SessionRole } from '../shared/domain/views'

/** Launch options of the headless MCP process. Roles come from these flags, never from tool input. */
export interface McpOptions {
  /** Absolute repository root to coordinate. */
  repo: string
  role: SessionRole
  /** Explicit person-granted permission for a planner/orchestrator session to call `save_plan`. */
  allowSave: boolean
  /** Name shown for this session in the desktop app. */
  label: string
  help: boolean
}

export const MCP_USAGE = [
  'Usage: mcp.js [--repo <path>] [--role <role>] [--allow-save] [--label <text>] [--help]',
  '',
  'Serves the Dark Mechanicus tools for one repository over stdio (MCP).',
  '',
  'Options:',
  '  --repo <path>   Repository root to coordinate (default: $DARKMECHANICUS_REPO, else the current directory)',
  '  --role <role>   planner, orchestrator (default), worker, or reviewer',
  '  --allow-save    Let a planner or orchestrator session call save_plan (otherwise a person presses Save in the desktop app)',
  '  --label <text>  Name shown for this session in the desktop app (default: "<role> via MCP")',
  '  --help          Show this help'
].join('\n')

const AGENT_ROLES: readonly SessionRole[] = ['planner', 'orchestrator', 'worker', 'reviewer']
const DEFAULT_ROLE: SessionRole = 'orchestrator'
const REPO_ENV = 'DARKMECHANICUS_REPO'

interface RawFlags {
  repo?: string
  role?: string
  label?: string
  allowSave: boolean
  help: boolean
}

/** Applies one flag and returns how many argv tokens it consumed. */
type FlagHandler = (flags: RawFlags, inline: string | undefined, next: string | undefined) => number

function usageError(message: string): Error {
  return new Error(`${message}\n\n${MCP_USAGE}`)
}

type ValueKey = 'repo' | 'role' | 'label'
type SwitchKey = 'allowSave' | 'help'

function switchFlag(name: string, key: SwitchKey): FlagHandler {
  return (flags, inline) => {
    if (inline !== undefined) {
      throw usageError(`${name} does not take a value.`)
    }
    flags[key] = true
    return 1
  }
}

function valueFlag(name: string, key: ValueKey): FlagHandler {
  return (flags, inline, next) => {
    const value = inline ?? next
    const looksLikeFlag = inline === undefined && value?.startsWith('--') === true
    if (value === undefined || value === '' || looksLikeFlag) {
      throw usageError(`${name} requires a value.`)
    }
    flags[key] = value
    return inline === undefined ? 2 : 1
  }
}

const FLAG_HANDLERS = new Map<string, FlagHandler>([
  ['--repo', valueFlag('--repo', 'repo')],
  ['--role', valueFlag('--role', 'role')],
  ['--label', valueFlag('--label', 'label')],
  ['--allow-save', switchFlag('--allow-save', 'allowSave')],
  ['--help', switchFlag('--help', 'help')],
  ['-h', switchFlag('-h', 'help')]
])

function splitFlag(token: string): { name: string; inline: string | undefined } {
  const equals = token.indexOf('=')
  if (token.startsWith('--') && equals > 2) {
    return { name: token.slice(0, equals), inline: token.slice(equals + 1) }
  }
  return { name: token, inline: undefined }
}

function applyToken(flags: RawFlags, argv: readonly string[], index: number): number {
  const { name, inline } = splitFlag(argv[index] ?? '')
  const handler = FLAG_HANDLERS.get(name)
  if (handler === undefined) {
    throw usageError(name.startsWith('-') ? `Unknown option "${name}".` : `Unexpected argument "${name}".`)
  }
  return handler(flags, inline, argv[index + 1])
}

function readFlags(argv: readonly string[]): RawFlags {
  const flags: RawFlags = { allowSave: false, help: false }
  let index = 0
  while (index < argv.length && !flags.help) {
    index += applyToken(flags, argv, index)
  }
  return flags
}

function resolveRole(value: string | undefined): SessionRole {
  if (value === undefined) {
    return DEFAULT_ROLE
  }
  if (value === 'desktop') {
    throw usageError('The desktop role is reserved for the Dark Mechanicus app and cannot be used over MCP.')
  }
  const role = AGENT_ROLES.find((candidate) => candidate === value)
  if (role === undefined) {
    throw usageError(`Unknown role "${value}". Use one of: ${AGENT_ROLES.join(', ')}.`)
  }
  return role
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

export function parseMcpArgs(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd: string
): McpOptions {
  const flags = readFlags(argv)
  const repo = resolve(cwd, flags.repo ?? nonBlank(env[REPO_ENV]) ?? cwd)
  if (flags.help) {
    return { repo, role: DEFAULT_ROLE, allowSave: false, label: `${DEFAULT_ROLE} via MCP`, help: true }
  }
  const role = resolveRole(flags.role)
  return { repo, role, allowSave: flags.allowSave, label: flags.label ?? `${role} via MCP`, help: false }
}
