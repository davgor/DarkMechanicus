/** Entry point for the desktop's private project utility process. */
import { serveWorkspaceOwner } from './workspaceOwnerRuntime'

const [generationArg, ownerPidArg, home, version] = process.argv.slice(-4)
const generation = Number(generationArg)
const ownerPid = Number(ownerPidArg)
if (home === undefined || version === undefined || !Number.isSafeInteger(generation) || !Number.isSafeInteger(ownerPid)) {
  throw new Error('Project utility needs a desktop owner.')
}
serveWorkspaceOwner({ generation, ownerPid, home, version }, process.parentPort)
