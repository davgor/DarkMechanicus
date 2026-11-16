/**
 * DM-505 acceptance smoke (criteria c1, c2): agent mailboxes through the BUILT `dm` CLI.
 *
 * Every agent call runs `out/main/cli.js` as its own process under the repository's own Electron with
 * ELECTRON_RUN_AS_NODE=1, against a scratch Git repository, a scratch DARKMECHANICUS_HOME and scratch grants, with
 * the grant in DM_SESSION_TOKEN (never argv) and JSON on stdin, in an args file or inline as the call says. The
 * desktop side (provisioning endpoints, issuing, binding, closing and revoking grants, the person's inbox, seen cursor
 * and wake credit, backup) runs the real core services in this process with the desktop role (`mail.manage`), as main
 * does. Where the CLI cannot control time (an expired grant, the seven-day cleanup) and where filling a quota through
 * thousands of processes would take an hour, the services run in-process (the CLI's own grant code path, or a
 * controlled clock) and the check's detail says so. Nothing touches the person's profile, home, chats or tokens.
 *
 * Usage, from the worktree root after `npm run build` (Node 24 with node:sqlite):
 *   env -u CI -u DM_DESKTOP_PIPE -u DM_SESSION_TOKEN node --import tsx docs/verification/DM-505-cli-smoke.mjs [--polls 1000]
 * Writes docs/verification/DM-505-cli-results.json, DM-505-cli-calls.jsonl and DM-505-cli-pollprobe.jsonl, then
 * removes its scratch folder. Exits 1 when any check failed.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { arch, release, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openWorkspace } from '../../src/core/workspace.ts'
import * as mail from '../../src/core/services/agentMail.ts'
import { pruneAgentMail } from '../../src/core/services/agentMailStore.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WT = join(HERE, '..', '..')
const ELECTRON = join(WT, 'node_modules', 'electron', 'dist', readFileSync(join(WT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim())
const CLI = join(WT, 'out', 'main', 'cli.js')
const PROBE = join(HERE, 'DM-505-cli-fsprobe.cjs')
const RESULTS = join(HERE, 'DM-505-cli-results.json')
const CALLS = join(HERE, 'DM-505-cli-calls.jsonl')
const POLL_PROBE = join(HERE, 'DM-505-cli-pollprobe.jsonl')
const POLLS = Number(process.argv[process.argv.indexOf('--polls') + 1] ?? 1000) || 1000
const RUN = Date.now().toString(36)
const MARK = `DM505MK-${RUN}`
const DAY_MS = 86_400_000
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

for (const name of ['DM_DESKTOP_PIPE', 'DM_SESSION_TOKEN']) {
  if (process.env[name]) throw new Error(`Unset ${name} before running the acceptance smoke.`)
}

const S = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm505-cli-')))
const REPO = join(S, "repo it's ü 漢")
const COPY = join(S, 'repo-copy')
const HOME_DIR = join(S, 'dm home')
const ARGS = join(S, 'args')
for (const dir of [REPO, HOME_DIR, ARGS]) mkdirSync(dir, { recursive: true })
writeFileSync(CALLS, '')
writeFileSync(POLL_PROBE, '')

const results = { ticket: 'DM-505', criteria: ['c1', 'c2'], run: RUN, startedAt: new Date().toISOString(), environment: {}, checks: [], timings: {}, notes: [] }
const tokens = new Map()
const cliTexts = []

function check(id, criteria, pass, detail) {
  results.checks.push({ id, criteria, pass: pass === true, detail })
  console.log(`${pass === true ? 'PASS' : 'FAIL'} ${id}${pass === true ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`)
}

function note(text) {
  results.notes.push(text)
}

/** Replaces any grant token with its label, so no secret reaches an evidence file; counts any it had to remove. */
let leakedTokens = 0
function scrub(text) {
  let out = text
  for (const [token, label] of tokens) {
    if (out.includes(token)) {
      leakedTokens += 1
      out = out.split(token).join(`[token:${label}]`)
    }
  }
  return out
}

function childEnv(extra = {}) {
  const env = { ...process.env }
  for (const name of ['DM_DESKTOP_PIPE', 'DM_SESSION_TOKEN', 'CI', 'NODE_OPTIONS', 'DARKMECHANICUS_REPO', 'ELECTRON_RUN_AS_NODE']) delete env[name]
  return { ...env, ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: HOME_DIR, ...extra }
}

function run(command, args, { cwd, env, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (stdin !== null && stdin !== undefined) child.stdin.end(stdin, 'utf8')
    else child.stdin.end()
  })
}

let callNo = 0
/** One built-CLI process. `who` is a grant holder ({label, token}) or null for no grant. */
async function dm(who, command, input, opts = {}) {
  const n = ++callNo
  const args = [CLI, '--repo', opts.repo ?? REPO, 'call', command]
  const via = input === undefined ? 'none' : (opts.via ?? 'stdin')
  let stdin = null
  if (via === 'stdin') {
    args.push('-')
    stdin = JSON.stringify(input)
  } else if (via === 'file') {
    const file = join(ARGS, `${n}.json`)
    writeFileSync(file, JSON.stringify(input), 'utf8')
    args.push('--args-file', file)
  } else if (via === 'inline') {
    args.push(JSON.stringify(input))
  }
  const env = childEnv({ ...(who?.token ? { DM_SESSION_TOKEN: who.token } : {}), ...(opts.env ?? {}) })
  const started = performance.now()
  const { code, stdout, stderr } = await run(ELECTRON, args, { cwd: opts.cwd ?? REPO, env, stdin })
  const ms = Math.round(performance.now() - started)
  let out = null
  try {
    out = JSON.parse(stdout)
  } catch {
    out = null
  }
  cliTexts.push({ n, command, ok: out?.ok === true, stdout, stderr })
  const record = opts.quiet
    ? { n, who: who?.label ?? 'no grant', command, via, exitCode: code, ms, ok: out?.ok ?? null, error: out?.error?.code, summary: opts.summary?.(out) }
    : { n, who: who?.label ?? 'no grant', command, via, repo: relative(S, opts.repo ?? REPO), input, exitCode: code, ms, out: out ?? stdout, stderr: stderr.trim() || undefined }
  appendFileSync(CALLS, `${scrub(JSON.stringify(record))}\n`)
  return { n, code, out, ok: out?.ok === true, data: out?.data, error: out?.error, stderr, ms }
}

const denied = (res, code = 'unauthorized') => res.code === 1 && res.out?.ok === false && res.error?.code === code

function fixedClock(ms) {
  return { nowMs: () => ms, nowIso: () => new Date(ms).toISOString() }
}
function offsetClock(offsetMs) {
  return { nowMs: () => Date.now() + offsetMs, nowIso: () => new Date(Date.now() + offsetMs).toISOString() }
}

function openDesktop(clock) {
  return openWorkspace({
    repoRoot: REPO,
    role: 'desktop',
    label: 'Desktop (DM-505 acceptance)',
    transport: 'desktop',
    pid: process.pid,
    homeDir: HOME_DIR,
    serverInfo: { name: 'dm505-acceptance', version: '0' },
    ...(clock ? { clock } : {})
  })
}

/** The CLI's own grant code path (transport `cli` with the token), in-process: used only to fill quotas quickly. */
function agentWorkspace(who, clock) {
  return openWorkspace({
    repoRoot: REPO,
    role: 'reader',
    label: 'dm505 in-process agent',
    transport: 'cli',
    grantToken: who.token,
    homeDir: HOME_DIR,
    pid: process.pid,
    autoReconcile: false,
    ...(clock ? { clock } : {})
  })
}

let desk
const db = () => desk.ctx().db
const count = (sql, ...params) => db().get(sql, ...params)?.n ?? 0

async function grantFor(d, label, role, minutes) {
  const { grant, token } = await d.issueGrant({ role, label, ...(minutes ? { minutes } : {}) })
  tokens.set(token, label)
  return { grantId: grant.id, token }
}

/** A desktop-provisioned chat endpoint with a current grant of `role` bound to it. */
async function chat(d, key, role, name, minutes) {
  const chatId = `ch_dm505_${key}`
  const endpoint = mail.provisionAgentMailEndpoint(d.ctx(), { chatId, name })
  const { grantId, token } = await grantFor(d, key, role, minutes)
  mail.bindAgentMailEndpoint(d.ctx(), { endpointId: endpoint.id, grantId })
  return { label: key, key, name, role, chatId, endpointId: endpoint.id, grantId, token }
}

/** A fresh grant bound to an existing endpoint (a restarted chat). */
async function rebind(d, peer, suffix) {
  const { grantId, token } = await grantFor(d, `${peer.key}-${suffix}`, peer.role)
  mail.bindAgentMailEndpoint(d.ctx(), { endpointId: peer.endpointId, grantId })
  return { ...peer, label: `${peer.key}-${suffix}`, grantId, token }
}

function codeOf(error) {
  return error?.code ?? String(error)
}

async function pool(items, width, act) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const index = next++
        out[index] = await act(items[index], index)
      }
    })
  )
  return out
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { n: sorted.length, min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted.at(-1), mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) }
}

function walk(dir, skip = () => false) {
  const files = []
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (skip(path)) continue
    if (entry.isDirectory()) files.push(...walk(path, skip))
    else files.push(path)
  }
  return files
}

function trackedTreeHash() {
  const base = join(REPO, '.darkmechanicus')
  const hash = createHash('sha256')
  for (const file of walk(base, (path) => path.startsWith(join(base, 'local'))).sort()) {
    hash.update(relative(base, file)).update(readFileSync(file))
  }
  return hash.digest('hex')
}

async function step(name, act) {
  const started = performance.now()
  try {
    await act()
  } catch (error) {
    check(`${name}.threw`, ['c1', 'c2'], false, String(error?.stack ?? error))
  }
  results.timings[name] = Math.round(performance.now() - started)
}

// --- environment -----------------------------------------------------------------------------------------------------

const cliVersions = JSON.parse((await run(ELECTRON, ['-p', 'JSON.stringify(process.versions)'], { cwd: WT, env: childEnv(), stdin: null })).stdout)
const ompExe = join(process.env.LOCALAPPDATA ?? '', 'omp', 'omp.exe')
results.environment = {
  os: `${process.platform} ${release()}`,
  arch: arch(),
  harnessNode: process.version,
  cliRuntime: { executable: relative(WT, ELECTRON), electron: cliVersions.electron, node: cliVersions.node, sqlite: cliVersions.sqlite },
  appVersion: JSON.parse(readFileSync(join(WT, 'package.json'), 'utf8')).version,
  commit: execFileSync('git', ['-C', WT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  branch: execFileSync('git', ['-C', WT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
  installedOmp: existsSync(ompExe) ? execFileSync(ompExe, ['--version'], { encoding: 'utf8' }).trim() : 'not found',
  scratch: 'mkdtemp under the system temp folder (repo path with a space, apostrophe and Unicode); removed at the end',
  cli: 'out/main/cli.js built by npm run build in this worktree'
}

// --- setup -----------------------------------------------------------------------------------------------------------

execFileSync('git', ['init', '-q'], { cwd: REPO })
execFileSync('git', ['-c', 'user.name=dm505', '-c', 'user.email=dm505@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'scratch'], { cwd: REPO })
desk = openDesktop()
await desk.initializeRepository({ name: 'dm505-cli' })
execFileSync('git', ['add', '-A'], { cwd: REPO })
execFileSync('git', ['-c', 'user.name=dm505', '-c', 'user.email=dm505@example.invalid', 'commit', '-q', '-m', 'track records'], { cwd: REPO })
const LOCAL = join(REPO, '.darkmechanicus', 'local')
const DB_FILE = join(LOCAL, 'state.sqlite')

const A = await chat(desk, 'alpha', 'worker', 'Alpha')
const B = await chat(desk, 'beta', 'reviewer', 'Beta')
const C = await chat(desk, 'gamma', 'planner', 'Gamma')
let D = await chat(desk, 'delta', 'orchestrator', 'Delta')
const markers = []
const marker = (tag) => {
  const value = `${MARK}-${tag}-${markers.length}`
  markers.push(value)
  return value
}
const BODY1 = `${marker('j1')} Ready for review? "quoted" it's & (ü 漢 🚀) %PATH% ^! <b>html</b>\nsecond line\ttab \\ backslash`
let s1
let pagesRead = []
let H = 0
let late = []
let reply
let m1

// --- c2: identity and discovery ---------------------------------------------------------------------------------------

await step('discovery', async () => {
  const cap = await dm(A, 'get_capabilities')
  check('discovery.capabilities-bound', ['c2'], cap.ok && cap.data.mailbox?.bound === true && cap.data.mailbox.endpointId === A.endpointId, cap.data?.mailbox)
  const id = await dm(A, 'get_agent_identity')
  check('discovery.identity', ['c2'], id.ok && id.data.endpointId === A.endpointId && id.data.name === 'Alpha' && id.data.role === 'worker' && typeof id.data.boundAt === 'string', id.data)
  const seen = []
  let afterId
  let pages = 0
  for (;;) {
    const page = await dm(A, 'list_agent_peers', afterId ? { afterId, limit: 1 } : { limit: 1 })
    pages += 1
    if (!page.ok) break
    seen.push(...page.data.peers.map((peer) => peer.endpointId))
    if (!page.data.hasMore || pages > 10) break
    afterId = page.data.nextAfterId
  }
  check('discovery.peers-paged', ['c2'], JSON.stringify([...seen].sort()) === JSON.stringify([B.endpointId, C.endpointId, D.endpointId].sort()) && pages === 3, { pages, seen, self: A.endpointId })
})

// --- c2: send, retry, conflict --------------------------------------------------------------------------------------------

await step('send', async () => {
  const input = { to: B.endpointId, clientMessageId: 'j-1', body: BODY1 }
  s1 = await dm(A, 'send_agent_message', input)
  check('send.accepted', ['c2'], s1.ok && s1.data.duplicate === false && s1.data.to === B.endpointId && s1.data.inReplyTo === null && /^mm_/.test(s1.data.messageId), s1.data ?? s1.error)
  const retry = await dm(A, 'send_agent_message', input, { via: 'file' })
  check('send.retry-same-client-id-replays', ['c2'], retry.ok && retry.data.duplicate === true && retry.data.messageId === s1.data.messageId && retry.data.acceptedAt === s1.data.acceptedAt, retry.data)
  const changed = await dm(A, 'send_agent_message', { ...input, body: `${BODY1} (changed)` })
  check('send.changed-payload-conflict', ['c2'], denied(changed, 'idempotency_mismatch') && !JSON.stringify(changed.out).includes(MARK), changed.out)
  check('send.one-row', ['c2'], count('SELECT COUNT(*) AS n FROM agent_mail_messages WHERE sender_endpoint_id = ? AND client_message_id = ?', A.endpointId, 'j-1') === 1, 'one stored message for (alpha, j-1)')
})

// --- c2: more than 50 pending and arrival while paging -----------------------------------------------------------------------

await step('paging', async () => {
  const bulk = Array.from({ length: 60 }, (_, i) => ({ to: B.endpointId, clientMessageId: `bulk-${i}`, body: `${marker('bulk')} #${i}` }))
  const sent = await pool(bulk, 4, (input) => dm(A, 'send_agent_message', input, { quiet: true, summary: (out) => out?.data?.messageId }))
  check('paging.bulk-sent', ['c2'], sent.every((r) => r.ok && r.data.duplicate === false), { sent: sent.length, failed: sent.filter((r) => !r.ok).map((r) => r.error) })
  const status = await dm(B, 'get_agent_mail_status', { limit: 50 })
  H = status.data?.snapshotHighWater ?? 0
  check(
    'paging.status-over-50',
    ['c2'],
    status.ok && status.data.pendingCount === 61 && status.data.messages.length === 50 && status.data.hasMore === true && H === 61 && status.data.messages.every((m) => !('body' in m)),
    { pendingCount: status.data?.pendingCount, page: status.data?.messages.length, hasMore: status.data?.hasMore, snapshotHighWater: H }
  )
  const statusPage2 = await dm(B, 'get_agent_mail_status', { afterSeq: status.data.nextCursor, throughSeq: H, limit: 50 })
  check('paging.status-page-2', ['c2'], statusPage2.ok && statusPage2.data.messages.length === 11 && statusPage2.data.hasMore === false, { page: statusPage2.data?.messages.length, hasMore: statusPage2.data?.hasMore })

  const pagingStarted = new Date().toISOString()
  const arrivals = (async () => {
    const out = []
    for (let i = 0; i < 10; i += 1) out.push(await dm(C, 'send_agent_message', { to: B.endpointId, clientMessageId: `late-${i}`, body: `${marker('late')} ${i}` }, { quiet: true }))
    return out
  })()
  const horizons = []
  let cursor = 0
  for (let pages = 0; pages < 30; pages += 1) {
    const page = await dm(B, 'read_agent_inbox', { afterSeq: cursor, throughSeq: H, limit: 7 }, { quiet: true, summary: (out) => out?.data && { n: out.data.messages.length, next: out.data.nextCursor, more: out.data.hasMore, high: out.data.snapshotHighWater } })
    if (!page.ok) break
    pagesRead.push(...page.data.messages)
    horizons.push(page.data.snapshotHighWater)
    cursor = page.data.nextCursor
    if (!page.data.hasMore) break
  }
  const pagingEnded = new Date().toISOString()
  late = await arrivals
  const seqs = pagesRead.map((m) => m.seq)
  check('paging.inbox-pages-gap-free', ['c2'], JSON.stringify(seqs) === JSON.stringify(Array.from({ length: H }, (_, i) => i + 1)) && pagesRead.every((m) => typeof m.body === 'string'), { pages: horizons.length, seqs: `${seqs[0]}..${seqs.at(-1)} (${seqs.length})` })
  const during = late.filter((r) => r.ok && r.data.acceptedAt > pagingStarted && r.data.acceptedAt < pagingEnded).length
  check('paging.arrivals-during-paging', ['c2'], late.every((r) => r.ok) && during > 0, { arrivalsAcceptedWhilePaging: during, of: late.length, pagingStarted, pagingEnded })
  const sweep = await dm(B, 'read_agent_inbox', { afterSeq: H, limit: 50 })
  check('paging.next-sweep-gets-arrivals', ['c2'], sweep.ok && sweep.data.messages.length === 10 && sweep.data.messages.every((m, i) => m.seq === H + 1 + i && m.from.endpointId === C.endpointId), { seqs: sweep.data?.messages.map((m) => m.seq) })
  check('paging.reading-never-acks', ['c2'], (await dm(B, 'get_agent_mail_status')).data?.pendingCount === 71, 'pendingCount 71 after reading every message')
})

// --- c2: correlated reply and owned acknowledgement -----------------------------------------------------------------------

await step('reply-ack', async () => {
  m1 = pagesRead.find((m) => m.id === s1.data.messageId)
  check('reply.body-exact', ['c2'], m1?.body === BODY1 && m1.from.endpointId === A.endpointId && m1.from.name === 'Alpha' && m1.acknowledgedAt === null, { from: m1?.from, exact: m1?.body === BODY1 })
  reply = await dm(B, 'send_agent_message', { to: A.endpointId, clientMessageId: 'j-1-reply', body: `${marker('reply')} Reviewed: ship it.`, inReplyTo: m1.id }, { via: 'file' })
  check('reply.accepted', ['c2'], reply.ok && reply.data.inReplyTo === m1.id && reply.data.duplicate === false, reply.data ?? reply.error)
  const inbox = await dm(A, 'read_agent_inbox', { unacknowledgedOnly: true })
  const got = inbox.data?.messages.find((m) => m.id === reply.data.messageId)
  check('reply.read-by-alpha', ['c2'], got?.inReplyTo === m1.id && got.from.endpointId === B.endpointId, got && { inReplyTo: got.inReplyTo, from: got.from })
  const before = (await dm(B, 'get_agent_mail_status')).data.pendingCount
  const ack = await dm(B, 'acknowledge_agent_messages', { messageIds: [m1.id] }, { via: 'file' })
  const first = ack.data?.acknowledged[0]
  check('ack.owned', ['c2'], ack.ok && first.messageId === m1.id && Date.parse(first.expiresAt) - Date.parse(first.acknowledgedAt) === 7 * DAY_MS, first)
  const again = await dm(B, 'acknowledge_agent_messages', { messageIds: [m1.id] }, { via: 'file' })
  check('ack.idempotent-first-time', ['c2'], again.ok && again.data.acknowledged[0].acknowledgedAt === first.acknowledgedAt, again.data)
  const after = (await dm(B, 'get_agent_mail_status')).data.pendingCount
  check('ack.pending-drops', ['c2'], after === before - 1, { before, after })
  const ackReply = await dm(A, 'acknowledge_agent_messages', { messageIds: [reply.data.messageId] })
  check('ack.alpha-acks-reply', ['c2'], ackReply.ok, ackReply.data)
})

// --- c2: denials, each with a positive control ------------------------------------------------------------------------------

await step('denials', async () => {
  // Zero grant.
  const none = await dm(null, 'get_agent_identity')
  check('deny.zero-grant.identity', ['c2'], denied(none) && none.stderr.includes('presented no grant'), { error: none.error, hint: none.stderr.trim() })
  const noneCap = await dm(null, 'get_capabilities')
  // An ungranted CLI session runs as the reader role, which lacks `mail.use`.
  check('deny.zero-grant.capabilities', ['c2'], noneCap.ok && noneCap.data.mailbox?.bound === false && noneCap.data.mailbox.reason === 'no_mail_capability', noneCap.data?.mailbox)
  check('deny.zero-grant.status-poll', ['c2'], denied(await dm(null, 'get_agent_mail_status')), 'restricted poll without a grant')
  check('deny.zero-grant.send', ['c2'], denied(await dm(null, 'send_agent_message', { to: B.endpointId, clientMessageId: 'z-1', body: 'x' })), 'send without a grant')
  check('deny.zero-grant.positive-control', ['c2'], (await dm(null, 'list_epics', {})).ok, 'an ungranted reader may still read')

  // An agent-role MCP (stdio) session never owns a mailbox, even with a bound grant's token in its environment.
  const transport = new StdioClientTransport({
    command: ELECTRON,
    args: [join(WT, 'out', 'main', 'mcp.js'), '--repo', REPO, '--role', 'worker', '--label', 'dm505 stdio'],
    env: childEnv({ DM_SESSION_TOKEN: A.token }),
    cwd: REPO,
    stderr: 'pipe'
  })
  const client = new Client({ name: 'dm505-acceptance', version: '1.0.0' })
  await client.connect(transport)
  const mcp = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent
  try {
    const mcpCap = await mcp('get_capabilities')
    appendFileSync(CALLS, `${scrub(JSON.stringify({ transport: 'mcp stdio', role: 'worker', inheritedToken: 'alpha (bound)', tool: 'get_capabilities', out: mcpCap }))}\n`)
    check('deny.stdio-agent.capabilities-no-grant', ['c2'], mcpCap?.ok === true && mcpCap.data.mailbox?.bound === false && mcpCap.data.mailbox.reason === 'no_grant', mcpCap?.data?.mailbox ?? mcpCap)
    const results3 = []
    for (const [tool, args] of [['get_agent_identity', {}], ['send_agent_message', { to: B.endpointId, clientMessageId: 'mcp-1', body: 'x' }], ['get_agent_mail_status', {}]]) {
      const out = await mcp(tool, args)
      appendFileSync(CALLS, `${scrub(JSON.stringify({ transport: 'mcp stdio', role: 'worker', tool, out }))}\n`)
      results3.push({ tool, code: out?.error?.code })
    }
    check('deny.stdio-agent.mail-tools-unauthorized', ['c2'], results3.every((r) => r.code === 'unauthorized'), results3)
    check('deny.stdio-agent.positive-control', ['c2'], (await mcp('list_epics'))?.ok === true, 'the same stdio worker session lists epics')
  } finally {
    await client.close()
  }

  // Reader grant.
  const reader = { label: 'reader', ...(await grantFor(desk, 'reader', 'reader')) }
  const readerCap = await dm(reader, 'get_capabilities')
  check('deny.reader.capabilities', ['c2'], readerCap.data?.mailbox?.bound === false && readerCap.data.mailbox.reason === 'no_mail_capability', readerCap.data?.mailbox)
  check('deny.reader.identity', ['c2'], denied(await dm(reader, 'get_agent_identity')), 'reader identity')
  check('deny.reader.status-poll', ['c2'], denied(await dm(reader, 'get_agent_mail_status')), 'reader poll')
  let readerBind = 'bound'
  try {
    mail.bindAgentMailEndpoint(desk.ctx(), { endpointId: A.endpointId, grantId: reader.grantId })
  } catch (error) {
    readerBind = codeOf(error)
  }
  check('deny.reader.desktop-will-not-bind', ['c2'], readerBind === 'invalid_input', { readerBind })
  check('deny.reader.positive-control', ['c2'], (await dm(reader, 'list_epics', {})).ok, 'reader grant reads')

  // Unbound worker grant, then bound (positive control).
  const unbound = { label: 'unbound', ...(await grantFor(desk, 'unbound', 'worker')) }
  const unboundCap = await dm(unbound, 'get_capabilities')
  check('deny.unbound.capabilities', ['c2'], unboundCap.data?.mailbox?.bound === false && unboundCap.data.mailbox.reason === 'unbound', unboundCap.data?.mailbox)
  check('deny.unbound.identity', ['c2'], denied(await dm(unbound, 'get_agent_identity')), 'unbound identity')
  check('deny.unbound.send', ['c2'], denied(await dm(unbound, 'send_agent_message', { to: B.endpointId, clientMessageId: 'u-1', body: 'x' })), 'unbound send')
  check('deny.unbound.status-poll', ['c2'], denied(await dm(unbound, 'get_agent_mail_status')), 'unbound poll')
  check('deny.unbound.wake-poll', ['c2'], denied(await dm(unbound, 'take_agent_mail_wake')), 'unbound wake')
  const epsilon = mail.provisionAgentMailEndpoint(desk.ctx(), { chatId: 'ch_dm505_epsilon', name: 'Epsilon' })
  mail.bindAgentMailEndpoint(desk.ctx(), { endpointId: epsilon.id, grantId: unbound.grantId })
  const nowBound = await dm(unbound, 'get_agent_identity')
  check('deny.unbound.positive-control-after-bind', ['c2'], nowBound.ok && nowBound.data.endpointId === epsilon.id, nowBound.data)

  // Expired grant: issued and bound by a desktop whose clock is two hours back (5-minute grant), so it is expired
  // when the real-time CLI runs; its twin (600 minutes) is the positive control. The CLI cannot control time.
  const past = openDesktop(offsetClock(-2 * 3600_000))
  const zeta = await chat(past, 'zeta', 'worker', 'Zeta', 5)
  const eta = await chat(past, 'eta', 'worker', 'Eta', 600)
  past.close()
  const expiresAt = db().get('SELECT expires_at FROM grants WHERE id = ?', zeta.grantId)?.expires_at
  check('deny.expired.identity', ['c2'], denied(await dm(zeta, 'get_agent_identity')), { expiresAt, note: 'grant issued/bound through the services with a clock 2 h back; CLI on the real clock' })
  check('deny.expired.status-poll', ['c2'], denied(await dm(zeta, 'get_agent_mail_status')), 'expired poll')
  check('deny.expired.send', ['c2'], denied(await dm(zeta, 'send_agent_message', { to: B.endpointId, clientMessageId: 'e-1', body: 'x' })), 'expired send')
  const etaId = await dm(eta, 'get_agent_identity')
  check('deny.expired.positive-control-twin', ['c2'], etaId.ok && etaId.data.endpointId === eta.endpointId, etaId.data)

  // Revoked grant: works, then the desktop revokes it, then every command (and the poll) is refused.
  const theta = await chat(desk, 'theta', 'worker', 'Theta')
  const thetaOk = await dm(theta, 'get_agent_identity')
  const thetaPoll = await dm(theta, 'get_agent_mail_status')
  check('deny.revoked.positive-control-before', ['c2'], thetaOk.ok && thetaPoll.ok, { identity: thetaOk.ok, poll: thetaPoll.ok })
  await desk.revokeGrant({ grantId: theta.grantId })
  check('deny.revoked.identity', ['c2'], denied(await dm(theta, 'get_agent_identity')), 'revoked identity')
  check('deny.revoked.status-poll', ['c2'], denied(await dm(theta, 'get_agent_mail_status')), 'revoked poll on its existing dedicated session')
  check('deny.revoked.wake-poll', ['c2'], denied(await dm(theta, 'take_agent_mail_wake')), 'revoked wake')
  check('deny.revoked.send', ['c2'], denied(await dm(theta, 'send_agent_message', { to: B.endpointId, clientMessageId: 'r-1', body: 'x' })), 'revoked send')
  check('deny.revoked.read', ['c2'], denied(await dm(theta, 'read_agent_inbox', {})), 'revoked read')

  // Foreign folder: a copy of the whole folder (same database, same machine.json), so only the folder differs.
  db().get('PRAGMA wal_checkpoint(TRUNCATE)')
  cpSync(REPO, COPY, { recursive: true })
  const foreignFolder = await dm(A, 'get_agent_identity', undefined, { repo: COPY, cwd: COPY })
  check('deny.foreign-folder.identity', ['c2'], denied(foreignFolder), { repo: 'repo-copy (same DB copy and machine.json)', error: foreignFolder.error })
  check('deny.foreign-folder.status-poll', ['c2'], denied(await dm(A, 'get_agent_mail_status', undefined, { repo: COPY, cwd: COPY })), 'foreign-folder poll')
  check('deny.foreign-folder.positive-control', ['c2'], (await dm(A, 'get_agent_identity')).ok, 'same grant in its own folder')
  rmSync(COPY, { recursive: true, force: true })

  // Foreign machine: another local/machine.json in the same folder (the database as another machine sees it).
  const machineFile = join(LOCAL, 'machine.json')
  const original = readFileSync(machineFile, 'utf8')
  writeFileSync(machineFile, JSON.stringify({ machineId: desk.ctx().ids.next('machine'), createdAt: new Date().toISOString() }, null, 2))
  const foreignMachine = await dm(A, 'get_agent_identity')
  const foreignMachinePoll = await dm(A, 'get_agent_mail_status')
  writeFileSync(machineFile, original)
  check('deny.foreign-machine.identity', ['c2'], denied(foreignMachine), foreignMachine.error)
  check('deny.foreign-machine.status-poll', ['c2'], denied(foreignMachinePoll), 'poll after an ordinary open recorded the other machine id')
  const backHome = await dm(A, 'get_agent_identity')
  const backHomePoll = await dm(A, 'get_agent_mail_status')
  check('deny.foreign-machine.positive-control-restored', ['c2'], backHome.ok && backHomePoll.ok, { identity: backHome.ok, poll: backHomePoll.ok })

  // Mixed foreign acknowledgement rolls back as a whole.
  const own = pagesRead.find((m) => m.seq === 2)
  const pendingBefore = (await dm(B, 'get_agent_mail_status')).data.pendingCount
  const mixed = await dm(B, 'acknowledge_agent_messages', { messageIds: [own.id, reply.data.messageId] })
  const ownRow = db().get('SELECT acked_at FROM agent_mail_messages WHERE id = ?', own.id)
  const pendingAfter = (await dm(B, 'get_agent_mail_status')).data.pendingCount
  check('deny.mixed-foreign-ack-rolls-back', ['c2'], mixed.code === 1 && mixed.out?.ok === false && ownRow.acked_at === null && pendingAfter === pendingBefore, { error: mixed.error, ownAckedAt: ownRow.acked_at, pendingBefore, pendingAfter })
  const ownOnly = await dm(B, 'acknowledge_agent_messages', { messageIds: [own.id] })
  check('deny.mixed-foreign-ack.positive-control', ['c2'], ownOnly.ok && ownOnly.data.acknowledged[0].messageId === own.id, ownOnly.data)

  // Unrelated replies.
  const fromGamma = await dm(B, 'send_agent_message', { to: A.endpointId, clientMessageId: 'bad-reply-1', body: 'x', inReplyTo: late[0].data.messageId })
  check('deny.reply-to-message-from-another-sender', ['c2'], fromGamma.code === 1 && ['invalid_input', 'reply_unavailable'].includes(fromGamma.error?.code), fromGamma.error)
  const notMine = await dm(B, 'send_agent_message', { to: A.endpointId, clientMessageId: 'bad-reply-2', body: 'x', inReplyTo: reply.data.messageId })
  check('deny.reply-to-message-not-in-own-inbox', ['c2'], denied(notMine, 'reply_unavailable'), notMine.error)
  const unknown = await dm(B, 'send_agent_message', { to: A.endpointId, clientMessageId: 'bad-reply-3', body: 'x', inReplyTo: 'mm_unknown' })
  check('deny.reply-to-unknown-id', ['c2'], unknown.code === 1 && ['invalid_input', 'reply_unavailable'].includes(unknown.error?.code), unknown.error)
  check('deny.refused-replies-stored-nothing', ['c2'], count("SELECT COUNT(*) AS n FROM agent_mail_messages WHERE client_message_id LIKE 'bad-reply-%'") === 0 && count("SELECT COUNT(*) AS n FROM agent_mail_receipts WHERE client_message_id LIKE 'bad-reply-%'") === 0, 'no message or receipt')
  check('deny.unrelated-reply.positive-control', ['c2'], reply.ok, 'the correlated reply in reply-ack was accepted')

  // Full backup is desktop-only.
  const orchestrator = { label: 'orchestrator-unbound', ...(await grantFor(desk, 'orchestrator-unbound', 'orchestrator')) }
  const backups = join(LOCAL, 'backups')
  check('deny.backup.unbound-orchestrator', ['c1'], denied(await dm(orchestrator, 'backup_database', {})), 'orchestrator grant, never bound')
  check('deny.backup.bound-worker', ['c1'], denied(await dm(A, 'backup_database', { targetPath: 'agent.sqlite' })), 'bound worker grant')
  check('deny.backup.no-grant', ['c1'], denied(await dm(null, 'backup_database', {})), 'no grant')
  check('deny.backup.no-file-written', ['c1'], !existsSync(backups) || readdirSync(backups).length === 0, existsSync(backups) ? readdirSync(backups) : 'no backups folder')
})

// --- c2: a stopped peer receives, then reads after its chat restarts; c1: database close/reopen ------------------------------

await step('stopped-peer', async () => {
  mail.closeAgentMailBinding(desk.ctx(), { grantId: D.grantId })
  check('stopped.old-grant-refused', ['c2'], denied(await dm(D, 'get_agent_identity')), 'the stopped chat’s grant no longer reaches the mailbox')
  const peers = await dm(A, 'list_agent_peers', { limit: 50 })
  check('stopped.still-discoverable', ['c2'], peers.data?.peers.some((p) => p.endpointId === D.endpointId), 'endpoint open while its chat is stopped')
  const body = `${marker('stopped')} for a stopped peer`
  const sent = await dm(A, 'send_agent_message', { to: D.endpointId, clientMessageId: 'stopped-1', body })
  check('stopped.send-accepted', ['c2'], sent.ok && sent.data.duplicate === false, sent.data ?? sent.error)
  const before = { messages: count('SELECT COUNT(*) AS n FROM agent_mail_messages'), receipts: count('SELECT COUNT(*) AS n FROM agent_mail_receipts') }
  desk.close()
  desk = openDesktop()
  const after = { messages: count('SELECT COUNT(*) AS n FROM agent_mail_messages'), receipts: count('SELECT COUNT(*) AS n FROM agent_mail_receipts') }
  check('reopen.database-keeps-mail', ['c1'], JSON.stringify(before) === JSON.stringify(after), { before, after })
  D = await rebind(desk, D, 'restart')
  const status = await dm(D, 'get_agent_mail_status')
  const inbox = await dm(D, 'read_agent_inbox', { unacknowledgedOnly: true })
  check('stopped.reads-after-restart', ['c2'], status.data?.pendingCount === 1 && inbox.data?.messages[0]?.body === body && inbox.data.messages[0].id === sent.data.messageId, { pendingCount: status.data?.pendingCount, read: inbox.data?.messages.length })
  const id = await dm(D, 'get_agent_identity')
  check('stopped.same-endpoint-after-restart', ['c2'], id.data?.endpointId === D.endpointId, id.data)
  check('stopped.acks', ['c2'], (await dm(D, 'acknowledge_agent_messages', { messageIds: [sent.data.messageId] })).ok, 'ack after restart')
  check('reopen.beta-pending-unchanged', ['c1'], (await dm(B, 'get_agent_mail_status')).data?.pendingCount === 69, 'beta still has its 69 unacknowledged messages after the reopen')
})

// --- c1/c2: human seen versus agent acknowledgement, monotonic seen ------------------------------------------------------------

await step('human-seen', async () => {
  const ctx = () => desk.ctx()
  const s0 = mail.getHumanAgentMailState(ctx(), { endpointId: B.endpointId })
  const page = mail.readHumanAgentInbox(ctx(), { endpointId: B.endpointId, limit: 10 })
  const tenth = page.messages[9].seq
  const marked = mail.markHumanAgentMailSeen(ctx(), { endpointId: B.endpointId, throughSeq: tenth })
  const s1h = mail.getHumanAgentMailState(ctx(), { endpointId: B.endpointId })
  const agentPending = (await dm(B, 'get_agent_mail_status')).data.pendingCount
  check('seen.moves-only-human-cursor', ['c2'], marked.humanSeenSeq === tenth && s1h.unseenCount === s0.unseenCount - 10 && s1h.pendingCount === s0.pendingCount && agentPending === s0.pendingCount, { s0: { unseen: s0.unseenCount, pending: s0.pendingCount }, s1: { unseen: s1h.unseenCount, pending: s1h.pendingCount, humanSeenSeq: s1h.humanSeenSeq }, agentPending })
  let backwards
  try {
    backwards = mail.markHumanAgentMailSeen(ctx(), { endpointId: B.endpointId, throughSeq: 5 })
  } catch (error) {
    backwards = { error: codeOf(error) }
  }
  const s2 = mail.getHumanAgentMailState(ctx(), { endpointId: B.endpointId })
  check('seen.monotonic', ['c2'], s2.humanSeenSeq === tenth, { backwards, humanSeenSeq: s2.humanSeenSeq })
  let beyond
  try {
    beyond = mail.markHumanAgentMailSeen(ctx(), { endpointId: B.endpointId, throughSeq: 100000 })
  } catch (error) {
    beyond = { error: codeOf(error) }
  }
  check('seen.not-beyond-served', ['c2'], beyond?.error !== undefined && mail.getHumanAgentMailState(ctx(), { endpointId: B.endpointId }).humanSeenSeq === tenth, { beyond })
  const target = pagesRead.find((m) => m.seq === 20)
  const ack = await dm(B, 'acknowledge_agent_messages', { messageIds: [target.id] })
  const s3 = mail.getHumanAgentMailState(ctx(), { endpointId: B.endpointId })
  check('seen.agent-ack-leaves-human-unseen', ['c2'], ack.ok && s3.humanSeenSeq === tenth && s3.pendingCount === s2.pendingCount - 1 && s3.unseenCount === s2.unseenCount, { unseen: [s2.unseenCount, s3.unseenCount], pending: [s2.pendingCount, s3.pendingCount] })
})

// --- c1: quotas, independent per sender and per recipient -------------------------------------------------------------------

let Q
let K
let L
let rho3
await step('quotas', async () => {
  Q = await chat(desk, 'iota', 'reviewer', 'Iota')
  K = await chat(desk, 'kappa', 'worker', 'Kappa')
  const started = performance.now()
  const kws = agentWorkspace(K)
  for (let i = 0; i < 1023; i += 1) await kws.sendAgentMessage({ to: Q.endpointId, clientMessageId: `fill-${i}`, body: `${MARK}-fill ${i}` })
  kws.close()
  markers.push(`${MARK}-fill`)
  note(`Filled iota with 1023 unacknowledged messages through the CLI grant code path in-process (${Math.round(performance.now() - started)} ms); the boundary calls are built-CLI processes.`)
  const last = await dm(K, 'send_agent_message', { to: Q.endpointId, clientMessageId: 'fill-1023', body: `${MARK}-fill 1023` })
  const over = await dm(K, 'send_agent_message', { to: Q.endpointId, clientMessageId: 'fill-1024', body: `${MARK}-fill 1024` })
  check('quota.unacked-1024-then-mailbox-full', ['c1'], last.ok && denied(over, 'mailbox_full') && !JSON.stringify(over.out).includes(MARK), { last: last.ok, over: over.error })
  check('quota.recipient-bound-applies-to-every-sender', ['c1'], denied(await dm(A, 'send_agent_message', { to: Q.endpointId, clientMessageId: 'to-full-iota', body: 'x' }), 'mailbox_full'), 'alpha → full iota')
  check('quota.other-mailboxes-unaffected', ['c1'], (await dm(K, 'send_agent_message', { to: B.endpointId, clientMessageId: 'kappa-to-beta', body: `${marker('kb')}` })).ok, 'kappa → beta while iota is full')
  const replay = await dm(K, 'send_agent_message', { to: Q.endpointId, clientMessageId: 'fill-1023', body: `${MARK}-fill 1023` })
  check('quota.receipt-replays-while-full', ['c1'], replay.ok && replay.data.duplicate === true, replay.data ?? replay.error)
  const pending = await dm(Q, 'get_agent_mail_status', { limit: 1 })
  const ackOne = await dm(Q, 'acknowledge_agent_messages', { messageIds: [pending.data.messages[0].id] })
  const room = await dm(K, 'send_agent_message', { to: Q.endpointId, clientMessageId: 'fill-1024', body: `${MARK}-fill 1024` })
  check('quota.ack-frees-room', ['c1'], pending.data.pendingCount === 1024 && ackOne.ok && room.ok, { pendingCount: pending.data.pendingCount, room: room.ok })

  // Retained bound (4096 per inbox) and the per-sender receipt bound (8192).
  L = await chat(desk, 'lambda', 'worker', 'Lambda')
  const R1 = await chat(desk, 'rho1', 'worker', 'Rho 1')
  const R2 = await chat(desk, 'rho2', 'worker', 'Rho 2')
  rho3 = await chat(desk, 'rho3', 'worker', 'Rho 3')
  const fillStarted = performance.now()
  const lws = agentWorkspace(L)
  for (const R of [R1, R2]) {
    const rws = agentWorkspace(R)
    for (let round = 0; round < 4; round += 1) {
      const ids = []
      for (let i = 0; i < 1024; i += 1) ids.push((await lws.sendAgentMessage({ to: R.endpointId, clientMessageId: `q-${R.key}-${round}-${i}`, body: `${MARK}-q ${i}` })).messageId)
      for (let i = 0; i < ids.length; i += 100) await rws.acknowledgeAgentMessages({ messageIds: ids.slice(i, i + 100) })
    }
    rws.close()
    if (R === R1) {
      const full = await dm(L, 'send_agent_message', { to: R1.endpointId, clientMessageId: 'over-retained', body: 'x' })
      check('quota.retained-4096-mailbox-full', ['c1'], denied(full, 'mailbox_full') && count('SELECT COUNT(*) AS n FROM agent_mail_messages WHERE recipient_endpoint_id = ? AND acked_at IS NOT NULL', R1.endpointId) === 4096, full.error)
    }
  }
  lws.close()
  markers.push(`${MARK}-q`)
  note(`Filled rho1 and rho2 to 4096 retained (acknowledged) messages each, 8192 lambda receipts, in-process through the CLI grant code path (${Math.round(performance.now() - fillStarted)} ms).`)
  const receipts = count('SELECT COUNT(*) AS n FROM agent_mail_receipts WHERE sender_endpoint_id = ?', L.endpointId)
  const quota = await dm(L, 'send_agent_message', { to: rho3.endpointId, clientMessageId: 'over-receipts', body: 'x' })
  check('quota.receipts-8192-then-receipt-quota-full', ['c1'], receipts === 8192 && denied(quota, 'receipt_quota_full'), { receipts, error: quota.error })
  const replayAtQuota = await dm(L, 'send_agent_message', { to: R1.endpointId, clientMessageId: 'q-rho1-0-0', body: `${MARK}-q 0` })
  check('quota.receipt-replay-at-quota', ['c1'], replayAtQuota.ok && replayAtQuota.data.duplicate === true, replayAtQuota.data ?? replayAtQuota.error)
  check('quota.receipts-independent-per-sender', ['c1'], (await dm(A, 'send_agent_message', { to: rho3.endpointId, clientMessageId: 'alpha-to-rho3', body: `${marker('a3')}` })).ok, 'alpha sends while lambda is at its receipt quota')
  const seqs = db().all('SELECT recipient_endpoint_id AS r, MIN(recipient_seq) AS lo, MAX(recipient_seq) AS hi, COUNT(*) AS n FROM agent_mail_messages GROUP BY recipient_endpoint_id')
  check('quota.sequences-independent-per-recipient', ['c1'], seqs.every((row) => row.lo === 1 && row.hi === row.n), seqs.map((row) => ({ lo: row.lo, hi: row.hi, n: row.n })))
})

// --- c2: deleting-intent crash recovery; c1: receipt after recipient deletion -------------------------------------------------

await step('deleting-crash', async () => {
  const N = await chat(desk, 'nu', 'worker', 'Nu')
  const fromNu = await dm(N, 'send_agent_message', { to: A.endpointId, clientMessageId: 'nu-1', body: `${marker('nu')} from nu` })
  const aws = agentWorkspace(A)
  for (let i = 0; i < 150; i += 1) await aws.sendAgentMessage({ to: N.endpointId, clientMessageId: `to-nu-${i}`, body: `${MARK}-tonu ${i}` })
  aws.close()
  markers.push(`${MARK}-tonu`)
  const witness = await dm(A, 'send_agent_message', { to: N.endpointId, clientMessageId: 'to-nu-cli', body: `${marker('tonucli')}` })
  const crash = join(S, 'crash-delete.mjs')
  writeFileSync(
    crash,
    `import { openWorkspace } from ${JSON.stringify(pathToFileURL(join(WT, 'src', 'core', 'workspace.ts')).href)}
import { deleteAgentMailEndpoint } from ${JSON.stringify(pathToFileURL(join(WT, 'src', 'core', 'services', 'agentMail.ts')).href)}
import { writeFileSync } from 'node:fs'
const ws = openWorkspace({ repoRoot: ${JSON.stringify(REPO)}, role: 'desktop', label: 'Desktop (crashing)', transport: 'desktop', pid: process.pid, homeDir: ${JSON.stringify(HOME_DIR)} })
const r = deleteAgentMailEndpoint(ws.ctx(), { endpointId: ${JSON.stringify(N.endpointId)} })
writeFileSync(${JSON.stringify(join(S, 'crash-out.json'))}, JSON.stringify({ state: r.endpoint.state, purged: r.purged, done: r.done }))
// The crash: the process dies after the first purge batch committed and before the deletion finished.
process.kill(process.pid, 'SIGKILL')
`
  )
  const killed = await run(process.execPath, ['--import', 'tsx', crash], { cwd: WT, env: childEnv(), stdin: null })
  const first = existsSync(join(S, 'crash-out.json')) ? JSON.parse(readFileSync(join(S, 'crash-out.json'), 'utf8')) : { stderr: killed.stderr.slice(0, 2000) }
  check('deleting.crashed-mid-deletion', ['c2'], first.state === 'deleting' && first.done === false && killed.code !== 0, { first, exitCode: killed.code })
  desk.close()
  desk = openDesktop()
  const row = db().get('SELECT state FROM agent_mail_endpoints WHERE id = ?', N.endpointId)
  const remaining = count('SELECT COUNT(*) AS n FROM agent_mail_messages WHERE recipient_endpoint_id = ?', N.endpointId)
  check('deleting.intent-survives-crash', ['c2'], row.state === 'deleting' && remaining > 0 && remaining < 151, { state: row.state, remaining })
  check('deleting.grant-refused', ['c2'], denied(await dm(N, 'get_agent_identity')) && denied(await dm(N, 'get_agent_mail_status')), 'grant of a deleting mailbox')
  const toDeleting = await dm(A, 'send_agent_message', { to: N.endpointId, clientMessageId: 'to-nu-new', body: 'x' })
  check('deleting.new-send-not-found', ['c2'], denied(toDeleting, 'not_found'), toDeleting.error)
  let reprovision = 'provisioned'
  try {
    mail.provisionAgentMailEndpoint(desk.ctx(), { chatId: N.chatId, name: 'Nu again' })
  } catch (error) {
    reprovision = codeOf(error)
  }
  check('deleting.never-reprovisioned', ['c2'], reprovision !== 'provisioned', { reprovision })
  check('deleting.not-a-peer', ['c2'], !(await dm(A, 'list_agent_peers', { limit: 50 })).data.peers.some((p) => p.endpointId === N.endpointId), 'peers exclude a deleting endpoint')
  let calls = 0
  let done = false
  while (!done && calls < 20) {
    done = mail.deleteAgentMailEndpoint(desk.ctx(), { endpointId: N.endpointId }).done
    calls += 1
  }
  const finalRow = db().get('SELECT state FROM agent_mail_endpoints WHERE id = ?', N.endpointId)
  check('deleting.finished-after-recovery', ['c2'], done && finalRow.state === 'deleted' && count('SELECT COUNT(*) AS n FROM agent_mail_messages WHERE recipient_endpoint_id = ?', N.endpointId) === 0, { calls, state: finalRow.state })
  const kept = (await dm(A, 'read_agent_inbox', { unacknowledgedOnly: true, limit: 50 })).data.messages.find((m) => m.id === fromNu.data.messageId)
  check('deleting.sent-mail-stays-with-tombstoned-sender', ['c2'], kept?.from.deleted === true, kept?.from)
  const replyToDeleted = await dm(A, 'send_agent_message', { to: N.endpointId, clientMessageId: 'reply-to-nu', body: 'x', inReplyTo: fromNu.data.messageId })
  check('deleting.reply-to-deleted-refused', ['c2'], replyToDeleted.code === 1 && replyToDeleted.out?.ok === false, replyToDeleted.error)
  const receiptsBefore = count('SELECT COUNT(*) AS n FROM agent_mail_receipts WHERE sender_endpoint_id = ? AND client_message_id = ?', A.endpointId, 'to-nu-cli')
  const replayed = await dm(A, 'send_agent_message', { to: N.endpointId, clientMessageId: 'to-nu-cli', body: markers.find((m) => m.includes('-tonucli-')) })
  check('receipt.after-recipient-delete-witness', ['c1'], receiptsBefore === 1 && replayed.ok && replayed.data.duplicate === true && replayed.data.messageId === witness.data.messageId, { receiptsBefore, replayed: replayed.data ?? replayed.error })
  check('receipt.new-id-to-deleted-not-found', ['c1'], denied(await dm(A, 'send_agent_message', { to: N.endpointId, clientMessageId: 'to-nu-after', body: 'x' }), 'not_found'), 'fresh id to a deleted mailbox')
})

// --- c2: competing first poll opens and the one wake credit ------------------------------------------------------------------

await step('competing-polls', async () => {
  for (let round = 1; round <= 3; round += 1) {
    const xi = await chat(desk, `xi${round}`, 'worker', `Xi ${round}`)
    const aws = agentWorkspace(A)
    await aws.sendAgentMessage({ to: xi.endpointId, clientMessageId: `wake-${round}`, body: `${MARK}-wake ${round}` })
    aws.close()
    const armed = mail.armAgentMailWake(desk.ctx(), { endpointId: xi.endpointId, expectedRevision: 0, requestNonce: `arm-${round}` })
    const sessionsBefore = count('SELECT COUNT(*) AS n FROM sessions')
    const racers = await Promise.all([1, 2, 3, 4].map((i) => dm(xi, i % 2 ? 'take_agent_mail_wake' : 'get_agent_mail_status', undefined, { quiet: true, summary: (out) => out?.data })))
    const more = await Promise.all([1, 2].map(() => dm(xi, 'take_agent_mail_wake', undefined, { quiet: true, summary: (out) => out?.data })))
    const all = [...racers, ...more]
    const claimed = all.filter((r) => r.data?.claimed === true)
    const mapped = count('SELECT COUNT(*) AS n FROM agent_mail_poll_sessions WHERE grant_id = ?', xi.grantId)
    const sessionsAfter = count('SELECT COUNT(*) AS n FROM sessions')
    check(`polls.competing-first-opens.round-${round}`, ['c2'], armed.armed && all.every((r) => r.ok) && claimed.length === 1 && mapped === 1 && sessionsAfter === sessionsBefore + 1, { claimed: claimed.length, mapped, sessionsDelta: sessionsAfter - sessionsBefore, calls: all.length })
    const state = mail.getHumanAgentMailState(desk.ctx(), { endpointId: xi.endpointId }).wake
    check(`wake.attempted-not-rearmed.round-${round}`, ['c2'], state.armed === false && state.lastAttempt?.id === claimed[0]?.data.wakeAttemptId && state.lastAttempt.outcome === 'attempted', state)
    if (round === 1) {
      let replayArm
      try {
        replayArm = mail.armAgentMailWake(desk.ctx(), { endpointId: xi.endpointId, expectedRevision: 0, requestNonce: 'arm-1' })
      } catch (error) {
        replayArm = { error: codeOf(error) }
      }
      check('wake.delayed-duplicate-arm-conflicts', ['c2'], replayArm.error === 'conflict', replayArm)
      const rearm = mail.armAgentMailWake(desk.ctx(), { endpointId: xi.endpointId, expectedRevision: state.revision, requestNonce: 'arm-1b' })
      const twice = mail.armAgentMailWake(desk.ctx(), { endpointId: xi.endpointId, expectedRevision: state.revision, requestNonce: 'arm-1c' })
      check('wake.arm-while-armed-does-not-accumulate', ['c2'], rearm.armed && twice.revision === rearm.revision, { rearm: rearm.revision, twice: twice.revision })
      const pending = await dm(xi, 'read_agent_inbox', {})
      await dm(xi, 'acknowledge_agent_messages', { messageIds: pending.data.messages.map((m) => m.id) })
      const noMail = await dm(xi, 'take_agent_mail_wake')
      check('wake.no-claim-without-pending-mail', ['c2'], noMail.ok && noMail.data.claimed === false && noMail.data.pendingCount === 0 && mail.getHumanAgentMailState(desk.ctx(), { endpointId: xi.endpointId }).wake.armed === true, noMail.data)
    }
  }
})

// --- c2: the bounded cleanup of retired poll sessions -------------------------------------------------------------------------

await step('poll-session-cleanup', async () => {
  const stale = []
  for (let i = 0; i < 120; i += 1) stale.push(await chat(desk, `stale${i}`, 'worker', `Stale ${i}`))
  const polled = await pool(stale, 6, (who) => dm(who, 'get_agent_mail_status', undefined, { quiet: true }))
  check('cleanup.120-poll-sessions-created', ['c2'], polled.every((r) => r.ok) && stale.every((who) => count('SELECT COUNT(*) AS n FROM agent_mail_poll_sessions WHERE grant_id = ?', who.grantId) === 1), { polled: polled.filter((r) => r.ok).length })
  for (const who of stale) await desk.revokeGrant({ grantId: who.grantId })
  const ordinaryRows = () => db().all('SELECT id, ended_at, last_seen_at FROM sessions WHERE id NOT IN (SELECT session_id FROM agent_mail_poll_sessions) ORDER BY id')
  const ordinaryBefore = ordinaryRows()
  const mappedBefore = count('SELECT COUNT(*) AS n FROM agent_mail_poll_sessions')
  const batches = []
  for (let i = 0; i < 4; i += 1) batches.push(mail.pruneAgentMailPollSessions(desk.ctx()))
  const ordinaryAfter = new Map(ordinaryRows().map((row) => [row.id, row]))
  const retired = batches.map((b) => b.removed + b.ended)
  check('cleanup.bounded-batches', ['c2'], retired[0] === 100 && retired.every((n) => n <= 100) && retired.at(-1) === 0 && retired.reduce((a, b) => a + b, 0) >= 120, { mappedBefore, batches })
  check('cleanup.ordinary-sessions-untouched', ['c2'], ordinaryBefore.every((old) => ordinaryAfter.get(old.id)?.ended_at === old.ended_at && ordinaryAfter.get(old.id)?.last_seen_at === old.last_seen_at), { ordinarySessions: ordinaryBefore.length, note: 'every non-poll session row unchanged (id, ended_at, last_seen_at)' })
  check('cleanup.live-bindings-keep-their-session', ['c2'], count('SELECT COUNT(*) AS n FROM agent_mail_poll_sessions WHERE grant_id = ?', B.grantId) === 1, 'beta’s poll session survives cleanup')
})

// --- c2: a thousand restricted status polls through the built CLI --------------------------------------------------------------

await step('thousand-polls', async () => {
  const P = await chat(desk, 'pi', 'worker', 'Pi')
  const sent = await dm(A, 'send_agent_message', { to: P.endpointId, clientMessageId: 'pi-1', body: `${marker('pi')}` })
  const firstPoll = await dm(P, 'get_agent_mail_status')
  // A staged image created 30 days ago: every ordinary open prunes it, a poll must not. Created after the last
  // ordinary open above, through a desktop whose clock is 30 days back.
  const old = openDesktop(offsetClock(-30 * DAY_MS))
  const image = await old.uploadAttachment({ data: PNG, label: 'stale staged image', purpose: 'evidence' })
  old.close()
  const before = {
    sessions: count('SELECT COUNT(*) AS n FROM sessions'),
    outbox: count('SELECT COUNT(*) AS n FROM outbox'),
    mapped: count('SELECT COUNT(*) AS n FROM agent_mail_poll_sessions WHERE grant_id = ?', P.grantId),
    tree: trackedTreeHash(),
    image: count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', image.id)
  }
  const probeEnv = { NODE_OPTIONS: `--require ${PROBE.replace(/\\/g, '/')}`, DM505_PROBE_OUT: POLL_PROBE }
  const pendingCounts = new Set()
  const sampled = []
  const times = []
  let failures = 0
  const pollId = db().get('SELECT session_id FROM agent_mail_poll_sessions WHERE grant_id = ?', P.grantId)?.session_id
  for (let i = 1; i <= POLLS; i += 1) {
    const poll = await dm(P, 'get_agent_mail_status', undefined, { env: probeEnv, quiet: i % 100 !== 1, summary: (out) => out?.data?.pendingCount })
    times.push(poll.ms)
    if (!poll.ok) failures += 1
    else pendingCounts.add(poll.data.pendingCount)
    if (i % 250 === 0) sampled.push(count('SELECT COUNT(*) AS n FROM sessions'))
  }
  results.timings.pollMs = stats(times)
  const after = {
    sessions: count('SELECT COUNT(*) AS n FROM sessions'),
    outbox: count('SELECT COUNT(*) AS n FROM outbox'),
    mapped: count('SELECT COUNT(*) AS n FROM agent_mail_poll_sessions WHERE grant_id = ?', P.grantId),
    tree: trackedTreeHash(),
    image: count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', image.id)
  }
  const pollSession = db().get('SELECT ended_at, pid, transport, label FROM sessions WHERE id = ?', pollId)
  check('polls.thousand-all-answered', ['c2'], failures === 0 && [...pendingCounts].join() === '1' && firstPoll.ok, { polls: POLLS, failures, pendingCounts: [...pendingCounts] })
  check('polls.one-dedicated-session', ['c2'], before.mapped === 1 && after.mapped === 1 && sampled.every((n) => n === before.sessions) && after.sessions === before.sessions && pollSession?.ended_at === null && pollSession.pid === null, { before: before.sessions, sampled, after: after.sessions, pollSession })
  check('polls.no-flush', ['c2'], after.outbox === before.outbox && after.tree === before.tree, { outbox: [before.outbox, after.outbox], trackedTreeUnchanged: after.tree === before.tree })
  check('polls.no-staged-image-prune', ['c2'], before.image === 1 && after.image === 1, { before: before.image, after: after.image })
  const probes = readFileSync(POLL_PROBE, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const totals = {}
  for (const p of probes) for (const [k, v] of Object.entries(p.counts)) totals[k] = (totals[k] ?? 0) + v
  check('polls.no-reconcile-git-or-file-writes', ['c2'], probes.length === POLLS && Object.keys(totals).length === 0, { processes: probes.length, totals, method: 'NODE_OPTIONS=--require DM-505-cli-fsprobe.cjs counting fs readdir/write/rename/rm/mkdir and child_process calls' })

  // Positive control: an ordinary CLI call does record maintenance, prunes the stale image and ends its own session.
  const controlOut = join(S, 'control-probe.jsonl')
  const ordinary = await dm(P, 'get_agent_identity', undefined, { env: { ...probeEnv, DM505_PROBE_OUT: controlOut } })
  const control = JSON.parse(readFileSync(controlOut, 'utf8').trim())
  const ordinaryRow = db().get("SELECT ended_at, pid, transport FROM sessions WHERE grant_id = ? AND id <> ? ORDER BY started_at DESC LIMIT 1", P.grantId, pollId)
  check('polls.positive-control-ordinary-open', ['c2'], ordinary.ok && (control.counts['fs.readdirSync'] ?? 0) > 0 && count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', image.id) === 0, { counts: control.counts, imageAfter: count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', image.id) })
  check('polls.ordinary-session-lifecycle-unchanged', ['c2'], ordinaryRow?.ended_at !== null && ordinaryRow?.pid !== null && ordinaryRow?.transport === 'cli' && after.sessions + 1 === count('SELECT COUNT(*) AS n FROM sessions'), ordinaryRow)
  results.pollProbe = { processes: probes.length, totals, controlCounts: control.counts }
  void sent
})

// --- c1: desktop-only backup, restore, reopen ----------------------------------------------------------------------------------

await step('backup-restore', async () => {
  const snapshot = () => ({
    messages: count('SELECT COUNT(*) AS n FROM agent_mail_messages'),
    unacked: count('SELECT COUNT(*) AS n FROM agent_mail_messages WHERE acked_at IS NULL'),
    receipts: count('SELECT COUNT(*) AS n FROM agent_mail_receipts'),
    endpoints: count('SELECT COUNT(*) AS n FROM agent_mail_endpoints'),
    betaLastSeq: db().get('SELECT last_seq FROM agent_mail_endpoints WHERE id = ?', B.endpointId).last_seq
  })
  const live = snapshot()
  const backup = await desk.backupDatabase({ targetPath: 'dm505-acceptance.sqlite' })
  const copy = new DatabaseSync(backup.path, { readOnly: true })
  const integrity = copy.prepare('PRAGMA integrity_check').get()
  const inCopy = {
    messages: copy.prepare('SELECT COUNT(*) AS n FROM agent_mail_messages').get().n,
    receipts: copy.prepare('SELECT COUNT(*) AS n FROM agent_mail_receipts').get().n
  }
  copy.close()
  check('backup.desktop-vacuum-consistent', ['c1'], Object.values(integrity)[0] === 'ok' && inCopy.messages === live.messages && inCopy.receipts === live.receipts, { path: relative(REPO, backup.path), integrity, live, inCopy })
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: REPO, encoding: 'utf8' })
  check('backup.not-tracked-by-git', ['c1'], !status.includes('local/'), { gitStatus: status.trim().split('\n').filter(Boolean) })

  // Lose everything after the backup, then restore it in place: quit, move the live database aside, copy the backup in.
  await dm(A, 'send_agent_message', { to: B.endpointId, clientMessageId: 'after-backup', body: `${marker('lost')} sent after the backup` })
  desk.close()
  const aside = join(S, 'aside')
  mkdirSync(aside)
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(DB_FILE + suffix)) renameSync(DB_FILE + suffix, join(aside, `state.sqlite${suffix}`))
  copyFileSync(backup.path, DB_FILE)
  desk = openDesktop()
  const restored = snapshot()
  check('restore.mail-preserved', ['c1'], JSON.stringify(restored) === JSON.stringify(live), { live, restored })
  const betaStatus = await dm(B, 'get_agent_mail_status')
  check('restore.cli-reads-restored-mailbox', ['c1'], betaStatus.ok && betaStatus.data.pendingCount === live.unacked - count('SELECT COUNT(*) AS n FROM agent_mail_messages WHERE acked_at IS NULL AND recipient_endpoint_id <> ?', B.endpointId), betaStatus.data && { pendingCount: betaStatus.data.pendingCount })
  const replay = await dm(A, 'send_agent_message', { to: B.endpointId, clientMessageId: 'j-1', body: BODY1 })
  check('restore.receipts-preserved', ['c1'], replay.ok && replay.data.duplicate === true && replay.data.messageId === s1.data.messageId, replay.data ?? replay.error)
  const next = await dm(A, 'send_agent_message', { to: B.endpointId, clientMessageId: 'after-restore', body: `${marker('restored')} after restore` })
  const seq = db().get('SELECT recipient_seq FROM agent_mail_messages WHERE id = ?', next.data?.messageId)?.recipient_seq
  check('restore.sequence-continues', ['c1'], next.ok && seq === live.betaLastSeq + 1, { seq, betaLastSeq: live.betaLastSeq })
  check('restore.quota-preserved', ['c1'], denied(await dm(K, 'send_agent_message', { to: Q.endpointId, clientMessageId: 'fill-1025', body: 'x' }), 'mailbox_full'), 'iota is still full after the restore')
  check('restore.receipt-quota-preserved', ['c1'], denied(await dm(L, 'send_agent_message', { to: rho3.endpointId, clientMessageId: 'over-receipts-2', body: 'x' }), 'receipt_quota_full'), 'lambda is still at its receipt quota')
  rmSync(aside, { recursive: true, force: true })
})

// --- c1/c2: no bodies outside the mailbox table -----------------------------------------------------------------------------

await step('no-bodies', async () => {
  const hits = []
  const skipDb = (path) => path.startsWith(join(LOCAL, 'state.sqlite')) || path.startsWith(join(LOCAL, 'backups')) || path.startsWith(join(REPO, '.git'))
  for (const file of [...walk(REPO, skipDb), ...walk(HOME_DIR)]) {
    const text = readFileSync(file).toString('utf8')
    if (text.includes(MARK)) hits.push(relative(S, file))
  }
  check('no-bodies.files', ['c1', 'c2'], hits.length === 0, { scanned: 'repo (tracked records, local/ except the database and its backups), DARKMECHANICUS_HOME', hits })
  const gitObjects = execFileSync('git', ['log', '--all', '-p', '--format=%H'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  check('no-bodies.git-history', ['c1'], !gitObjects.includes(MARK), 'git log -p of the scratch repository')
  const tracked = walk(join(REPO, '.darkmechanicus'), (path) => path.startsWith(LOCAL)).map((file) => readFileSync(file, 'utf8')).join('\n')
  const endpointIds = db().all('SELECT id FROM agent_mail_endpoints').map((row) => row.id)
  check('no-bodies.no-message-export', ['c1'], !tracked.includes('mm_') && endpointIds.every((id) => !tracked.includes(id)) && !/agent.?mail/i.test(tracked), 'tracked records name no message or endpoint')
  const tables = db().all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name)
  const tableHits = []
  for (const table of tables) {
    if (table === 'agent_mail_messages') continue
    const rows = db().all(`SELECT * FROM "${table}"`)
    if (JSON.stringify(rows).includes(MARK)) tableHits.push(table)
  }
  const nonBody = db().all('SELECT id, client_message_id, in_reply_to FROM agent_mail_messages')
  check('no-bodies.database-outside-message-body', ['c1', 'c2'], tableHits.length === 0 && !JSON.stringify(nonBody).includes(MARK), { tables: tables.length, tableHits, eventsRows: count('SELECT COUNT(*) AS n FROM events') })
  const stderrHits = cliTexts.filter((t) => t.stderr.includes(MARK)).length
  const errorHits = cliTexts.filter((t) => !t.ok && t.stdout.includes(MARK)).length
  check('no-bodies.cli-errors-and-stderr', ['c2'], stderrHits === 0 && errorHits === 0, { calls: cliTexts.length, stderrHits, errorHits })
  const history = await dm(null, 'search_history', { query: MARK })
  check('no-bodies.history-search', ['c1'], history.ok && JSON.stringify(history.data).includes(MARK) === false, { results: Array.isArray(history.data) ? history.data.length : history.data })
  const tokenHits = cliTexts.filter((t) => [...tokens.keys()].some((token) => t.stdout.includes(token) || t.stderr.includes(token))).length
  check('secrets.no-token-in-cli-output', ['c2'], tokenHits === 0 && leakedTokens === 0, { tokenHits, leakedTokens })
})

// --- c1: seven-day cleanup with a controlled clock (the CLI cannot move time) ------------------------------------------------

await step('seven-day-cleanup', async () => {
  const ackedRange = db().get('SELECT MIN(expires_at) AS lo, MAX(expires_at) AS hi, COUNT(*) AS n FROM agent_mail_messages WHERE acked_at IS NOT NULL')
  const receiptRange = db().get('SELECT MIN(expires_at) AS lo, MAX(expires_at) AS hi, COUNT(*) AS n FROM agent_mail_receipts')
  const unacked = count('SELECT COUNT(*) AS n FROM agent_mail_messages WHERE acked_at IS NULL')
  const drain = (ms) => {
    const deps = { db: db(), clock: fixedClock(ms), ids: desk.ctx().ids }
    const total = { messages: 0, receipts: 0, batches: 0 }
    for (;;) {
      const r = pruneAgentMail(deps)
      total.batches += 1
      total.messages += r.messages
      total.receipts += r.receipts
      if (r.messages + r.receipts === 0 || total.batches > 500) return total
    }
  }
  const early = drain(Math.min(Date.parse(ackedRange.lo), Date.parse(receiptRange.lo)) - 1000)
  check('cleanup7.nothing-before-seven-days', ['c1'], early.messages === 0 && early.receipts === 0, { clock: 'one second before the earliest expiry', early })
  const futureMs = Math.max(Date.parse(ackedRange.hi), Date.parse(receiptRange.hi)) + 1000
  const late7 = drain(futureMs)
  const left = { acked: count('SELECT COUNT(*) AS n FROM agent_mail_messages WHERE acked_at IS NOT NULL'), unacked: count('SELECT COUNT(*) AS n FROM agent_mail_messages WHERE acked_at IS NULL'), receipts: count('SELECT COUNT(*) AS n FROM agent_mail_receipts') }
  check('cleanup7.acked-and-receipts-expire-unacked-kept', ['c1'], late7.messages === ackedRange.n && late7.receipts === receiptRange.n && left.acked === 0 && left.receipts === 0 && left.unacked === unacked, { removed: late7, before: { acked: ackedRange.n, receipts: receiptRange.n, unacked }, left, batchesBoundedAt: 100 })
  // After seven days a clientMessageId is free and the receipt quota has room again: a desktop and agent on the future clock.
  const future = openDesktop(fixedClock(futureMs))
  const A2 = await rebind(future, A, 'future')
  const L2 = await rebind(future, L, 'future')
  const aFuture = agentWorkspace(A2, fixedClock(futureMs))
  const reused = await aFuture.sendAgentMessage({ to: B.endpointId, clientMessageId: 'j-1', body: `${MARK}-reuse another payload` })
  aFuture.close()
  const lFuture = agentWorkspace(L2, fixedClock(futureMs))
  const roomAgain = await lFuture.sendAgentMessage({ to: rho3.endpointId, clientMessageId: 'after-seven-days', body: `${MARK}-room` })
  lFuture.close()
  future.close()
  check('cleanup7.client-id-free-after-seven-days', ['c1'], reused.duplicate === false && reused.messageId !== s1.data.messageId, { reused: reused.messageId, original: s1.data.messageId, note: 'services with a controlled clock; the CLI cannot move time' })
  check('cleanup7.receipt-quota-recovers', ['c1'], roomAgain.duplicate === false, roomAgain.messageId)
})

desk.close()
results.finishedAt = new Date().toISOString()
results.summary = { checks: results.checks.length, failed: results.checks.filter((c) => !c.pass).map((c) => c.id), cliCalls: callNo }
writeFileSync(RESULTS, `${scrub(JSON.stringify(results, null, 2))}\n`)
rmSync(S, { recursive: true, force: true })
console.log(`${results.checks.length} checks, ${results.summary.failed.length} failed; ${callNo} CLI processes`)
process.exit(results.summary.failed.length === 0 ? 0 : 1)
