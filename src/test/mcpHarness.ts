/**
 * In-memory MCP client/server rig for adapter tests: a real SDK `Client` talks to the server under
 * test over linked in-memory transports, so tests cover schema validation and result shaping too.
 * Not shipped.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { encodeBase32, ID_PREFIXES, type IdKind } from '../core/ids'
import type { CommandApi } from '../shared/domain/api'
import type { StubApi } from './stubApi'

export interface McpRig {
  client: Client
  api: StubApi
}

/** What a tool call returned, reduced to the parts adapters promise to keep stable. */
export interface ToolOutcome {
  isError: boolean
  payload: Record<string, unknown> | undefined
  text: string
}

/** A well-formed stable id of the given kind, e.g. `sampleId('epic', 1)` -> `ep_000…001`. */
export function sampleId(kind: IdKind, n = 1): string {
  return `${ID_PREFIXES[kind]}_${encodeBase32(BigInt(n), 26)}`
}

/** Builds a bare server carrying just one registration function, for per-area tool tests. */
export function areaServer(
  register: (server: McpServer, api: CommandApi) => void
): (api: CommandApi) => McpServer {
  return (api) => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    register(server, api)
    return server
  }
}

export async function withRig<T>(
  build: (api: CommandApi) => McpServer,
  api: StubApi,
  body: (rig: McpRig) => Promise<T>
): Promise<T> {
  const server = build(api)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    return await body({ client, api })
  } finally {
    await client.close()
    await server.close()
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export async function callTool(
  rig: McpRig,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolOutcome> {
  const result = await rig.client.callTool({ name, arguments: args })
  const first = Array.isArray(result.content) ? result.content[0] : undefined
  return {
    isError: result.isError === true,
    payload: asRecord(result.structuredContent),
    text: first !== undefined && first.type === 'text' ? first.text : ''
  }
}
