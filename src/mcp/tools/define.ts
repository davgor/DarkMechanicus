import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { capabilitiesForRole, type Capability } from '../../core/authz'
import { COMMAND_CAPABILITIES } from '../../core/commands/capabilities'
import type { CommandApi, CommandName } from '../../shared/domain/api'
import type { SessionRole } from '../../shared/domain/views'
import { invalidInputFailure, runTool, toolFailure } from '../result'

/**
 * Annotation presets. Every tool is a closed-world local operation; only `cancel_run` is destructive.
 * `idempotent` marks writes that leave no further effect when repeated with the same arguments.
 */
const ANNOTATIONS = {
  read: { readOnlyHint: true, openWorldHint: false },
  idempotent: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
} as const satisfies Record<string, ToolAnnotations>

type ToolKind = keyof typeof ANNOTATIONS

/** `get_run_events` -> `getRunEvents`. */
type CamelCase<Name extends string> = Name extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : Name

/**
 * A tool named after the command it adapts (`get_epic` adapts `getEpic`) may omit `command`; any
 * other tool must declare it, or it does not compile.
 */
type CommandBinding<Name extends string> =
  CamelCase<Name> extends CommandName ? { command?: CommandName } : { command: CommandName }

/** A tool that can be registered on any server against any `CommandApi`. */
export interface ToolSpec {
  readonly name: string
  /** The command the tool adapts. A session sees the tool only if its role holds that command's capability. */
  readonly command: CommandName
  register(server: McpServer, api: CommandApi): void
}

interface ToolBase<Name extends string> {
  name: Name
  /** Teaches agents the rules of the command; keep it short and concrete. */
  description: string
  kind: ToolKind
}

interface ErasedTool {
  name: string
  description: string
  kind: ToolKind
  input: z.ZodRawShape | undefined
  run(api: CommandApi, input: unknown): Promise<unknown>
}

/** Answers one call of a tool from its raw (unvalidated) arguments. */
type ToolCall = (args: Record<string, unknown> | undefined) => Promise<CallToolResult>

/** The session a server's tools are registered for. */
interface ToolGrant {
  role: SessionRole
  capabilities: ReadonlySet<Capability>
}

interface ToolTable {
  /** Set by `grantTools`; a bare server without one registers every tool (adapter tests). */
  grant: ToolGrant | undefined
  /** How the server answers each tool name it knows: run it, or refuse it for this session. */
  calls: Map<string, ToolCall>
}

const TABLES = new WeakMap<McpServer, ToolTable>()

function newTable(server: McpServer): ToolTable {
  const table: ToolTable = { grant: undefined, calls: new Map() }
  TABLES.set(server, table)
  return table
}

function tableOf(server: McpServer): ToolTable {
  return TABLES.get(server) ?? newTable(server)
}

function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(COMMAND_CAPABILITIES, value)
}

function commandOf(name: string, declared: CommandName | undefined): CommandName {
  const command = declared ?? name.replace(/_([a-z0-9])/g, (_match, next: string) => next.toUpperCase())
  if (!isCommandName(command)) {
    throw new Error(`Tool ${name} does not name a command; declare the command it adapts.`)
  }
  return command
}

/** Validates the raw arguments against the tool's input shape, then runs it. */
function callOf(api: CommandApi, tool: ErasedTool): ToolCall {
  if (tool.input === undefined) {
    return () => runTool(() => tool.run(api, undefined))
  }
  const schema = z.object(tool.input)
  return async (args) => {
    const parsed = await schema.safeParseAsync(args ?? {})
    return parsed.success
      ? runTool(() => tool.run(api, parsed.data))
      : invalidInputFailure(tool.name, parsed.error.issues)
  }
}

function refusedFor(grant: ToolGrant, tool: string, capability: Capability): ToolCall {
  return async () =>
    toolFailure({
      code: 'unauthorized',
      message: `This ${grant.role} session is not permitted to perform "${capability}".`,
      details: { role: grant.role, capability, tool }
    })
}

async function unknownTool(name: string): Promise<CallToolResult> {
  return toolFailure({ code: 'not_found', message: `Tool ${name} not found.`, details: { tool: name } })
}

/**
 * Takes over tools/call from the SDK, whose handler validates arguments itself and answers failures
 * with plain text. Ours validates in `callOf` and answers with the `invalid_input` payload every other
 * failure uses. tools/list stays the SDK's, so agents see the same JSON schemas. Set after every
 * registration: the SDK installs its own handler when the first tool is registered.
 */
function answerToolCalls(server: McpServer, table: ToolTable): void {
  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const call = table.calls.get(request.params.name)
    return call === undefined ? unknownTool(request.params.name) : call(request.params.arguments)
  })
}

function registerErased(server: McpServer, api: CommandApi, tool: ErasedTool): void {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.input, annotations: ANNOTATIONS[tool.kind] },
    // Only reached through the SDK's own handler, which `answerToolCalls` replaces.
    (input: unknown) => runTool(() => tool.run(api, input))
  )
  const table = tableOf(server)
  table.calls.set(tool.name, callOf(api, tool))
  answerToolCalls(server, table)
}

/**
 * Defines a tool whose input is a zod raw shape. The server validates arguments against `input`
 * before `run`, so the value reaching `run` always has the shape's output type; arguments that do
 * not match are answered with `invalid_input`. The same shape is published as the JSON schema.
 */
export function defineTool<Shape extends z.ZodRawShape, Name extends string>(
  tool: ToolBase<Name> &
    CommandBinding<Name> & {
      input: Shape
      run: (api: CommandApi, input: z.output<z.ZodObject<Shape>>) => Promise<unknown>
    }
): ToolSpec {
  return {
    name: tool.name,
    command: commandOf(tool.name, tool.command),
    register: (server, api) =>
      registerErased(server, api, {
        name: tool.name,
        description: tool.description,
        kind: tool.kind,
        input: tool.input,
        run: (target, input) => tool.run(target, input as z.output<z.ZodObject<Shape>>)
      })
  }
}

/** Defines a tool without arguments (clients may then omit `arguments` entirely). */
export function defineArglessTool<Name extends string>(
  tool: ToolBase<Name> & CommandBinding<Name> & { run: (api: CommandApi) => Promise<unknown> }
): ToolSpec {
  return {
    name: tool.name,
    command: commandOf(tool.name, tool.command),
    register: (server, api) =>
      registerErased(server, api, {
        name: tool.name,
        description: tool.description,
        kind: tool.kind,
        input: undefined,
        run: (target) => tool.run(target)
      })
  }
}

/**
 * Limits the tools registered on `server` from now on to those a session of `role` may call: the
 * role must hold the capability declared for the tool's command (`allowSave` adds `plan.save` for
 * planner and orchestrator sessions, exactly as for the session itself). Other tools are not listed,
 * and calling one is answered with `unauthorized` without running anything. Call before registering.
 */
export function grantTools(server: McpServer, session: { role: SessionRole; allowSave: boolean }): void {
  const capabilities = capabilitiesForRole(session.role, { allowSave: session.allowSave })
  tableOf(server).grant = { role: session.role, capabilities: new Set(capabilities) }
}

/** How to refuse `spec` when the granted role lacks its command's capability; undefined when it may call it. */
function refusalFor(grant: ToolGrant | undefined, spec: ToolSpec): ToolCall | undefined {
  const capability = COMMAND_CAPABILITIES[spec.command]
  if (grant === undefined || grant.capabilities.has(capability)) {
    return undefined
  }
  return refusedFor(grant, spec.name, capability)
}

export function registerTools(server: McpServer, api: CommandApi, specs: readonly ToolSpec[]): void {
  const table = tableOf(server)
  for (const spec of specs) {
    const refusal = refusalFor(table.grant, spec)
    if (refusal === undefined) {
      spec.register(server, api)
    } else {
      table.calls.set(spec.name, refusal)
    }
  }
}
