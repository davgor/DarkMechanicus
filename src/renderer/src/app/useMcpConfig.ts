import type { McpConfigView } from '../../../shared/desktop/api'
import { useResource } from './useResource'
import type { Resource } from './useResource'

/** The MCP server block for a folder, straight from the main process. */
export function useMcpConfig(path: string, onError: (error: unknown) => void): Resource<McpConfigView> {
  return useResource({ key: path, version: 0, load: () => window.dm.getMcpConfig(path), onError })
}
