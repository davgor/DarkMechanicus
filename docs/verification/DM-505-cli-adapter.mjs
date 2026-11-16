/**
 * DM-505 acceptance driver (c4): the installed OMP, no model, loads DM-505-cli-adapter-probe.ts, which imports the
 * accepted resources/skitarii/extension/dmClient.ts and drives the real built `dm` CLI through a private descriptor.
 *
 * Scratch only: a scratch Git repository whose path has spaces, an apostrophe, %, ^, !, & and Unicode, a scratch
 * DARKMECHANICUS_HOME, two desktop-provisioned endpoints with bound scratch grants (real core services, desktop role),
 * and a scratch PI_CODING_AGENT_DIR for OMP (no auth copied: no model is used). The descriptor is assembled from the
 * product's `buildCliConfig` + `dmClientRuntime` (src/main/desktop/cliConfig.ts) in the shape `writeDmClientDescriptor`
 * writes; terminalFiles.ts itself imports Vite `?raw` modules that cannot load outside the bundle. PATH starts with a
 * folder of decoy `electron`/`node`/`DarkMechanicus`/`dm` programs that record any use. Runs the development resource
 * root and a packaged-layout copy (resources/skitarii with no src/ beside it).
 *
 * Usage, from the worktree root after `npm run build`:
 *   env -u CI -u DM_DESKTOP_PIPE -u DM_SESSION_TOKEN node --import tsx docs/verification/DM-505-cli-adapter.mjs
 * Writes docs/verification/DM-505-cli-adapter-results.json; removes its scratch folder. Exits 1 when a check failed.
 */
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openWorkspace } from '../../src/core/workspace.ts'
import * as mail from '../../src/core/services/agentMail.ts'
import { buildCliConfig, dmClientRuntime } from '../../src/main/desktop/cliConfig.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WT = join(HERE, '..', '..')
const ELECTRON = join(WT, 'node_modules', 'electron', 'dist', readFileSync(join(WT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim())
const OMP = process.env.DM505_OMP ?? join(process.env.LOCALAPPDATA ?? '', 'omp', 'omp.exe')
const RESULTS = join(HERE, 'DM-505-cli-adapter-results.json')
for (const name of ['DM_DESKTOP_PIPE', 'DM_SESSION_TOKEN']) {
  if (process.env[name]) throw new Error(`Unset ${name} first.`)
}

const S = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm505-adapter-')))
const AWKWARD = "it's & (ü 漢) %PATH% ^!"
const REPO = join(S, `repo ${AWKWARD}`)
const HOME_DIR = join(S, 'dm home')
const USER_DATA = join(S, 'userData')
const DECOY = join(S, 'decoy bin')
const DECOY_LOG = join(S, 'decoy-used.txt')
for (const dir of [REPO, HOME_DIR, USER_DATA, DECOY]) mkdirSync(dir, { recursive: true })

const checks = []
function check(id, pass, detail) {
  checks.push({ id, criteria: ['c4'], pass: pass === true, detail })
  console.log(`${pass === true ? 'PASS' : 'FAIL'} ${id}${pass === true ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`)
}

// Decoy runtimes on PATH: a .cmd for each name, and a copy of whoami.exe as each .exe.
for (const name of ['electron', 'node', 'DarkMechanicus', 'dm', 'bun']) {
  writeFileSync(join(DECOY, `${name}.cmd`), `@echo off\r\necho ${name}>>"${DECOY_LOG}"\r\n`)
  copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), join(DECOY, `${name}.exe`))
}

execFileSync('git', ['init', '-q'], { cwd: REPO })
execFileSync('git', ['-c', 'user.name=dm505', '-c', 'user.email=dm505@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'scratch'], { cwd: REPO })
const desk = openWorkspace({ repoRoot: REPO, role: 'desktop', label: 'Desktop (DM-505 adapter)', transport: 'desktop', pid: process.pid, homeDir: HOME_DIR })
await desk.initializeRepository({ name: 'dm505-adapter' })
const folder = desk.ctx().projectRoot
async function bound(chatId, name, role) {
  const endpoint = mail.provisionAgentMailEndpoint(desk.ctx(), { chatId, name })
  const { grant, token } = await desk.issueGrant({ role, label: chatId })
  mail.bindAgentMailEndpoint(desk.ctx(), { endpointId: endpoint.id, grantId: grant.id })
  return { endpointId: endpoint.id, grantId: grant.id, token }
}
const alpha = await bound('ch_dm505_alpha', 'Alpha', 'worker')
const beta = await bound('ch_dm505_beta', 'Beta', 'reviewer')

// The descriptor main writes for alpha's launch, from the product's runtime pinning.
const cli = buildCliConfig({ execPath: ELECTRON, appPath: WT, repoPath: folder, dmHome: HOME_DIR })
const runtime = dmClientRuntime(cli, folder)
const generation = '5f0c1d2e-dm50-4505-a505-000000000505'
const descriptorDir = join(USER_DATA, 'agents', 'omp', 'ch_dm505_alpha', 'dm-client')
mkdirSync(descriptorDir, { recursive: true })
const descriptorPath = join(descriptorDir, `${generation}.json`)
const inherit = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'PATHEXT', 'SystemRoot', 'windir', 'SystemDrive', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH']
writeFileSync(descriptorPath, `${JSON.stringify({ version: 1, chatId: 'ch_dm505_alpha', generation, folder, command: runtime.command, args: [...runtime.args], cwd: folder, env: runtime.env, inherit }, null, 2)}\n`)

const packagedRoot = join(S, 'packaged', 'resources')
cpSync(join(WT, 'resources', 'skitarii'), join(packagedRoot, 'skitarii'), { recursive: true })

function ompEnv(extra) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/^(DM_|DARKMECHANICUS_|ELECTRON_|NODE_OPTIONS|PI_|OMP_|CI$)/.test(name)) delete env[name]
  return { ...env, PATH: `${DECOY};${process.env.PATH ?? ''}`, ...extra }
}

function listScratchProcesses() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${S.replace(/'/g, "''")}') -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.Name }`], { encoding: 'utf8' })
  return out.split(/\r?\n/).filter((line) => line.trim() !== '' && !/powershell/i.test(line))
}

async function runOmp(layout, root) {
  const out = join(S, `probe-${layout}.json`)
  const agentDir = join(S, `omp-agent-${layout}`)
  mkdirSync(agentDir, { recursive: true })
  const env = ompEnv({
    PI_CODING_AGENT_DIR: agentDir,
    DM_SKITARII_CLIENT_DESCRIPTOR: descriptorPath,
    DM_SESSION_TOKEN: alpha.token,
    SMOKE_BETA_TOKEN: beta.token,
    SMOKE_EXTENSION_ROOT: root,
    SMOKE_OUT: out,
    SMOKE_SUFFIX: layout === 'development' ? '' : `-${layout}`
  })
  const child = spawn(OMP, ['--mode', 'rpc', '--no-ui', '--no-session', '--no-extensions', '-e', join(HERE, 'DM-505-cli-adapter-probe.ts')], { cwd: folder, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
  child.stdout.on('data', () => {})
  const started = Date.now()
  while (!existsSync(out) && Date.now() - started < 90_000 && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 250))
  await new Promise((resolve) => setTimeout(resolve, 500))
  const during = listScratchProcesses()
  child.stdin.end()
  const exited = await Promise.race([new Promise((resolve) => child.once('exit', (code) => resolve({ code }))), new Promise((resolve) => setTimeout(() => resolve(null), 10_000))])
  if (exited === null) child.kill()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const after = listScratchProcesses()
  const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { error: `no report; omp stderr: ${stderr.slice(0, 1500)}` }
  return { report, exited, stderrHasSecret: [alpha.token, beta.token].some((t) => stderr.includes(t)), processesWhileOmpRunning: during, processesAfterOmpExit: after, ms: Date.now() - started }
}

const results = {
  ticket: 'DM-505',
  criteria: ['c4'],
  startedAt: new Date().toISOString(),
  environment: {
    os: `${process.platform}`,
    installedOmp: execFileSync(OMP, ['--version'], { encoding: 'utf8' }).trim(),
    ompPath: OMP.replace(process.env.LOCALAPPDATA ?? '\u0000', '%LOCALAPPDATA%'),
    cliRuntime: 'repository node_modules/electron/dist/electron.exe with ELECTRON_RUN_AS_NODE=1',
    commit: execFileSync('git', ['-C', WT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  },
  descriptorSource: 'buildCliConfig + dmClientRuntime (src/main/desktop/cliConfig.ts), shape of writeDmClientDescriptor',
  runs: {}
}

for (const [layout, root] of [['development', join(WT, 'resources', 'skitarii', 'extension')], ['packaged-layout', join(packagedRoot, 'skitarii', 'extension')]]) {
  const run = await runOmp(layout, root)
  results.runs[layout] = run
  const r = run.report
  const tag = (id) => `${layout}.${id}`
  check(tag('probe-ran-in-installed-omp-bun'), typeof r.bun === 'string' && /omp\.exe$/i.test(r.ompExecPath ?? '') && !r.error, { bun: r.bun, error: r.error })
  check(tag('descriptor-no-secret-absolute-runtime'), r.descriptor?.holdsSecret === false && r.descriptor.parsed.command === ELECTRON && !JSON.stringify(r.descriptor.parsed).includes('DM_SESSION_TOKEN'), { holdsSecret: r.descriptor?.holdsSecret, command: r.descriptor?.parsed.command })
  const real = (r.spawns ?? []).filter((s) => s.label !== 'missing' && s.label !== 'noGrant')
  check(tag('shell-free-pinned-spawn'), real.length > 0 && real.every((s) => s.command === ELECTRON && s.commandAbsolute && s.shell === false && s.windowsHide === true && s.cwd === folder && s.args[0] === runtime.args[0] && s.args[1] === '--repo' && s.args[2] === folder && s.args[3] === 'call' && s.args.at(-1) === '-'), real.map((s) => ({ label: s.label, shell: s.shell, args: s.args })))
  check(tag('child-env-allowlisted'), real.every((s) => s.envNames.every((n) => inherit.includes(n) || ['ELECTRON_RUN_AS_NODE', 'DARKMECHANICUS_HOME', 'DM_SESSION_TOKEN'].includes(n)) && !s.envNames.includes('PI_CODING_AGENT_DIR') && !s.envNames.includes('SMOKE_BETA_TOKEN')), real[0]?.envNames)
  check(tag('no-path-runtime-lookup'), !existsSync(DECOY_LOG) && r.identity?.ok === true, { decoyUsed: existsSync(DECOY_LOG), pathStartsWithDecoys: true })
  check(tag('identity-and-peers'), r.identity?.ok && r.identity.data.endpointId === alpha.endpointId && r.peersSawBeta === true, r.identity)
  check(tag('literal-stdin-json-unicode'), r.send?.ok && r.send.data.duplicate === false && r.readBack?.bodyExact === true && r.readBack.from?.endpointId === alpha.endpointId && r.sendRetry?.ok && r.sendRetry.data.duplicate === true && r.sendRetry.data.messageId === r.send.data.messageId, { send: r.send, readBack: r.readBack, retryDuplicate: r.sendRetry?.data?.duplicate })
  check(tag('agents-md-native-example-reply-ack'), r.docReply?.ok && r.docReply.data.inReplyTo === r.send?.data?.messageId && r.docAck?.ok && r.docAck.data.acknowledged.length === 1, { reply: r.docReply, ack: r.docAck })
  check(tag('status-and-wake-polls'), r.alphaStatus?.ok && r.alphaStatus.data.pendingCount >= 1 && r.alphaWake?.ok && r.alphaWake.data.claimed === false, { status: r.alphaStatus?.data?.pendingCount, wake: r.alphaWake?.data })
  check(tag('abort-kills-live-child'), r.aborted?.ok === false && r.aborted.error.code === 'aborted' && r.abortMs < 2000, { aborted: r.aborted, ms: r.abortMs })
  check(tag('cancelAll-kills-live-child-client-stays-usable'), r.cancelled?.ok === false && r.cancelled.error.code === 'cancelled' && r.usableAfterCancelAll?.ok === true, { cancelled: r.cancelled, after: r.usableAfterCancelAll?.ok })
  check(tag('no-leftover-child'), Array.isArray(r.pidsAliveAfter) && r.pidsAliveAfter.every((a) => a === false) && run.processesAfterOmpExit.length === 0, { pidsAliveAfter: r.pidsAliveAfter, scratchProcessesAfterExit: run.processesAfterOmpExit })
  check(tag('refusals'), r.badToken?.error?.source === 'dm' && r.badToken.error.code === 'unauthorized' && r.notAllowed?.error?.code === 'command_not_allowed' && r.noGrant?.error?.code === 'no_grant' && r.missingDescriptor?.error?.code === 'descriptor_missing', { badToken: r.badToken?.error, notAllowed: r.notAllowed?.error, noGrant: r.noGrant?.error, missing: r.missingDescriptor?.error })
  check(tag('credentials-never-in-descriptor-argv-errors'), r.secretInErrors === false && r.secretInArgs === false && r.descriptor?.holdsSecret === false && run.stderrHasSecret === false && !JSON.stringify(r).includes(alpha.token) && !JSON.stringify(r).includes(beta.token), { secretInErrors: r.secretInErrors, secretInArgs: r.secretInArgs, stderrHasSecret: run.stderrHasSecret })
  check(tag('omp-exited-cleanly'), run.exited !== null, run.exited)
}

desk.close()
results.checks = checks
results.finishedAt = new Date().toISOString()
let text = JSON.stringify(results, null, 2)
for (const token of [alpha.token, beta.token]) text = text.split(token).join('[token]')
text = text.split(S).join('<scratch>')
writeFileSync(RESULTS, `${text}\n`)
rmSync(S, { recursive: true, force: true })
console.log(`${checks.length} checks, ${checks.filter((c) => !c.pass).length} failed`)
process.exit(checks.every((c) => c.pass) ? 0 : 1)
