/**
 * How the Cursor CLI is started. The launch rules are the ones every agent probe follows
 * (`planCliLaunch`: no shell for a user-chosen path, a Windows `.cmd` shim goes through exactly one
 * `cmd.exe /d /v:off /s /c` parse). The one argument that is not a constant is the model id: it
 * must pass `isSafeModelId`, and for a shim it is wrapped in quotes so that its `,` and `=` stay
 * part of one argument. A model id that does not pass is an error, never escaped.
 */
import { planCliLaunch, windowsProgramKind, type AgentProbeDeps, type ProbeLaunch } from '../../desktop/agentProbe'
import { clip, isSafeModelId } from './cursorProtocol'

interface CursorCommand {
  /** `acp` runs the protocol server; the other two list the models. */
  command: 'acp' | 'models' | '--list-models'
  /** Passed as `--model <id>` before the command; null leaves the choice to Cursor. */
  model: string | null
}

type CursorLaunchDeps = Pick<AgentProbeDeps, 'platform' | 'inspect' | 'comspec'>

/** The process to start for `command`, or an Error saying why none can be started. */
export function cursorLaunch(executablePath: string, { command, model }: CursorCommand, deps: CursorLaunchDeps): ProbeLaunch {
  if (model !== null && !isSafeModelId(model)) {
    throw new Error(`${JSON.stringify(clip(model, 60))} is not a model id Cursor can be started with.`)
  }
  const shim = deps.platform === 'win32' && windowsProgramKind(executablePath) === 'shim'
  const modelArguments = model === null ? [] : ['--model', shim ? `"${model}"` : model]
  const plan = planCliLaunch(executablePath, [...modelArguments, command], deps)
  if ('ok' in plan) {
    throw new Error(plan.reason)
  }
  return plan.launch
}
