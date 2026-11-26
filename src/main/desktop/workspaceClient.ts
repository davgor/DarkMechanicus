import type { DomainErrorShape } from '../../shared/domain/errors'
import type { CommandApi } from '../../shared/domain/api'
import type { ReconcileResultView } from '../../shared/domain/views'
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
  | { type: 'sync'; path: string; authority: ForgeTransferAuthority | undefined; expected: string | undefined; mode: SyncMode }
  | { type: 'close' }
)

export type WorkspaceResponse = { generation: number; id: number } & (
  | { ok: true; result: OwnerResult }
  | { ok: false; error: DomainErrorShape }
)

export interface OwnerResult { value: unknown; binding?: string }

/**
 * A reconcile on the owner's sync lane, which runs beside the work the owner serves.
 * - heartbeat: the automatic reconcile of open and heartbeat: fingerprint-gated, skipped after a branch change.
 * - member: a Forge member's import: fingerprint-gated, and it runs after a branch change, as a member reconcile always has.
 * - explicit: `reconcileRepository`: ungated and full.
 */
export type SyncMode = 'heartbeat' | 'member' | 'explicit'

/** A lane reconcile's result; `result` is null when a heartbeat had nothing it may reconcile. */
export interface SyncValue { result: ReconcileResultView | null; hasLocalCache: boolean }
/** A member or explicit reconcile always reports its result. */
export interface SyncResult { result: ReconcileResultView; hasLocalCache: boolean }

export interface OwnerTransport {
  run(path: string, work: Work, authority?: ForgeTransferAuthority, expected?: string): Promise<OwnerResult>
  /** Runs one reconcile on the owner's sync lane while `run` keeps serving. Its value is a `SyncValue`. */
  sync(path: string, mode: SyncMode, authority?: ForgeTransferAuthority, expected?: string): Promise<OwnerResult>
  close(): Promise<void>
}

/** Work that moves or replaces the project's store: it never overlaps a lane reconcile, which holds its own connection. */
export function exclusiveWork(work: Work): boolean {
  if (work.kind === 'command') return work.name === 'initializeRepository' || work.name === 'switchStorageMode'
  return work.kind === 'native' && (work.name === 'exportForge' || work.name === 'retireForcedForge' || work.name === 'archiveRetiredForge')
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
