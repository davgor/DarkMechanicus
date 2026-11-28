/**
 * DM-1042 spike: the physical-ESC kill switch, end to end, for the person's S5 checkpoint.
 *
 *   node scripts/spike/desktop/esc-probe.mjs              shows the red border on every display and waits (5 min) for
 *                                                         a physical Escape; prints `PHYSICAL ESC → kill in <ms>`
 *   node scripts/spike/desktop/esc-probe.mjs --self-test  agent check: shows the border, injects Escape twice (from the
 *                                                         hook helper and from a separate process, as an agent would),
 *                                                         and exits 0 only if neither fired the kill
 *
 * It starts the overlay (repo Electron, ELECTRON_RUN_AS_NODE deleted from its environment), the WH_KEYBOARD_LL hook
 * helper and a stand-in for the computer-use process tree (node → powershell sending tagged keys the hook swallows, so
 * no window receives them). The kill ends that tree with taskkill /T /F and closes every overlay window. `<ms>` is the
 * time from the hook callback that saw the key-down to the overlay reporting its windows destroyed, on one
 * QueryPerformanceCounter clock. Imported by no product code.
 */
import { spawnSync } from 'node:child_process'
import { controller, injectEsc, msBetween, startAgentTree, startHook, startOverlay } from './overlay/control.mjs'

const SELF_TEST = process.argv.includes('--self-test')
const WAIT_MS = 5 * 60_000
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const print = (text) => process.stdout.write(`${text}\n`)

async function selfTest(ctl, hook, overlay) {
  hook.send('esc')
  const fromHelper = await hook.next((line) => line.type === 'key' && line.vk === 0x1b && line.kind === 2 && line.down, 5000)
  const fromProcess = await injectEsc(hook.ready.pid)
  await sleep(1500)
  const escapes = hook.lines.filter((line) => line.type === 'key' && line.vk === 0x1b && line.down)
  overlay.send({ cmd: 'list' })
  const list = await overlay.next((line) => line.list === true, 5000)
  const result = {
    selfTest: true,
    electronRunAsNodeInParent: 'ELECTRON_RUN_AS_NODE' in process.env,
    electronRunAsNodeStripped: overlay.envStripped,
    overlayWindows: list.windows.length,
    displays: list.displays.length,
    escapesSeen: escapes.map((line) => ({ injected: line.injected, own: line.own, kind: line.kind, lagMs: line.lagMs })),
    injectToCallbackMs: msBetween(fromProcess.qpcNs, escapes.at(-1).qpcNs),
    helperEscapeInjected: fromHelper.injected,
    killFired: ctl.state.killed !== null,
    maxHeartbeatGapMs: ctl.state.maxHbGapMs
  }
  result.pass = !result.killFired && escapes.length >= 2 && escapes.every((line) => line.injected) && result.overlayWindows >= 1 && result.electronRunAsNodeStripped
  return result
}

async function main() {
  const overlay = await startOverlay()
  const hook = await startHook()
  const tree = startAgentTree(hook.ready.pid, 50)
  await tree.started
  const ctl = controller({ overlay, hook, tree })
  print(`Red border shown on ${overlay.shown.windows.length} display(s). Hook helper pid ${hook.ready.pid}, stand-in agent tree pid ${tree.child.pid}.`)
  if (SELF_TEST) {
    const result = await selfTest(ctl, hook, overlay)
    await ctl.stop()
    spawnSync('taskkill.exe', ['/PID', String(tree.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    overlay.cleanup()
    print(JSON.stringify(result))
    print(result.pass ? 'SELF-TEST PASS: injected ESC seen as injected, no kill.' : 'SELF-TEST FAIL')
    process.exit(result.pass ? 0 : 1)
  }
  print('Press Esc on the physical keyboard to stop the agent.')
  const timeout = sleep(WAIT_MS).then(() => null)
  const record = await Promise.race([ctl.killed, timeout])
  hook.send('quit')
  overlay.cleanup()
  if (!record) {
    await ctl.stop()
    spawnSync('taskkill.exe', ['/PID', String(tree.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    print('No Escape within 5 minutes; border removed.')
    process.exit(2)
  }
  const ms = record.triggerToOverlayClosedMs ?? record.triggerToOverlayExitMs
  print(record.reason === 'physical-esc' ? `PHYSICAL ESC \u2192 kill in ${ms.toFixed(1)} ms` : `KILL (${record.reason}) \u2192 ${ms.toFixed(1)} ms`)
  print(JSON.stringify({ ...record, injectedEscapesIgnored: ctl.state.ignored.length }))
  process.exit(record.reason === 'physical-esc' ? 0 : 1)
}

await main()
