import { fork, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { Session, type Profiler } from 'node:inspector'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { app, dialog, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron'
import { ownedPaths } from '../../src/core/repo/paths'
import { resolveLayout } from '../../src/core/repo/layout'
import { epicStateRecord, parseRecord } from '../../src/core/repo/portable'
import { createChatStore } from '../../src/main/agents/chatStore'
import type { ChatMailSnapshot } from '../../src/shared/agents/chatApi'
import type { ChatRecord } from '../../src/shared/agents/chat'
import type { GrantView, SessionView } from '../../src/shared/domain/views'
import type { WorkspaceRequest } from '../../src/main/desktop/workspaceClient'
import type { KanbanAttemptView, KanbanBoardView, KanbanPacket } from '../../src/shared/domain/kanban'
import type { ProfileProject } from './forge-performance-fixture'
import type { OwnerAction, OwnerReply } from './forge-performance-owner'
import { absoluteNow, identity, loopSink } from './forge-performance-sinks'
import { revampProject, revampRealStore, type RevampDeps } from './forge-performance-revamp'
import { fireFifteenSecondTimers, installTaps } from './forge-performance-taps'

export interface ProfileRun {
  home: string
  userData: string
  builtApp: string
  ownerEntry: string
  cliEntry: string
  systemNode: string
  repoRevision: string
  result: string
  mode: 'probe' | 'matrix' | 'production' | 'revamp'
  projects: ProfileProject[]
  small: ProfileProject
  /** Revamp mode: the bundled renderer helpers (`forge-performance-renderer.ts`). */
  rendererBundle?: string
  /** Revamp mode: a temporary copy of a real ticket store, tracked after the fixtures. */
  realStore?: string
}

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as ProfileRun
app.setPath('home', config.home)
app.setPath('userData', config.userData)
app.setPath('sessionData', config.userData)
app.commandLine.appendSwitch('disable-background-timer-throttling')
process.env['DARKMECHANICUS_HOME'] = config.home
delete process.env['DM_SESSION_TOKEN']
Reflect.deleteProperty(process.env, 'ELECTRON_RENDERER_URL')

function report(stage: string, detail: Record<string, unknown>): void {
  appendFileSync(config.result, JSON.stringify({ stage, ...detail }) + '\n')
}

const fixtureMailId = config.mode === 'production' && config.projects[0] !== undefined
  ? createChatStore({ root: join(config.userData, 'agents', 'chats') }).createChat({
    folder: config.projects[0].root, agent: 'omp', model: null, role: 'worker', allowSave: false, title: 'Synthetic mailbox'
  }).id : undefined

const boot = performance.now()
const bootMarks: Record<string, number> = {}
const bootProfiler = config.mode === 'production' ? new Session() : null

function bootMark(stage: string): void { bootMarks[stage] = performance.now() - boot }

function cpuBootSamples(profile: Profiler.Profile) {
  const frames = new Map(profile.nodes.map(node => [node.id, node.callFrame]))
  const times = new Map<number, number>()
  for (const [index, node] of (profile.samples ?? []).entries()) {
    times.set(node, (times.get(node) ?? 0) + (profile.timeDeltas?.[index] ?? 0) / 1000)
  }
  return [...times.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, milliseconds]) => {
    const frame = frames.get(id)
    return { name: frame?.functionName, file: frame?.url.split('/').at(-1), line: frame?.lineNumber, milliseconds }
  })
}

function finishBoot(): Promise<void> {
  if (bootProfiler === null) return Promise.resolve()
  bootMark('rendererLoaded')
  return new Promise((resolve, reject) => bootProfiler.post('Profiler.stop', (error, result) => {
    bootProfiler.disconnect()
    if (error) { reject(error); return }
    report('production-startup-profile', { marksMs: bootMarks, samples: cpuBootSamples(result.profile) })
    resolve()
  }))
}

const mainSink = loopSink()
const renderSink = String.raw`(() => {
  let previous = performance.now()
  let samples = []
  let clicks = 0
  const button = document.createElement('button')
  button.addEventListener('click', () => { clicks += 1 })
  setInterval(() => button.click(), 40)
  setInterval(() => {
    const now = performance.now()
    samples.push(now - previous)
    previous = now
  }, 10)
  window.dmPerfRead = () => {
    const answer = { count: samples.length, maxGapMs: Math.max(0, ...samples), syntheticClicks: clicks }
    samples = []
    clicks = 0
    return answer
  }
  return { preload: typeof window.dm?.command, href: location.pathname }
})()`

function runCli(project: ProfileProject, name: string, input: unknown, token?: string) {
  const started = performance.now()
  const child = spawn(config.systemNode, [config.cliEntry, '--repo', project.root, 'call', name, '-'], {
    env: { ...process.env, DM_SESSION_TOKEN: token },
    windowsHide: true
  })
  child.stdin.end(JSON.stringify(input))
  const done = new Promise<{ pid: number | undefined; elapsedMs: number; code: number | null; output: unknown }>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      try {
        resolve({ pid: child.pid, elapsedMs: performance.now() - started, code, output: JSON.parse(stdout) })
      } catch {
        reject(new Error(`CLI ${name} returned no JSON (exit ${code}): ${stderr}`))
      }
    })
  })
  return { child, done }
}

function hold(project: ProfileProject, duration: number) {
  const child = fork(config.ownerEntry, ['writer', project.dbFile, String(duration)], {
    execPath: config.systemNode,
    execArgv: [],
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const barriers: Record<string, unknown>[] = []
  child.on('message', (value: Record<string, unknown>) => barriers.push(value))
  const locked = new Promise<void>((resolve, reject) => {
    child.once('message', (value: Record<string, unknown>) => {
      if (value['phase'] === 'locked') resolve()
      else reject(new Error('Writer skipped lock barrier.'))
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Writer exited before lock barrier (exit ${code}): ${stderr}`)))
  })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}: ${stderr}`)))
  })
  void closed.catch(() => undefined)
  return { child, locked, closed, barriers }
}

function startOwner() {
  const child = utilityProcess.fork(config.ownerEntry, [], { serviceName: 'DM Forge profiler' })
  let next = 0
  const ready = new Promise<unknown>((resolve, reject) => {
    child.once('message', resolve)
    child.once('exit', (code) => reject(new Error(`Owner exited before startup: ${code}`)))
  })
  async function send(action: OwnerAction, project: ProfileProject, paths?: string[]): Promise<OwnerReply> {
    const id = ++next
    return new Promise((resolve, reject) => {
      function finished(code: number) {
        child.off('message', received)
        reject(new Error(`Owner exited during ${action}: ${code}`))
      }
      function received(value: OwnerReply) {
        if (value.id !== id) return
        child.off('message', received)
        child.off('exit', finished)
        if (value.error) reject(new Error(value.error))
        else resolve(value)
      }
      child.on('message', received)
      child.once('exit', finished)
      child.postMessage({ id, action, project, paths })
    })
  }
  return { child, ready, send }
}

function snapshots(project: ProfileProject): string[] {
  const layout = resolveLayout(project.root)
  const paths = ownedPaths(layout)
  return readdirSync(layout.epicsDir).flatMap((epic) => (
    readdirSync(paths.snapshotsDir(epic)).map((name) => join(paths.snapshotsDir(epic), name))
  ))
}

interface DesktopReply<T> {
  ok: boolean
  data: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

function rendererCommand<T>(window: BrowserWindow, project: ProfileProject, name: string, input?: unknown): Promise<DesktopReply<T>> {
  const payload = input === undefined ? 'undefined' : JSON.stringify(input)
  return window.webContents.executeJavaScript(
    `window.dm.command(${JSON.stringify(project.root)}, ${JSON.stringify(name)}, ${payload})`
  ) as Promise<DesktopReply<T>>
}

async function livenessDuring(window: BrowserWindow, project: ProfileProject, operation: () => Promise<unknown>) {
  await window.webContents.executeJavaScript('window.dmPerfRead()')
  mainSink.read()
  const start = performance.now()
  const latency: { ms: number; completedAtMs: number; completedEpochMs: number; ok: boolean }[] = []
  let pending = true
  const watch = (async () => {
    while (pending) {
      const sent = performance.now()
      const result = await rendererCommand(window, project, 'getProject')
      latency.push({ ms: performance.now() - sent, completedAtMs: performance.now() - start, completedEpochMs: absoluteNow(), ok: result.ok })
      if (pending) await delay(25)
    }
  })()
  try {
    const result = await operation()
    const elapsedMs = performance.now() - start
    pending = false
    await watch
    await delay(25)
    return {
      elapsedMs, result, mainLoop: mainSink.read(), ipc: latency,
      rendererLoop: await window.webContents.executeJavaScript('window.dmPerfRead()'),
      memory: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, workingSetSize: memory.workingSetSize }))
    }
  } finally {
    pending = false
    await watch
  }
}

async function cliWrite(window: BrowserWindow, project: ProfileProject): Promise<unknown> {
  const granted = await rendererCommand<{ token: string }>(window, project, 'issueGrant', { role: 'orchestrator', label: 'Isolated profiler CLI' })
  if (!granted.ok) throw new Error(JSON.stringify(granted.error))
  const result = await runCli(project, 'create_kanban_card', { title: 'Synthetic external CLI record' }, granted.data.token).done
  if (result.code !== 0) throw new Error(JSON.stringify(result.output))
  return result
}

function stagePortableChange(project: ProfileProject): string {
  const layout = resolveLayout(project.root)
  const id = readdirSync(layout.epicsDir)[0]!
  const target = ownedPaths(layout).epicStateFile(id)
  const original = parseRecord(epicStateRecord, readFileSync(target, 'utf8'), target)
  const tmp = target + '.profiler.tmp'
  writeFileSync(tmp, JSON.stringify({
    ...original, generation: original.generation + 1, updatedAt: '2026-01-02T00:00:00.000Z'
  }))
  renameSync(tmp, target)
  return id
}

async function confirmExternalHeartbeat(window: BrowserWindow, project: ProfileProject, productionOwner = false): Promise<void> {
  const issued = await rendererCommand<{ token: string }>(window, project, 'issueGrant', { role: 'orchestrator', label: 'Isolated lease proof' })
  if (!issued.ok) throw new Error(JSON.stringify(issued.error))
  const token = issued.data.token
  const launch = await runCli(project, 'launch_kanban_cards', { cardIds: [project.cardId] }, token).done
  if (launch.code !== 0) throw new Error(JSON.stringify(launch.output))
  const claim = await runCli(project, 'claim_kanban_card', { cardId: project.cardId, leaseSeconds: 60 }, token).done
  const packet = (claim.output as DesktopReply<KanbanPacket>).data
  if (claim.code !== 0 || !packet?.claimToken) throw new Error('Fixture claim did not issue its one-use token.')
  if (productionOwner) stagePortableChange(project)
  const writer = hold(project, 1_200)
  try {
    await writer.locked
    const request = { attemptId: packet.attemptId, claimToken: packet.claimToken, progressNote: 'Synthetic heartbeat after writer' }
    const measured = await livenessDuring(window, config.small, async () => {
      const work = productionOwner
        ? Promise.all([
          rendererCommand(window, project, 'reconcileRepository'),
          runCli(project, 'get_kanban_card', { cardId: project.cardId }, token).done
        ]).then(([reconciled, read]) => {
          if (!reconciled.ok || read.code !== 0) throw new Error('The built CLI card read and production reconcile did not both complete.')
          return { reconciled: true, externalCardReadMs: read.elapsedMs, externalCardReadPid: read.pid }
        })
        : Promise.resolve(undefined)
      const [result, concurrent] = await Promise.all([runCli(project, 'heartbeat_kanban_card', request, token).done, work])
      const heartbeat = (result.output as DesktopReply<KanbanAttemptView>).data
      if (result.code !== 0 || !heartbeat?.leaseExpiresAt || heartbeat.leaseExpiresAt <= packet.leaseExpiresAt || heartbeat.state !== 'running') {
        throw new Error('External CLI heartbeat did not extend its synthetic attempt lease.')
      }
      return { pid: result.pid, elapsedMs: result.elapsedMs, state: heartbeat.state, before: packet.leaseExpiresAt, after: heartbeat.leaseExpiresAt, concurrent }
    })
    await writer.closed
    report(productionOwner ? 'production-external-cli' : 'external-cli-heartbeat', { count: project.tickets, barriers: writer.barriers, ...measured })
  } finally {
    writer.child.kill()
  }
}

type LiveOperation = (operation: () => Promise<unknown>) => ReturnType<typeof livenessDuring>
type Owner = ReturnType<typeof startOwner>

async function trackCold(window: BrowserWindow, project: ProfileProject): Promise<void> {
  const count = project.tickets
  const shape = {
    tickets: count, epics: project.epics, revisions: project.revisions, runs: project.runs,
    images: project.images, comments: project.comments, bytes: project.bytes, hadDb: existsSync(project.dbFile)
  }
  if (shape.hadDb) throw new Error('Expected an uninitialized machine-local database for the cold case.')
  report('fixture', shape)
  const showOpenDialog = dialog.showOpenDialog
  // Return only our fixture path; the built app's normal folder-admission and IPC paths remain unchanged.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project.root] })
  const tracked = await window.webContents.executeJavaScript('window.dm.pickFolder()')
    .finally(() => { dialog.showOpenDialog = showOpenDialog }) as { added: boolean }
  if (!tracked.added || existsSync(project.dbFile)) throw new Error('The native folder admission path was not cold.')
}

async function measureChangedRecord(project: ProfileProject, owner: Owner, smallOwner: Owner, withLiveness: LiveOperation): Promise<void> {
  const count = project.tickets
  const epicId = stagePortableChange(project)
  const writer = hold(project, 1_200)
  try {
    await writer.locked
    const changed = await withLiveness(async () => {
      const large = owner.send('reconcile', project)
      const other = await smallOwner.send('card', config.small)
      report('unrelated-owner-card', { count, finishedEpochMs: absoluteNow(), ...other })
      return large
    })
    await writer.closed
    const result = changed.result as OwnerReply
    if (!(result.result as { imported: string[] }).imported.includes(epicId)) throw new Error('Changed epic was not imported.')
    report('owner-changed-record-contended', { count, epicId, barriers: writer.barriers, ...changed })
  } finally {
    writer.child.kill()
  }
}

async function waitForDesktopHeartbeat(owner: Owner, project: ProfileProject, withLiveness: LiveOperation): Promise<void> {
  async function lastSeen(): Promise<string | undefined> {
    const status = await owner.send('inspect', project)
    return (status.result as { desktopHeartbeat?: { last_seen_at: string } }).desktopHeartbeat?.last_seen_at
  }
  const initial = await lastSeen()
  const heartbeat = await withLiveness(async () => {
    for (let index = 0; index < 33; index += 1) {
      await delay(500)
      const last = await lastSeen()
      if (last && initial && last > initial) return { previous: initial, next: last }
    }
    throw new Error('No automatic Desktop session heartbeat was observed over one production interval.')
  })
  report('desktop-automatic-heartbeat', { count: project.tickets, ...heartbeat })
}

async function compareContention(window: BrowserWindow, project: ProfileProject, owner: Owner, withLiveness: LiveOperation): Promise<void> {
  for (const mode of ['desktop-contention', 'owner-contention'] as const) {
    const writer = hold(project, config.mode === 'probe' ? 500 : 1_200)
    try {
      await writer.locked
      const measured = await withLiveness(() => mode === 'desktop-contention'
        ? rendererCommand(window, project, 'getKanbanCard', { cardId: project.cardId })
        : owner.send('card', project))
      await writer.closed
      report(mode, { count: project.tickets, barriers: writer.barriers, ...measured })
    } finally {
      writer.child.kill()
    }
  }
}

async function profileProject(window: BrowserWindow, project: ProfileProject, owner: Owner, smallOwner: Owner): Promise<void> {
  const count = project.tickets
  const withLiveness: LiveOperation = (op) => livenessDuring(window, config.small, op)
  await trackCold(window, project)
  const cold = await withLiveness(() => rendererCommand(window, project, 'getKanbanCard', { cardId: project.cardId }))
  if (!(cold.result as DesktopReply<unknown>).ok || !existsSync(project.dbFile)) throw new Error('Desktop cold open failed.')
  report('desktop-cold', { count, ...cold })
  report('desktop-warm', { count, ...await withLiveness(() => rendererCommand(window, project, 'reconcileRepository')) })
  report('owner-open-existing', { count, ...await withLiveness(() => owner.send('open', project)) })
  report('owner-heartbeat', { count, ...await withLiveness(() => owner.send('heartbeat', project)) })
  report('owner-preview', { count, ...await withLiveness(() => owner.send('preview', project, snapshots(project))) })
  if (config.mode === 'matrix') {
    report('external-cli-write', { count, ...await withLiveness(() => cliWrite(window, project)) })
    report('owner-after-external-write', { count, ...await withLiveness(() => owner.send('inspect', project)) })
    report('desktop-after-external-write', { count, ...await withLiveness(() => rendererCommand(window, project, 'reconcileRepository')) })
    await measureChangedRecord(project, owner, smallOwner, withLiveness)
    if (count === 10_000) {
      await confirmExternalHeartbeat(window, project)
      await waitForDesktopHeartbeat(owner, project, withLiveness)
    }
  }
  await compareContention(window, project, owner, withLiveness)
  report('persistence', { count, ...await owner.send('inspect', project) })
  const beforeClose = await owner.send('heartbeat', project)
  const closed = await owner.send('close', project)
  const untracked = await window.webContents.executeJavaScript(`window.dm.untrackFolder(${JSON.stringify(project.root)})`) as unknown[]
  report('close-untrack', { count, beforeClose, closed, remainingFolders: untracked.length })
}

async function reproduceCliLock(project: ProfileProject): Promise<void> {
  const writer = hold(project, 24_000)
  try {
    await writer.locked
    const cli = runCli(project, 'get_kanban_card', { cardId: project.cardId })
    let result: Awaited<typeof cli.done>
    try {
      result = await cli.done
    } finally {
      cli.child.kill()
    }
    await writer.closed
    report('cli-locked', { barriers: writer.barriers, ...result })
  } finally {
    writer.child.kill()
  }
}

async function profile(window: BrowserWindow): Promise<void> {
  const startup = mainSink.read()
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 25))')
  const renderer = await window.webContents.executeJavaScript(renderSink) as { preload: string; href: string }
  if (renderer.preload !== 'function') throw new Error('Production preload was not loaded.')
  const small = await rendererCommand(window, config.small, 'getProject')
  if (!small.ok) throw new Error(JSON.stringify(small.error))
  if (config.mode === 'production') return production(window, renderer, startup)
  if (config.mode === 'revamp') return revamp(window)
  const owner = startOwner()
  const ownerReady = await owner.ready
  const smallOwner = startOwner()
  const smallOwnerReady = await smallOwner.ready
  await smallOwner.send('open', config.small)
  report('identity', {
    rev: config.repoRevision, platform: process.platform, arch: process.arch,
    main: identity(), renderer: { pid: window.webContents.getOSProcessId(), ...renderer, href: renderer.href.split('/').slice(-3).join('/') },
    owner: ownerReady, unrelatedOwner: smallOwnerReady, startupMainLoop: startup
  })
  try {
    for (const project of config.projects) {
      await profileProject(window, project, owner, smallOwner)
    }
    if (config.mode === 'matrix') {
      await reproduceCliLock(config.projects.at(-1)!)
    }
  } finally {
    mainSink.close()
    owner.child.kill()
    smallOwner.child.kill()
  }
}


/** Tracks `root` through the production folder picker, with only the native dialog result substituted. */
async function trackPath(window: BrowserWindow, root: string): Promise<void> {
  const showOpenDialog = dialog.showOpenDialog
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  const tracked = await window.webContents.executeJavaScript('window.dm.pickFolder()')
    .finally(() => { dialog.showOpenDialog = showOpenDialog }) as { added: boolean }
  if (!tracked.added) throw new Error('The folder picker did not track the folder.')
}

function revampDeps(window: BrowserWindow, owner: Owner): RevampDeps {
  return {
    window, owner, report, stageChange: stagePortableChange,
    rendererBundle: config.rendererBundle ?? '',
    command: <T>(folder: { root: string }, name: string, input?: unknown) => window.webContents.executeJavaScript(
      `window.dm.command(${JSON.stringify(folder.root)}, ${JSON.stringify(name)}, ${input === undefined ? 'undefined' : JSON.stringify(input)})`
    ) as Promise<DesktopReply<T>>,
    // A CLI call that printed no JSON is a result too: it is counted as `no_json`, never retried.
    cli: async (folder, name, input, token) => {
      const started = performance.now()
      return runCli(folder as ProfileProject, name, input, token).done
        .catch(() => ({ elapsedMs: performance.now() - started, code: null, output: null }))
    },
    track: (root) => trackPath(window, root),
    heartbeatNow: () => { if (fireFifteenSecondTimers() === 0) throw new Error('The desktop heartbeat timer was not captured.') }
  }
}

async function revamp(window: BrowserWindow): Promise<void> {
  const owner = startOwner()
  const ownerReady = await owner.ready
  report('revamp-identity', { rev: config.repoRevision, platform: process.platform, arch: process.arch, main: identity(), owner: ownerReady })
  const deps = revampDeps(window, owner)
  try {
    for (const project of config.projects) {
      await trackCold(window, project)
      const cold = await livenessDuring(window, config.small, () => rendererCommand(window, project, 'getProject'))
      report('revamp-cold-open', { tickets: project.tickets, elapsedMs: cold.elapsedMs, mainLoop: cold.mainLoop })
      await revampProject(deps, project)
      await window.webContents.executeJavaScript(`window.dm.untrackFolder(${JSON.stringify(project.root)})`)
    }
    if (config.realStore !== undefined) await revampRealStore(deps, config.realStore)
  } finally {
    mainSink.close()
    owner.child.kill()
  }
}

const projectOwners = new Map<string, UtilityProcess>()
let onDispatch: ((message: WorkspaceRequest, owner: UtilityProcess) => void) | undefined
if (config.mode === 'production') {
  const forkUtility = utilityProcess.fork.bind(utilityProcess)
  utilityProcess.fork = (modulePath, args, options) => {
    const owner = forkUtility(modulePath, args, options)
    if (modulePath.endsWith('workspaceOwner.js')) {
      const post = owner.postMessage.bind(owner)
      owner.postMessage = (value: unknown, transfer) => {
        post(value, transfer)
        const request = value as WorkspaceRequest
        if (request.type === 'work') projectOwners.set(request.path, owner)
        onDispatch?.(request, owner)
      }
    }
    return owner
  }
}

async function production(window: BrowserWindow, renderer: { preload: string; href: string }, startup: unknown): Promise<void> {
  const [project] = config.projects
  if (!project || project.tickets !== 10_000) throw new Error('Expected the 10,000-ticket production fixture.')
  await trackCold(window, project)
  const cold = await livenessDuring(window, config.small, () => rendererCommand(window, project, 'getProject'))
  if (!(cold.result as DesktopReply<unknown>).ok) throw new Error(JSON.stringify(cold.result))
  const originalPid = await productionIdentity(window, project, { renderer: { ...renderer, href: renderer.href.split('/').slice(-3).join('/') }, startup })
  report('production-cold', { tickets: project.tickets, ...cold, ipcP95Ms: p95(cold.ipc) })
  if (cold.mainLoop.maxGapMs >= 100 || p95(cold.ipc) >= 50) throw new Error('Main liveness failed during cold import.')
  await productionWriter(window, project, false)
  await productionWriter(window, project, true)
  await assertReopened(window, project, originalPid)
  await productionGrantAndMailbox(window, project)
  await confirmExternalHeartbeat(window, project, true)
  mainSink.close()
}

async function productionGrantAndMailbox(window: BrowserWindow, project: ProfileProject): Promise<void> {
  const path = JSON.stringify(project.root)
  const chats = await window.webContents.executeJavaScript('window.dm.chats.list(' + path + ')') as DesktopReply<ChatRecord[]>
  if (!chats.ok || !chats.data.find(record => record.id === fixtureMailId)?.endpointId) throw new Error('Production worker did not provision the chat mailbox.')
  const mail = await window.webContents.executeJavaScript('window.dm.chats.mail.snapshot(' + path + ')') as DesktopReply<ChatMailSnapshot>
  if (!mail.ok || !mail.data.chats.some(row => row.chatId === fixtureMailId && row.retainedCount === 0)) throw new Error('Production mailbox snapshot did not read the verified endpoint.')
  const issued = await rendererCommand<{ grant: GrantView }>(window, project, 'issueGrant', { role: 'reviewer', label: 'Synthetic desktop grant' })
  if (!issued.ok || !issued.data.grant.active) throw new Error('Production worker did not issue a desktop grant.')
  const revoked = await rendererCommand<GrantView>(window, project, 'revokeGrant', { grantId: issued.data.grant.id })
  if (!revoked.ok || revoked.data.active) throw new Error('Production worker did not revoke the desktop grant.')
  report('production-native-services', { mailboxProvisioned: true, mailboxReadable: true, grantIssued: true, grantRevoked: true })
}

async function assertReopened(window: BrowserWindow, project: ProfileProject, originalPid: number): Promise<void> {
  const persisted = await rendererCommand<KanbanBoardView>(window, project, 'listKanbanCards', {})
  if (!persisted.ok) throw new Error(JSON.stringify(persisted.error))
  const cards = Object.values(persisted.data.lanes).flat().map(card => card.title)
  if (cards.filter(title => title === 'Production owner committed once').length !== 1 ||
      cards.includes('Production owner killed before commit')) throw new Error('Unexpected durable results after reopening the utility.')
  const reopened = projectOwners.get(project.root)
  if (!reopened?.pid || reopened.pid === originalPid) throw new Error('The crashed production worker was not replaced.')
  report('production-reopen', { pid: reopened.pid, cards })
}

async function productionIdentity(window: BrowserWindow, project: ProfileProject, info: { renderer: object; startup: unknown }): Promise<number> {
  const owner = projectOwners.get(project.root)
  const otherOwner = projectOwners.get(config.small.root)
  if (!owner?.pid || !otherOwner?.pid) throw new Error('Expected two production project utilities.')
  if (owner.pid === otherOwner.pid || owner.pid === process.pid) throw new Error('Expected independent production project utilities.')
  const sessions = await rendererCommand<SessionView[]>(window, project, 'listSessions')
  if (!sessions.ok || !sessions.data.some(session => session.pid === owner.pid) || sessions.data.some(session => session.pid === process.pid)) {
    throw new Error('The production SQLite desktop session did not belong exclusively to the utility.')
  }
  report('production-identity', { revision: config.repoRevision, main: identity(), renderer: { ...info.renderer, pid: window.webContents.getOSProcessId() },
    ownerPid: owner.pid, unrelatedOwnerPid: otherOwner.pid, desktopSessionPids: sessions.data.map(session => session.pid), startup: info.startup })
  return owner.pid
}

async function productionWriter(window: BrowserWindow, project: ProfileProject, crash: boolean): Promise<void> {
  const writer = hold(project, -1)
  try {
    await writer.locked
    const title = crash ? 'Production owner killed before commit' : 'Production owner committed once'
    let reached: (owner: UtilityProcess) => void = () => undefined
    const dispatched = new Promise<UtilityProcess>(resolve => { reached = resolve })
    onDispatch = (request, owner) => {
      if (request.type === 'work' && request.path === project.root && request.work.kind === 'command' && request.work.name === 'createKanbanCard') reached(owner)
    }
    const measured = await livenessDuring(window, config.small, async () => {
      const write = rendererCommand(window, project, 'createKanbanCard', { title })
      const target = await dispatched
      const unrelated = await rendererCommand(window, config.small, 'getProject')
      if (!unrelated.ok || writer.barriers.length !== 1) throw new Error('Unrelated production IPC did not complete before writer release.')
      if (!crash) await delay(1200)
      // Both timers must advance while the held writer prevents the production utility from committing.
      const renderer = await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => resolve(window.dmPerfRead()), 25))')
      const main = mainSink.read()
      const beforeRelease = { main, renderer, samples: [...writer.barriers] }
      if (crash) {
        if (!target.kill()) throw new Error('The selected production worker could not be stopped.')
        const result = await write
        writer.child.send('release')
        return { result, beforeRelease }
      }
      writer.child.send('release')
      return { result: await write, beforeRelease }
    })
    await writer.closed
    const result = measured.result as { result: DesktopReply<unknown>; beforeRelease: { main: { count: number; maxGapMs: number }; renderer: { count: number } } }
    assertWriterOutcome(result, crash)
    if (p95(measured.ipc) >= 50) throw new Error('Unrelated IPC missed its latency target behind the held writer.')
    report(crash ? 'production-crash' : 'production-held-writer', { ...measured, ipcP95Ms: p95(measured.ipc), writer: writer.barriers })
  } finally {
    onDispatch = undefined
    if (writer.child.connected) writer.child.kill()
  }
}

function p95(samples: readonly { ok: boolean; ms: number }[]): number {
  const measured = samples.filter(sample => sample.ok).map(sample => sample.ms).sort((a, b) => a - b)
  return measured[Math.ceil(measured.length * 0.95) - 1] ?? Infinity
}

function assertWriterOutcome(result: { result: DesktopReply<unknown>; beforeRelease: { main: { count: number; maxGapMs: number }; renderer: { count: number } } }, crash: boolean): void {
  if (result.result.ok === crash || (crash && result.result.error?.details?.['completion'] !== 'unknown')) {
    throw new Error(JSON.stringify(result))
  }
  const { main, renderer } = result.beforeRelease
  if (main.count === 0 || main.maxGapMs >= 100 || renderer.count === 0) throw new Error('Main or renderer failed to stay live behind the held writer.')
}

// The revamp matrix runs 30 samples per view and condition on three fixtures, plus a 60-second agent run.
const RUN_BOUND_MS = config.mode === 'revamp' ? 3_600_000 : 150_000
const watchdog = setTimeout(() => {
  report('failure', { message: `Electron profiler exceeded its ${RUN_BOUND_MS / 1000}-second run bound.` })
  app.exit(1)
}, RUN_BOUND_MS)
app.once('ready', () => bootMark('electronReady'))
app.once('browser-window-created', (_event, window) => {
  bootMark('windowCreated')
  window.webContents.once('did-finish-load', () => {
    void finishBoot().then(() => profile(window)).then(() => {
      clearTimeout(watchdog)
      writeFileSync(join(config.userData, 'profiler.finished'), 'ok')
      app.quit()
    }, (error: unknown) => {
      clearTimeout(watchdog)
      report('failure', { message: error instanceof Error ? error.stack : String(error) })
      app.exit(1)
    })
  })
})
function launch(): void {
  if (config.mode === 'revamp') installTaps()
  bootMark('loadAppStart')
  createRequire(__filename)(config.builtApp)
  bootMark('loadAppEnd')
}
if (bootProfiler === null) launch()
else {
  bootProfiler.connect()
  bootProfiler.post('Profiler.enable')
  bootProfiler.post('Profiler.start', (error) => {
    if (error) throw error
    launch()
  })
}
