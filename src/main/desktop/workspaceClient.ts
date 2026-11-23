import type { DomainErrorShape } from '../../shared/domain/errors'
import type { CommandApi } from '../../shared/domain/api'
import { DESKTOP_COMMANDS, type DesktopCommandName } from '../../shared/desktop/api'
import type { NativeOperations } from './workspaceOperations'
import type { ForgeTransferAuthority } from '../../core/repo/forgeBinding'

export const NATIVE_COMMANDS = ['renewGrant', 'addKanbanMessage'] as const
type NativeCommand = (typeof NATIVE_COMMANDS)[number]
type WorkspaceCommand = DesktopCommandName | NativeCommand

type Operation = keyof NativeOperations
type OperationArgs<K extends Operation> = Parameters<NativeOperations[K]>
export type OperationResult<K extends Operation> = Awaited<ReturnType<NativeOperations[K]>>

type NativeWork = { [K in Operation]: { kind: 'native'; name: K; args: OperationArgs<K> } }[Operation]

export type Work =
  | { kind: 'command'; name: WorkspaceCommand; input: unknown }
  | NativeWork
  | { kind: 'heartbeat' }

export type WorkspaceRequest = {
  generation: number
  id: number
} & (
  | { type: 'work'; path: string; authority: ForgeTransferAuthority | undefined; expected: string | undefined; work: Work }
  | { type: 'close' }
)

export type WorkspaceResponse = { generation: number; id: number } & (
  | { ok: true; result: OwnerResult }
  | { ok: false; error: DomainErrorShape }
)

export interface OwnerResult { value: unknown; binding?: string }

export interface OwnerTransport {
  run(path: string, work: Work, authority?: ForgeTransferAuthority, expected?: string): Promise<OwnerResult>
  close(): Promise<void>
}

export type ProjectWorkspace = Pick<CommandApi, WorkspaceCommand> & {
  readonly repoRoot: string
  readonly current: boolean
  call<K extends Operation>(name: K, ...args: OperationArgs<K>): Promise<OperationResult<K>>
}

export function workspaceClient(
  repoRoot: string,
  isCurrent: () => boolean,
  submit: (work: Work) => Promise<unknown>
): ProjectWorkspace {
  const commands = Object.fromEntries([...DESKTOP_COMMANDS, ...NATIVE_COMMANDS].map(name => [
    name, (input: unknown) => submit({ kind: 'command', name, input })
  ])) as Pick<CommandApi, WorkspaceCommand>
  return {
    ...commands,
    repoRoot,
    get current() { return isCurrent() },
    call: (name, ...args) => submit({ kind: 'native', name, args } as NativeWork) as Promise<never>
  }
}
