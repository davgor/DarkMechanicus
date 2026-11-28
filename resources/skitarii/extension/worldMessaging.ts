/** A world keeps independent mailboxes/cursors; a tool chooses its project explicitly. */
import type { DmCallResult, DmClient } from './dmClient'
import { MAIL_DATA_NOTE } from './contextDelivery'
import { attachMailWatcher, attachMessaging, inertJson, mailSupport, mailTools, MAIL_STATUS_KEY, type MailApi, type MailContext, type MailToolDefinition, type MailWatcher, type ToolResult } from './messaging'
import type { Timers } from './skitarii'
import type { WorldMailClients } from './worldDmClient'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const refused = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

function tagged<T>(result: DmCallResult<T>, project: string): DmCallResult<T> {
  return result.ok && record(result.data) ? { ...result, data: { ...result.data, project } } : result
}

function projectClient(client: DmClient, folder: string): DmClient {
  return {
    ...client,
    call: async (command, input, signal) => tagged(await client.call(command, input, signal), folder),
    run: async (command, input, signal, options) => tagged(await client.run(command, input, signal, options), folder),
  }
}

/** Route-specific statuses and receipts cannot overwrite another project's status or cursor. */
function projectApi(pi: MailApi, project: string): MailApi {
  return {
    ...pi,
    sendUserMessage: pi.sendUserMessage?.bind(pi),
    on: (event, handler) => pi.on(event, (data, ctx) => {
      const scoped: MailContext = { ...ctx, ui: {
        ...ctx.ui,
        notify: (text, kind) => ctx.ui.notify?.(`${project}: ${text}`, kind),
        setStatus: (key, text) => ctx.ui.setStatus?.(`${key}:${project}`, text === undefined ? undefined : `${project}: ${text}`),
      } }
      return handler(data, scoped)
    }),
  }
}

type Route = WorldMailClients['projects'][number] & { tools: MailToolDefinition[]; watcher: MailWatcher }
type ToolContext = [signal?: AbortSignal, onUpdate?: unknown, ctx?: MailContext]
interface Invocation { id: string; input: Record<string, unknown>; context: ToolContext }

async function aggregate(routes: readonly Route[], tool: MailToolDefinition, { id, input, context }: Invocation): Promise<ToolResult> {
  const results = await Promise.all(routes.map(async route => ({ project: route.project, folder: route.folder,
    result: await route.tools.find(item => item.name === tool.name)!.execute(id, input, ...context) })))
  return { content: [{ type: 'text', text: `${MAIL_DATA_NOTE}\nProject mailboxes (each cursor belongs to its project).\n${inertJson(results)}` }], ...(results.some(item => item.result.isError) ? { isError: true } : {}) }
}

function readsInbox(tool: MailToolDefinition, input: Record<string, unknown>, context: ToolContext): boolean {
  return context[2]?.agent?.kind !== 'sub' && (tool.name === 'dm_inbox_read' || tool.name === 'dm_call' && ['read_agent_inbox', 'readAgentInbox'].includes(String(input.command)))
}

async function dispatch(route: Route, tool: MailToolDefinition, { id, input, context }: Invocation): Promise<ToolResult> {
  const reading = readsInbox(tool, input, context)
  if (reading) route.watcher.readingInbox(id, true)
  try { return await route.tools.find(item => item.name === tool.name)!.execute(id, input, ...context) }
  catch (error) { if (reading) route.watcher.readingInbox(id, false); throw error }
}

function scopedExecute(routes: readonly Route[], tool: MailToolDefinition): MailToolDefinition['execute'] {
  return async (id, params, ...context) => {
    if (!record(params ?? {})) return refused('Arguments must be one JSON object.')
    const { project, ...input } = (params ?? {}) as Record<string, unknown>
    if (project !== undefined && typeof project !== 'string') return refused('project must be one listed project name.')
    const invocation = { id, input, context }
    if (project === undefined && ['dm_agent_identity', 'dm_agent_peers'].includes(tool.name)) return aggregate(routes, tool, invocation)
    return selectAndDispatch(routes, tool, project, invocation)
  }
}

function selectAndDispatch(routes: readonly Route[], tool: MailToolDefinition, project: unknown, invocation: Invocation): Promise<ToolResult> | ToolResult {
  const selected = project === undefined && routes.length === 1 ? routes[0] : routes.find(route => route.project === project)
  if (!selected) return refused(`Choose project from: ${routes.map(route => route.project).join(', ') || '(no project mailboxes)'}. Nothing was run.`)
  return dispatch(selected, tool, invocation)
}

export function attachWorldMessaging(pi: MailApi, world: WorldMailClients, timers: Timers): void {
  const support = mailSupport(pi)
  if (!support.ok) { attachMessaging(pi, world.recovery, timers); return }
  const choices = world.projects.map(route => route.project)
  const routes = world.projects.map(route => {
    const client = projectClient(route.client, route.folder)
    return { ...route, client, tools: mailTools(client, support.type), watcher: attachMailWatcher(projectApi(pi, route.project), client, timers, { project: route.folder }) }
  })
  if (routes.length === 0) pi.on('session_start', (_event, ctx) => {
    if (ctx.hasUI && ctx.agent?.kind !== 'sub') ctx.ui.setStatus?.(MAIL_STATUS_KEY, 'Skitarii mail: no project mailboxes in this Forge World')
  })
  const base = mailTools(world.recovery, support.type)
  for (const tool of base) {
    if (tool.name === 'recover_tooling') { pi.registerTool?.(tool); continue }
    const schema = record(tool.parameters) ? tool.parameters : {}
    const parameters = { ...schema, properties: { ...(record(schema.properties) ? schema.properties : {}),
      project: support.type.Optional(support.type.String({ description: `Project mailbox. Choices: ${choices.join(', ') || '(none)'}. Required for ambiguous calls.`, minLength: 1 })),
    } }
    const scoped: MailToolDefinition = { ...tool, parameters,
      description: tool.description + ' In a Forge World, set project to its listed name. Identity and peers without project list each mailbox separately; cursors belong to that project only.',
      execute: scopedExecute(routes, tool),
    }
    pi.registerTool?.(scoped)
  }
  // Recovery peer context belongs to the root launch, so it is admitted once, never once per project.
  const recoveryOnly: DmClient = {
    ...world.recovery,
    call: async () => ({ ok: true, data: { snapshotHighWater: 0, nextCursor: 0, hasMore: false, pendingCount: 0, messages: [] } }) as DmCallResult<never>,
    readBoard: async () => ({ ok: true, data: [] }),
  }
  attachMailWatcher({ ...pi, on: (event, handler) => pi.on(event, (data, ctx) => handler(data, { ...ctx, ui: { ...ctx.ui, setStatus: () => {} } })) }, recoveryOnly, timers)
  pi.on('session_shutdown', () => { void Promise.all(routes.map(route => route.client.cancelAll())) })
}
