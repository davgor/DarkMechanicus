/** Builds the copy-paste MCP connection snippet shown in the desktop app. Pure: no Electron imports. */
import { join } from 'node:path'
import type { McpConfigView } from '../../shared/desktop/api'

interface McpConfigOptions {
  /** `app.isPackaged`. */
  packaged: boolean
  /** `process.execPath`: the app executable, used as the Node runtime when packaged. */
  execPath: string
  /** `app.getAppPath()`: the project root in development, `…/resources/app.asar` when packaged. */
  appPath: string
  repoPath: string
  /**
   * The Dark Mechanicus home directory the app resolved. Pinned into the snippet's environment so
   * an agent started from a shell finds the same projects: a GUI app does not inherit a shell's
   * environment, so leaving it to each process to resolve can give the two different directories.
   */
  dmHome?: string
}

interface McpRuntime {
  command: string
  env: Record<string, string>
  note: string
}

function runtimeFor(options: McpConfigOptions): McpRuntime {
  if (options.packaged) {
    return {
      command: options.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      note: 'Uses the installed Dark Mechanicus app as the MCP runtime.'
    }
  }
  return {
    command: 'node',
    env: {},
    note: 'Development build: run `npm run build` first; requires Node 22.13+.'
  }
}

export function buildMcpConfig(options: McpConfigOptions): McpConfigView {
  const runtime = runtimeFor(options)
  const { command, note } = runtime
  const env = {
    ...runtime.env,
    ...(options.dmHome === undefined ? {} : { DARKMECHANICUS_HOME: options.dmHome })
  }
  const args = [join(options.appPath, 'out', 'main', 'mcp.js'), '--repo', options.repoPath]
  const server = { command, args, ...(Object.keys(env).length > 0 ? { env } : {}) }
  const json = JSON.stringify({ mcpServers: { darkmechanicus: server } }, null, 2)
  return { command, args, env, json, note }
}
