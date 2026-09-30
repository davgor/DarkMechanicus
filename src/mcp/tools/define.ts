import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import type { CommandApi } from '../../shared/domain/api'
import { runTool } from '../result'

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

/** A tool that can be registered on any server against any `CommandApi`. */
export interface ToolSpec {
  readonly name: string
  register(server: McpServer, api: CommandApi): void
}

interface ToolBase {
  name: string
  /** Teaches agents the rules of the command; keep it short and concrete. */
  description: string
  kind: ToolKind
}

interface ErasedTool extends ToolBase {
  input: z.ZodRawShape | undefined
  run(api: CommandApi, input: unknown): Promise<unknown>
}

function registerErased(server: McpServer, api: CommandApi, tool: ErasedTool): void {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.input, annotations: ANNOTATIONS[tool.kind] },
    (input: unknown) => runTool(() => tool.run(api, input))
  )
}

/**
 * Defines a tool whose input is a zod raw shape. The SDK validates arguments against `input` before
 * the callback runs, so the value reaching `run` always has the shape's output type.
 */
export function defineTool<Shape extends z.ZodRawShape>(
  tool: ToolBase & {
    input: Shape
    run: (api: CommandApi, input: z.output<z.ZodObject<Shape>>) => Promise<unknown>
  }
): ToolSpec {
  return {
    name: tool.name,
    register: (server, api) =>
      registerErased(server, api, {
        ...tool,
        run: (target, input) => tool.run(target, input as z.output<z.ZodObject<Shape>>)
      })
  }
}

/** Defines a tool without arguments (clients may then omit `arguments` entirely). */
export function defineArglessTool(tool: ToolBase & { run: (api: CommandApi) => Promise<unknown> }): ToolSpec {
  return {
    name: tool.name,
    register: (server, api) =>
      registerErased(server, api, { ...tool, input: undefined, run: (target) => tool.run(target) })
  }
}

export function registerTools(server: McpServer, api: CommandApi, specs: readonly ToolSpec[]): void {
  for (const spec of specs) {
    spec.register(server, api)
  }
}
