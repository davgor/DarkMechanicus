/** Entry point for the desktop's private project utility process. */
import { join } from 'node:path'
import { openWorkerLane } from './syncLane'
import { serveWorkspaceOwner } from './workspaceOwnerRuntime'

const [generationArg, ownerPidArg, home, version, packagedArg] = process.argv.slice(-5)
const generation = Number(generationArg)
const ownerPid = Number(ownerPidArg)
const packaged = packagedArg === 'packaged' ? true : packagedArg === 'unpackaged' ? false : undefined
if (home === undefined || version === undefined || packaged === undefined || !Number.isSafeInteger(generation) || !Number.isSafeInteger(ownerPid)) {
  throw new Error('Project utility needs a desktop owner.')
}
// Reconciles run on the sync lane's own thread and connection, so this process keeps serving while one imports.
serveWorkspaceOwner({ generation, ownerPid, home, version, packaged, lane: openWorkerLane(join(__dirname, 'syncLaneWorker.js')) }, process.parentPort)
