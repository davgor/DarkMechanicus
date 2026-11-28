import type { Capability } from '../../core/authz'
import { NAMING_PROTOCOL } from '../../core/desktop/controlProtocol'
import {
  NamingControlError, type NamingErrorCode, type NamingOperation, type NamingReply, type NamingRequest
} from '../../shared/agents/chatNaming'
import {
  createControlServer, type ControlBinding, type ControlClock, type ControlDispatcher, type ControlOperationContext,
  type ControlServerHandle, type ControlServerProtocol
} from '../control/controlServer'

/** Created only by the live grant registry, never reconstructed from historical chat records. */
export interface NamingControlBinding extends ControlBinding {
  readonly grantId: string
  readonly generation: string
  readonly runId?: string
  readonly cardId?: string
  /** Narrow repair authority, rechecked independently of naming (not granted to workers/reviewers). */
  assertRecovery?(): void
  verifyAuthority?(capability: Capability): Promise<void>
}
export type NamingOperationContext = ControlOperationContext<NamingControlBinding>
export type NamingDispatcher = ControlDispatcher<NamingOperation, NamingControlBinding>
interface ControlPipeOptions {
  authorize(token: string): NamingControlBinding
  dispatch?: NamingDispatcher
  clock?: ControlClock
}
export type ControlPipe = ControlServerHandle

const NAMING_SERVER_PROTOCOL: ControlServerProtocol<NamingOperation, NamingRequest, NamingReply, NamingErrorCode, NamingControlBinding> = {
  ...NAMING_PROTOCOL,
  laneOf: (operation) => operation.op === 'recovery_context' ? 'recovery-read' : 'write',
  assertOperation(binding, operation) {
    if (operation.op === 'recover_tooling' || operation.op === 'recovery_context') {
      if (binding.assertRecovery === undefined) throw new NamingControlError('unauthorized')
      binding.assertRecovery()
    }
  },
  async verifyOperation(binding, operation) {
    const verify = binding.verifyAuthority
    if (verify !== undefined) {
      await verify('chat.name')
      if (operation.op === 'recover_tooling') await verify('tooling.recover')
    }
  }
}

/** The naming/tooling-recovery desktop pipe: `\\.\pipe\dm-desktop-<uuid>` on Windows, a socket in a `dm-n-` temp directory on POSIX. */
export function createControlPipe(options: ControlPipeOptions): Promise<ControlPipe> {
  return createControlServer({ ...options, protocol: NAMING_SERVER_PROTOCOL, addressPrefix: { unix: 'dm-n-', win32: 'dm-desktop-' } })
}
