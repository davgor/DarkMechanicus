/**
 * The ACP flavor for a custom CLI: nothing beyond the protocol itself. No `authenticate` (the app
 * cannot tell how such a CLI signs in), no launch arguments of its own (the launch spec's come first
 * and are all there is), no model list (the CLI runs on its own default) and no model switching.
 */
import type { AcpFlavor } from './acpAdapter'

export function genericAcpFlavor(displayName: string): AcpFlavor {
  return {
    kind: 'custom',
    displayName,
    authMethodId: null,
    extensions: {},
    launchArgs: () => [],
    listModels: () => Promise.resolve([]),
    switchModel: 'none'
  }
}
