/** Forge World routing only. Every mailbox still authorizes its own private member grant. */
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { createDmClient, DM_CLIENT_DESCRIPTOR_ENV, parseDmClientDescriptor, type DmClient, type DmClientDeps, type DmClientDescriptor } from './dmClient'

interface WorldMailRoute {
  project: string
  tokenFile: string
  descriptor: DmClientDescriptor
}

export interface WorldMailDescriptor {
  version: 1
  kind: 'forge-world'
  chatId: string
  generation: string
  folder: string
  routes: WorldMailRoute[]
  recoveryAddress?: string
}

export interface WorldMailClients {
  recovery: DmClient
  projects: { project: string; folder: string; client: DmClient }[]
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const absolute = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && !value.split(/[\\/]/).includes('..')
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

function header(value: unknown): value is WorldMailDescriptor {
  if (!record(value) || value.version !== 1 || value.kind !== 'forge-world') return false
  return id(value.chatId) && id(value.generation) && absolute(value.folder) && Array.isArray(value.routes)
}

function keysOk(value: WorldMailDescriptor): boolean {
  const keys = ['version', 'kind', 'chatId', 'generation', 'folder', 'routes', ...(value.recoveryAddress === undefined ? [] : ['recoveryAddress'])]
  return Object.keys(value).every(key => keys.includes(key)) && (value.recoveryAddress === undefined || typeof value.recoveryAddress === 'string')
}

function routeOk(path: string, world: WorldMailDescriptor, route: unknown, tokens: string): route is WorldMailRoute {
  if (!record(route) || Object.keys(route).length !== 3 || typeof route.project !== 'string' || route.project === '' || !absolute(route.tokenFile)) return false
  const parsed = parseDmClientDescriptor(path, JSON.stringify(route.descriptor))
  return parsed.ok && routeIdentityOk(world, route.project, parsed.value) && dirname(route.tokenFile) === tokens && /^[a-f0-9]{24}\.token$/.test(basename(route.tokenFile))
}

function routeIdentityOk(world: WorldMailDescriptor, project: string, route: DmClientDescriptor): boolean {
  return route.chatId === world.chatId && route.generation === world.generation && dirname(route.folder) === world.folder && relative(world.folder, route.folder) === project && !/[\\/]/.test(project)
}

function routesOk(path: string, world: WorldMailDescriptor): boolean {
  const tokens = join(dirname(dirname(dirname(dirname(path)))), 'scratch', world.chatId, '.dm', 'grants')
  const names = new Set<string>()
  for (const route of world.routes) {
    if (!routeOk(path, world, route, tokens) || names.has(route.project)) return false
    names.add(route.project)
  }
  return true
}

/** A route is tied to the same launch, an immediate world member, and that chat's own private token directory. */
export function parseWorldMailDescriptor(path: string, text: string): WorldMailDescriptor | null {
  if (text.length > 1024 * 1024) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!header(value) || !keysOk(value)) return null
  if (basename(path) !== value.generation + '.json' || basename(dirname(path)) !== 'dm-client' || basename(dirname(dirname(path))) !== value.chatId) return null
  return routesOk(path, value) ? value : null
}

/** null is an ordinary/project-less launch; malformed world routing fails closed through the normal client. */
export async function worldMailClients(deps: DmClientDeps): Promise<WorldMailClients | null> {
  const path = Object.entries(deps.env).find(([name]) => deps.platform === 'win32' ? name.toUpperCase() === DM_CLIENT_DESCRIPTOR_ENV : name === DM_CLIENT_DESCRIPTOR_ENV)?.[1]
  if (!path) return null
  let initial: WorldMailDescriptor | null
  try { initial = parseWorldMailDescriptor(path, await deps.readFile(path)) } catch { return null }
  if (!initial) return null
  const rootClient = createDmClient(deps)
  const projects = initial.routes.map(route => {
    const current = async (): Promise<WorldMailRoute> => {
      const latest = parseWorldMailDescriptor(path, await deps.readFile(path))
      const found = latest?.routes.find(item => item.project === route.project)
      if (!found || latest?.generation !== initial.generation || found.tokenFile !== route.tokenFile || JSON.stringify(found.descriptor) !== JSON.stringify(route.descriptor)) throw new Error('The project mail route is no longer current.')
      return found
    }
    const client = createDmClient({
      ...deps,
      readFile: async file => file === path ? JSON.stringify((await current()).descriptor) : deps.readFile(file),
      token: async () => deps.readFile((await current()).tokenFile),
    })
    // Root recovery is delivered once, not once per member; root chats have no per-project board outbox.
    const { readRecovery: _recovery, ...member } = client
    return { project: route.project, folder: route.descriptor.folder, client: { ...member, readBoard: async () => ({ ok: true as const, data: [] }) } }
  })
  return { recovery: rootClient, projects }
}
