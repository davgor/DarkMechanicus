/**
 * An in-memory MCP server with a minimal Linear-like toolset, for the Linear transfer integration test and
 * `scripts/linear-transfer-smoke.mjs`. It keeps teams, labels, projects, milestones, issues (identifiers
 * `<team key>-1…` per team, in creation order) and relations. It offers no delete, so a driver can only
 * update an item or move an issue out of its project, and it logs every tool call. Not shipped.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export type FakeStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'

export interface FakeTeam {
  id: string
  key: string
  name: string
}

interface FakeWorkflowState {
  id: string
  name: string
  type: FakeStateType
}

export interface FakeLabel {
  id: string
  teamId: string
  name: string
}

export interface FakeProject {
  id: string
  teamId: string
  name: string
  summary: string
  content: string
  url: string
}

export interface FakeMilestone {
  id: string
  projectId: string
  name: string
  description: string
  sortOrder: number
}

export interface FakeRelation {
  id: string
  /** `blocks`: `issueId` blocks `relatedIssueId`. `related` is symmetric. */
  type: 'blocks' | 'related'
  issueId: string
  relatedIssueId: string
}

interface StoredIssue {
  id: string
  identifier: string
  url: string
  teamId: string
  projectId: string | null
  milestoneId: string | null
  title: string
  description: string
  priority: number
  labelIds: string[]
  stateId: string
  sortOrder: number
}

/** An issue as the tools show it: label names, its state and the relations it is the source of. */
export interface FakeIssue {
  id: string
  identifier: string
  url: string
  teamId: string
  projectId: string | null
  milestoneId: string | null
  title: string
  description: string
  priority: number
  labels: string[]
  state: string
  stateType: FakeStateType
  sortOrder: number
  relations: FakeRelation[]
}

interface FakeLinearDump {
  teams: FakeTeam[]
  labels: FakeLabel[]
  projects: FakeProject[]
  milestones: FakeMilestone[]
  /** Every issue, in creation order, whatever project it is in. */
  issues: FakeIssue[]
  relations: FakeRelation[]
}

export interface FakeLinear {
  /** A client connected to a fresh server over this one store, like an agent's Linear MCP connection. */
  connect(): Promise<Client>
  /** The name of every tool called so far, in call order. */
  readonly calls: readonly string[]
  dump(): FakeLinearDump
  /** The projects, their milestones and issues and the issues outside any project, as text. */
  layout(): string
  close(): Promise<void>
}

const WORKFLOW: FakeWorkflowState[] = [
  { id: 'state-triage', name: 'Triage', type: 'triage' },
  { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
  { id: 'state-todo', name: 'Todo', type: 'unstarted' },
  { id: 'state-progress', name: 'In Progress', type: 'started' },
  { id: 'state-done', name: 'Done', type: 'completed' },
  { id: 'state-canceled', name: 'Canceled', type: 'canceled' }
]

/** The state a new issue gets when the create names none. */
const DEFAULT_STATE = 'Todo'

const BASE_URL = 'https://linear.fake/acme'

const DEFAULT_TEAMS: FakeTeam[] = [
  { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  { id: 'team-ops', key: 'OPS', name: 'Operations' }
]

const PAGE_DEFAULT = 50

interface Store {
  teams: FakeTeam[]
  labels: FakeLabel[]
  projects: FakeProject[]
  milestones: FakeMilestone[]
  issues: StoredIssue[]
  relations: FakeRelation[]
  /** The next identifier number of each team. */
  numbers: Map<string, number>
  /** The next id of each kind of item. */
  ids: Map<string, number>
}

function nextId(store: Store, prefix: string): string {
  const next = (store.ids.get(prefix) ?? 0) + 1
  store.ids.set(prefix, next)
  return `${prefix}-${next}`
}

function refuse(message: string): never {
  throw new Error(message)
}

function find<T extends { id: string }>(items: T[], id: string, kind: string): T {
  return items.find((item) => item.id === id) ?? refuse(`${kind} ${id} not found.`)
}

function stateNamed(name: string): FakeWorkflowState {
  const wanted = name.trim().toLowerCase()
  return WORKFLOW.find((state) => state.name.toLowerCase() === wanted) ?? refuse(`Unknown state "${name}".`)
}

function includesText(query: string, ...texts: string[]): boolean {
  const wanted = query.toLowerCase()
  return texts.some((text) => text.toLowerCase().includes(wanted))
}

function issueView(store: Store, issue: StoredIssue): FakeIssue {
  const state = find(WORKFLOW, issue.stateId, 'State')
  const { labelIds, stateId: _stateId, ...rest } = issue
  return {
    ...rest,
    labels: labelIds.map((id) => find(store.labels, id, 'Label').name),
    state: state.name,
    stateType: state.type,
    relations: store.relations.filter((relation) => relation.issueId === issue.id).map((relation) => ({ ...relation }))
  }
}

/** Label ids for label names of the team; every name must already exist. */
function labelIdsOf(store: Store, teamId: string, names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim().toLowerCase()))].map((wanted) => {
    const label = store.labels.find((item) => item.teamId === teamId && item.name.toLowerCase() === wanted)
    return label?.id ?? refuse(`Label "${wanted}" does not exist in the team. Create it first.`)
  })
}

function milestoneOfProject(store: Store, projectId: string | null, milestoneId: string | null): string | null {
  if (milestoneId === null) {
    return null
  }
  const milestone = find(store.milestones, milestoneId, 'Milestone')
  return milestone.projectId === projectId ? milestone.id : refuse(`Milestone ${milestoneId} is not in project ${projectId ?? '(none)'}.`)
}

const issueFields = {
  title: z.string().min(1),
  description: z.string(),
  priority: z.number().int().min(0).max(4),
  labels: z.array(z.string()),
  state: z.string().describe('A workflow state name, such as Todo or Done.'),
  sortOrder: z.number()
}

const createIssueInput = {
  teamId: z.string(),
  projectId: z.string(),
  milestoneId: z.string().nullable().optional(),
  title: issueFields.title,
  description: issueFields.description,
  priority: issueFields.priority.optional(),
  labels: issueFields.labels.optional(),
  state: issueFields.state.optional(),
  sortOrder: issueFields.sortOrder.optional()
}

const updateIssueInput = {
  id: z.string(),
  projectId: z.string().nullable().optional().describe('null moves the issue out of its project (and its milestone).'),
  milestoneId: z.string().nullable().optional(),
  title: issueFields.title.optional(),
  description: issueFields.description.optional(),
  priority: issueFields.priority.optional(),
  labels: issueFields.labels.optional(),
  state: issueFields.state.optional(),
  sortOrder: issueFields.sortOrder.optional()
}

type CreateIssueArgs = z.output<z.ZodObject<typeof createIssueInput>>
type UpdateIssueArgs = z.output<z.ZodObject<typeof updateIssueInput>>

function createIssue(store: Store, args: CreateIssueArgs): FakeIssue {
  const team = find(store.teams, args.teamId, 'Team')
  const project = find(store.projects, args.projectId, 'Project')
  if (project.teamId !== team.id) {
    refuse(`Project ${project.id} is not in team ${team.key}.`)
  }
  const number = store.numbers.get(team.id) ?? 1
  store.numbers.set(team.id, number + 1)
  const identifier = `${team.key}-${number}`
  const issue: StoredIssue = {
    id: nextId(store, 'iss'),
    identifier,
    url: `${BASE_URL}/issue/${identifier}`,
    teamId: team.id,
    projectId: project.id,
    milestoneId: milestoneOfProject(store, project.id, args.milestoneId ?? null),
    title: args.title,
    description: args.description,
    priority: args.priority ?? 0,
    labelIds: labelIdsOf(store, team.id, args.labels ?? []),
    stateId: stateNamed(args.state ?? DEFAULT_STATE).id,
    sortOrder: args.sortOrder ?? number
  }
  store.issues.push(issue)
  return issueView(store, issue)
}

function moveIssue(store: Store, issue: StoredIssue, args: UpdateIssueArgs): void {
  if (args.projectId === null) {
    issue.projectId = null
    issue.milestoneId = null
  } else if (args.projectId !== undefined) {
    const project = find(store.projects, args.projectId, 'Project')
    issue.milestoneId = project.id === issue.projectId ? issue.milestoneId : null
    issue.projectId = project.teamId === issue.teamId ? project.id : refuse(`Project ${project.id} is in another team.`)
  }
  if (args.milestoneId !== undefined) {
    issue.milestoneId = milestoneOfProject(store, issue.projectId, args.milestoneId)
  }
}

function updateIssue(store: Store, args: UpdateIssueArgs): FakeIssue {
  const issue = find(store.issues, args.id, 'Issue')
  moveIssue(store, issue, args)
  issue.title = args.title ?? issue.title
  issue.description = args.description ?? issue.description
  issue.priority = args.priority ?? issue.priority
  issue.labelIds = args.labels === undefined ? issue.labelIds : labelIdsOf(store, issue.teamId, args.labels)
  issue.stateId = args.state === undefined ? issue.stateId : stateNamed(args.state).id
  issue.sortOrder = args.sortOrder ?? issue.sortOrder
  return issueView(store, issue)
}

function sameRelation(relation: FakeRelation, wanted: Omit<FakeRelation, 'id'>): boolean {
  if (relation.type !== wanted.type) {
    return false
  }
  const forward = relation.issueId === wanted.issueId && relation.relatedIssueId === wanted.relatedIssueId
  const backward = relation.issueId === wanted.relatedIssueId && relation.relatedIssueId === wanted.issueId
  return forward || (wanted.type === 'related' && backward)
}

function createRelation(store: Store, wanted: Omit<FakeRelation, 'id'>): FakeRelation {
  find(store.issues, wanted.issueId, 'Issue')
  find(store.issues, wanted.relatedIssueId, 'Issue')
  if (wanted.issueId === wanted.relatedIssueId) {
    refuse('An issue cannot relate to itself.')
  }
  if (store.relations.some((relation) => sameRelation(relation, wanted))) {
    refuse(`A ${wanted.type} relation between ${wanted.issueId} and ${wanted.relatedIssueId} already exists.`)
  }
  const relation = { id: nextId(store, 'rel'), ...wanted }
  store.relations.push(relation)
  return { ...relation }
}

function createLabel(store: Store, args: { teamId: string; name: string }): FakeLabel {
  const team = find(store.teams, args.teamId, 'Team')
  const name = args.name.trim()
  if (store.labels.some((label) => label.teamId === team.id && label.name.toLowerCase() === name.toLowerCase())) {
    refuse(`Label "${name}" already exists in team ${team.key}.`)
  }
  const label = { id: nextId(store, 'lbl'), teamId: team.id, name }
  store.labels.push(label)
  return { ...label }
}

function createProject(store: Store, args: { teamId: string; name: string; summary: string; content: string }): FakeProject {
  const team = find(store.teams, args.teamId, 'Team')
  const id = nextId(store, 'prj')
  const slug = args.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const project = { id, teamId: team.id, name: args.name, summary: args.summary, content: args.content, url: `${BASE_URL}/project/${slug}-${id}` }
  store.projects.push(project)
  return { ...project }
}

function createMilestone(store: Store, args: { projectId: string; name: string; description: string }): FakeMilestone {
  const project = find(store.projects, args.projectId, 'Project')
  const sortOrder = store.milestones.filter((item) => item.projectId === project.id).length + 1
  const milestone = { id: nextId(store, 'ms'), projectId: project.id, name: args.name, description: args.description, sortOrder }
  store.milestones.push(milestone)
  return { ...milestone }
}

function milestonesOf(store: Store, projectId: string): FakeMilestone[] {
  find(store.projects, projectId, 'Project')
  return store.milestones
    .filter((item) => item.projectId === projectId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => ({ ...item }))
}

/** One page of the project's issues, in creation order; `after` is the last id of the page before. */
function listIssues(store: Store, args: { projectId: string; first?: number; after?: string }) {
  find(store.projects, args.projectId, 'Project')
  const all = store.issues.filter((issue) => issue.projectId === args.projectId)
  const start = args.after === undefined ? 0 : all.findIndex((issue) => issue.id === args.after) + 1
  if (start === 0 && args.after !== undefined) {
    refuse(`Cursor ${args.after} is not an issue of the project.`)
  }
  const page = all.slice(start, start + (args.first ?? PAGE_DEFAULT))
  const last = page[page.length - 1]
  const hasNextPage = start + page.length < all.length
  return {
    issues: page.map((issue) => issueView(store, issue)),
    pageInfo: { hasNextPage, endCursor: hasNextPage && last !== undefined ? last.id : null }
  }
}

type ToolRegistration = (server: McpServer, calls: string[]) => void

/** One tool: its arguments are validated against `input` by the SDK before `run`. */
function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  input: Shape,
  run: (args: z.output<z.ZodObject<Shape>>) => object
): ToolRegistration {
  // The SDK validates against the shape; the callback is typed loosely, like the tools in src/mcp.
  const inputSchema: z.ZodRawShape = input
  return (server, calls) => {
    server.registerTool(name, { description, inputSchema }, (args: unknown): CallToolResult => {
      calls.push(name)
      const data = run(args as z.output<z.ZodObject<Shape>>) as Record<string, unknown>
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
    })
  }
}

function readTools(store: Store): ToolRegistration[] {
  const query = { query: z.string().min(1) }
  return [
    tool('list_teams', 'Lists the teams.', {}, () => ({ teams: store.teams.map((team) => ({ ...team })) })),
    tool('list_issue_labels', "Lists a team's issue labels.", { teamId: z.string() }, (args) => ({
      labels: store.labels.filter((label) => label.teamId === args.teamId).map((label) => ({ ...label }))
    })),
    tool('list_issue_statuses', "Lists a team's workflow states with their type.", { teamId: z.string() }, (args) => {
      find(store.teams, args.teamId, 'Team')
      return { statuses: WORKFLOW.map((state) => ({ ...state })) }
    }),
    tool('get_project', 'Gets one project.', { id: z.string() }, (args) => ({ ...find(store.projects, args.id, 'Project') })),
    tool('list_milestones', "Lists a project's milestones in their order.", { projectId: z.string() }, (args) => ({
      milestones: milestonesOf(store, args.projectId)
    })),
    tool(
      'list_issues',
      "Lists a project's issues with their milestone, labels, priority, state type, description and the relations they start, a page at a time.",
      { projectId: z.string(), first: z.number().int().min(1).max(250).optional(), after: z.string().optional() },
      (args) => listIssues(store, args)
    ),
    tool('list_issue_relations', 'Lists the relations an issue is either end of.', { issueId: z.string() }, (args) => {
      find(store.issues, args.issueId, 'Issue')
      const relations = store.relations.filter((item) => item.issueId === args.issueId || item.relatedIssueId === args.issueId)
      return { relations: relations.map((item) => ({ ...item })) }
    }),
    tool('search_projects', 'Finds projects whose name, summary or content holds the text.', query, (args) => ({
      projects: store.projects.filter((item) => includesText(args.query, item.name, item.summary, item.content)).map((item) => ({ ...item }))
    })),
    tool('search_milestones', 'Finds milestones whose name or description holds the text.', query, (args) => ({
      milestones: store.milestones.filter((item) => includesText(args.query, item.name, item.description)).map((item) => ({ ...item }))
    })),
    tool('search_issues', 'Finds issues, in any project or none, whose title or description holds the text.', query, (args) => ({
      issues: store.issues.filter((item) => includesText(args.query, item.title, item.description)).map((item) => issueView(store, item))
    }))
  ]
}

function writeTools(store: Store): ToolRegistration[] {
  return [
    tool('create_issue_label', 'Creates a team label; a second label of the same name is refused.', { teamId: z.string(), name: z.string().min(1) }, (args) =>
      createLabel(store, args)
    ),
    tool(
      'create_project',
      'Creates a project in a team.',
      { teamId: z.string(), name: z.string().min(1), summary: z.string().max(255), content: z.string() },
      (args) => createProject(store, args)
    ),
    tool('create_milestone', 'Creates a milestone at the end of a project.', { projectId: z.string(), name: z.string().min(1), description: z.string() }, (args) =>
      createMilestone(store, args)
    ),
    tool('create_issue', 'Creates an issue in a team and project; labels are names that must exist.', createIssueInput, (args) => ({
      ...createIssue(store, args)
    })),
    tool('update_issue', "Updates an issue's fields, milestone or state, or moves it out of its project with projectId: null.", updateIssueInput, (args) => ({
      ...updateIssue(store, args)
    })),
    tool(
      'create_issue_relation',
      'Relates two issues: blocks (issueId blocks relatedIssueId) or related. An existing relation is refused.',
      { issueId: z.string(), relatedIssueId: z.string(), type: z.enum(['blocks', 'related']) },
      (args) => ({ ...createRelation(store, args) })
    )
  ]
}

function issueLine(store: Store, issue: StoredIssue): string {
  const view = issueView(store, issue)
  const identifierOf = (id: string) => store.issues.find((item) => item.id === id)?.identifier ?? id
  const relations = view.relations.map((item) => `${item.type} ${identifierOf(item.relatedIssueId)}`)
  const labels = view.labels.length === 0 ? '' : ` [${view.labels.join(', ')}]`
  const links = relations.length === 0 ? '' : ` -> ${relations.join(', ')}`
  return `${view.identifier} (${view.stateType}, P${view.priority}) ${view.title}${labels}${links}`
}

function layoutOf(store: Store): string {
  const lines: string[] = []
  for (const project of store.projects) {
    lines.push(`Project ${project.name} <${project.url}>`)
    const inProject = store.issues.filter((issue) => issue.projectId === project.id)
    for (const milestone of milestonesOf(store, project.id)) {
      lines.push(`  Milestone ${milestone.name}`)
      lines.push(...inProject.filter((issue) => issue.milestoneId === milestone.id).map((issue) => `    ${issueLine(store, issue)}`))
    }
    const loose = inProject.filter((issue) => issue.milestoneId === null)
    lines.push(...(loose.length === 0 ? [] : ['  No milestone', ...loose.map((issue) => `    ${issueLine(store, issue)}`)]))
  }
  const outside = store.issues.filter((issue) => issue.projectId === null)
  lines.push(...(outside.length === 0 ? [] : ['Outside any project', ...outside.map((issue) => `  ${issueLine(store, issue)}`)]))
  return lines.join('\n')
}

function serverOf(store: Store, calls: string[]): McpServer {
  const server = new McpServer({ name: 'fake-linear', version: '0.0.0' })
  for (const register of [...readTools(store), ...writeTools(store)]) {
    register(server, calls)
  }
  return server
}

export function createFakeLinear(teams: FakeTeam[] = DEFAULT_TEAMS): FakeLinear {
  const store: Store = {
    teams: teams.map((team) => ({ ...team })),
    labels: [],
    projects: [],
    milestones: [],
    issues: [],
    relations: [],
    numbers: new Map(),
    ids: new Map()
  }
  const calls: string[] = []
  const open: { server: McpServer; client: Client }[] = []
  return {
    calls,
    async connect() {
      const server = serverOf(store, calls)
      const client = new Client({ name: 'fake-linear-client', version: '0.0.0' })
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      open.push({ server, client })
      return client
    },
    dump: () => ({
      teams: store.teams.map((item) => ({ ...item })),
      labels: store.labels.map((item) => ({ ...item })),
      projects: store.projects.map((item) => ({ ...item })),
      milestones: store.milestones.map((item) => ({ ...item })),
      issues: store.issues.map((item) => issueView(store, item)),
      relations: store.relations.map((item) => ({ ...item }))
    }),
    layout: () => layoutOf(store),
    async close() {
      for (const { server, client } of open.splice(0)) {
        await client.close()
        await server.close()
      }
    }
  }
}

/** Calls a fake Linear tool and returns its structured result; a tool error is thrown with its text. */
export async function callLinear<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true || result.structuredContent === undefined) {
    const first = Array.isArray(result.content) ? result.content[0] : undefined
    throw new Error(`${name}: ${first !== undefined && first.type === 'text' ? first.text : 'no result'}`)
  }
  return result.structuredContent as T
}
