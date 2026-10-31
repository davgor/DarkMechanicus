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
 * Without a model sign-in a8s answers no request: it stops at launch, before answering `initialize`,
 * with a sentence on stderr (recorded with an isolated profile, DM-307, `__mocks__/autonomousSignedOut.ts`).
 * That stop is reported as `auth_required` with a8s's sentence (`readSignedOut`); an ACP
 * authentication-required answer still is too, by the generic adapter.
 *
 * Models. No command lists them: they are the `model` config option `session/new` returns. So the list
 * comes from a short-lived a8s in a fresh, empty, canonical subfolder of the temp folder (`initialize`,
 * `authenticate`, `session/new`, `session/close`, no prompt), removed afterwards, once per executable
 * while the app runs: starting a8s takes about 11 s. Never the temp root itself: a8s's repository
 * check fails there (`scandir: EPERM` on macOS's `TemporaryItems`, DM-300).
 * A running chat switches with `session/set_config_option`, and a chat resumed with `session/load`
 * (which reports the model the session was created with) is switched back to its model the same way.
 */
import type { ModelOption } from '../../../shared/agents/chat'
import { AGENT_DEFINITIONS } from '../../../shared/desktop/agentKinds'
import { planCliLaunch } from '../../desktop/agentProbe'
import { BUILT_IN_LAUNCH_ARGS, withFolder } from '../launchSpec'
import { createHandshakeFolders } from '../protocolHandshake'
import type { AcpError } from './acpClient'
import type { AcpDeps, AcpFlavor } from './acp/acpAdapter'
import { AcpSession, LISTED_AUTH_METHOD } from './acp/acpSession'
import { answerElicitation } from './autonomousApprovals'
import { isSafeModelId } from './cursorProtocol'

const NAME = AGENT_DEFINITIONS.autonomous.displayName

/** a8s answers `initialize` in 11 to 17 s; the listing gives up well after that. */
const LIST_MODELS_TIMEOUT_MS = 60_000

/**
 * The last stderr line of the two stops a8s 0.79.0 made at launch with no model sign-in, as the process's
 * end reaches the connection (`Autonomous stopped: exit code N: <stderr tail>`): a profile whose
 * subscription has no sign-in ("Autonomous stopped: Your selected subscription is signed out. Run a8s
 * init --force; ...") and no profile at all ("Profile not found: <path>. Run a8s init to create it, ...").
 * Both are fixed by `a8s init`, the sign-in the app runs for Autonomous.
 */
const SIGNED_OUT_STOP = /(?:^|: )(Your selected subscription is signed out\. Run a8s init\b[^\n]*|Profile not found: [^\n]*\. Run a8s init\b[^\n]*)$/

/** a8s's sentence when its process stopped for want of a model sign-in; null for any other error. */
function readSignedOut(error: AcpError): string | null {
  return SIGNED_OUT_STOP.exec(error.message)?.[1] ?? null
}

function launchArgs(model: string | null): readonly string[] {
  if (model === null) {
    return []
  }
  if (!isSafeModelId(model)) {
    throw new Error(`${JSON.stringify(model)} is not a model id ${NAME} can be started with.`)
  }
  return ['--model', model]
}

/** The models a8s offers, from the `session/new` of a process started only to ask, in `folder`. */
async function readModelsIn(executablePath: string, deps: AcpDeps, folder: string): Promise<ModelOption[]> {
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

/** Lists in a fresh temp subfolder, removed after success, failure and timeout alike. */
async function readModels(executablePath: string, deps: AcpDeps): Promise<ModelOption[]> {
  const folders = deps.tempFolders ?? createHandshakeFolders()
  const folder = folders.makeTempDir()
  try {
    return await readModelsIn(executablePath, deps, folder)
  } finally {
    try {
      folders.removeDir(folder)
    } catch {
      // A temp folder left behind (a file still held open on Windows) is the system's to clean up.
    }
  }
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
  readSignedOut,
  launchArgs,
  listModels: listAutonomousModels,
  switchModel: 'config_option'
}
