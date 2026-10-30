/**
 * Autonomous (`a8s`) as a flavor of the generic ACP adapter (`acp/acpAdapter.ts`). Everything here is
 * from the recording of the installed a8s 0.79.0 (docs/reports/autonomous-acp.md, DM-253 and DM-281).
 *
 * Launch. `a8s start <chat folder> --mode acp --approval-mode always-ask`, plus `--model <id>` when the
 * chat has a model, in the chat's folder. The folder is the built-in preset's whole-argument
 * `{folder}` (`BUILT_IN_LAUNCH_ARGS.autonomous`), so it is the chat's canonical folder. Never
 * `--approval-mode write` or `yolo`: a write would then run without asking.
 *
 * Capabilities. The client declares `elicitation.form`, without which a8s refuses every file write
 * unasked, and no file system or terminal, so a8s writes the files it is allowed to write itself.
 * File writes are asked about with `elicitation/create` (`autonomousApprovals.ts`), shell commands with
 * `session/request_permission` (the generic session's).
 *
 * Sign-in. `authenticate` with the method `initialize` lists (`agent`, "use existing local
 * credentials", in every recorded process), and none when it lists none, as the report advises.
 * What a8s answers when the model sign-in is missing was not observed; an error answer that says so is
 * reported as `auth_required` by the generic adapter.
 *
 * Models. No command lists them: they are the `model` config option `session/new` returns. So the list
 * comes from a short-lived a8s in the temp folder (`initialize`, `authenticate`, `session/new`,
 * `session/close`, no prompt), once per executable while the app runs: starting a8s takes about 11 s.
 * A running chat switches with `session/set_config_option`, and a chat resumed with `session/load`
 * (which reports the model the session was created with) is switched back to its model the same way.
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ModelOption } from '../../../shared/agents/chat'
import { AGENT_DEFINITIONS } from '../../../shared/desktop/agentKinds'
import { planCliLaunch } from '../../desktop/agentProbe'
import { BUILT_IN_LAUNCH_ARGS, withFolder } from '../launchSpec'
import type { AcpDeps, AcpFlavor } from './acp/acpAdapter'
import { AcpSession, LISTED_AUTH_METHOD } from './acp/acpSession'
import { answerElicitation } from './autonomousApprovals'
import { isSafeModelId } from './cursorProtocol'

const NAME = AGENT_DEFINITIONS.autonomous.displayName

/** a8s answers `initialize` in 11 to 17 s; the listing gives up well after that. */
const LIST_MODELS_TIMEOUT_MS = 60_000

function launchArgs(model: string | null): readonly string[] {
  if (model === null) {
    return []
  }
  if (!isSafeModelId(model)) {
    throw new Error(`${JSON.stringify(model)} is not a model id ${NAME} can be started with.`)
  }
  return ['--model', model]
}

/** The models a8s offers, from the `session/new` of a process started only to ask. */
async function readModels(executablePath: string, deps: AcpDeps): Promise<ModelOption[]> {
  const folder = realpathSync(tmpdir())
  const plan = planCliLaunch(executablePath, withFolder(BUILT_IN_LAUNCH_ARGS.autonomous, folder), deps)
  if ('ok' in plan) {
    throw new Error(plan.reason)
  }
  const context = { folder, server: { command: '', args: [], env: {} }, instructions: '', emit: () => {} }
  const session = new AcpSession(autonomousFlavor, deps, plan.launch, context)
  let timedOut = false
  const timer = deps.timers.set(() => {
    timedOut = true
    void session.kill()
  }, LIST_MODELS_TIMEOUT_MS)
  try {
    await session.begin(null)
    await session.close()
  } catch (error) {
    throw timedOut ? new Error(`${NAME} did not answer when asked for its models.`) : error
  } finally {
    deps.timers.clear(timer)
    await session.kill()
  }
  const models = session.models()
  if (models.length === 0) {
    throw new Error(`${NAME} offered no models.`)
  }
  return models
}

/** One listing per executable while the app runs; a failed one is asked again next time. */
const listings = new Map<string, Promise<ModelOption[]>>()

function listAutonomousModels(executablePath: string, deps: AcpDeps): Promise<ModelOption[]> {
  const known = listings.get(executablePath)
  if (known !== undefined) {
    return known
  }
  const listing = readModels(executablePath, deps)
  listings.set(executablePath, listing)
  void listing.catch(() => {
    listings.delete(executablePath)
  })
  return listing
}

export const autonomousFlavor: AcpFlavor = {
  kind: 'autonomous',
  displayName: NAME,
  authMethodId: LISTED_AUTH_METHOD,
  clientCapabilities: { elicitation: { form: {} } },
  extensions: { 'elicitation/create': answerElicitation },
  launchArgs,
  listModels: listAutonomousModels,
  switchModel: 'config_option'
}
