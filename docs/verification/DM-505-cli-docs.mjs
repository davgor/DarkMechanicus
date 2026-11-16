/**
 * DM-505 acceptance (c8, CLI half): runs the documented `dm` examples end to end against the built CLI with bound
 * scratch grants, in Git Bash, exactly as written except for placeholders (`me_…`, `mm_…`, `ep_…`, `dmg_…`), which are
 * replaced by the real scratch ids and tokens. Each line is read from the document at run time, so a doc edit that
 * breaks an example shows up here. Intentional refusals (no grant, reader, MCP stdio, backup by an agent) are recorded
 * as expected denials.
 *
 * `node` examples run with the Node on PATH from the worktree root and DARKMECHANICUS_REPO pointing at the scratch
 * folder (the runbook's documented default); `dm`/`$DM` examples run a chat's pinned command: the repository's Electron
 * with ELECTRON_RUN_AS_NODE=1, out/main/cli.js and --repo <scratch folder>.
 *
 * Usage, from the worktree root after `npm run build`, in Git Bash:
 *   env -u CI -u DM_DESKTOP_PIPE -u DM_SESSION_TOKEN node --import tsx docs/verification/DM-505-cli-docs.mjs
 * Writes docs/verification/DM-505-cli-docs-results.json (tokens masked); removes its scratch folder.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openWorkspace } from '../../src/core/workspace.ts'
import * as mail from '../../src/core/services/agentMail.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WT = join(HERE, '..', '..')
const ELECTRON = join(WT, 'node_modules', 'electron', 'dist', readFileSync(join(WT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim())
const RESULTS = join(HERE, 'DM-505-cli-docs-results.json')
const BASH = process.env.DM505_BASH ?? 'C:\\Program Files\\Git\\bin\\bash.exe'
for (const name of ['DM_DESKTOP_PIPE', 'DM_SESSION_TOKEN']) {
  if (process.env[name]) throw new Error(`Unset ${name} first.`)
}

const S = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm505-docs-')))
const REPO = join(S, 'repo')
const HOME_DIR = join(S, 'dm-home')
const USER_HOME = join(S, 'user home')
const TMP_DIR = join(S, 'tmp')
for (const dir of [REPO, HOME_DIR, USER_HOME, TMP_DIR]) mkdirSync(dir, { recursive: true })
execFileSync('git', ['init', '-q'], { cwd: REPO })
execFileSync('git', ['-c', 'user.name=dm505', '-c', 'user.email=dm505@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'scratch'], { cwd: REPO })
const desk = openWorkspace({ repoRoot: REPO, role: 'desktop', label: 'Desktop (DM-505 docs)', transport: 'desktop', pid: process.pid, homeDir: HOME_DIR })
await desk.initializeRepository({ name: 'dm505-docs' })
const tokens = []
async function grant(role, label) {
  const issued = await desk.issueGrant({ role, label })
  tokens.push(issued.token)
  return { grantId: issued.grant.id, token: issued.token }
}
async function bound(chatId, name, role) {
  const endpoint = mail.provisionAgentMailEndpoint(desk.ctx(), { chatId, name })
  const g = await grant(role, chatId)
  mail.bindAgentMailEndpoint(desk.ctx(), { endpointId: endpoint.id, grantId: g.grantId })
  return { endpointId: endpoint.id, ...g }
}
const A = await bound('ch_docs_alpha', 'Alpha', 'worker')
const B = await bound('ch_docs_beta', 'Beta', 'reviewer')
const reader = await grant('reader', 'docs reader')
const orchestrator = await grant('orchestrator', 'docs orchestrator')
const epic = await desk.createEpic({ title: 'Docs example epic' })

const DOCS = {
  cli: readFileSync(join(WT, 'docs', 'runbooks', 'cli.md'), 'utf8').split(/\r?\n/),
  verification: readFileSync(join(WT, 'docs', 'verification', 'skitarii-messaging.md'), 'utf8').split(/\r?\n/)
}
/** The document's own line (trimmed of a trailing `# comment`), found by its exact text; fails when the doc no longer has it. */
function docLine(doc, text) {
  const index = DOCS[doc].findIndex((line) => line.trim() === text || line.trim().startsWith(`${text} `) || line.trim().startsWith(`${text}\t`))
  if (index < 0) throw new Error(`docs ${doc} no longer contains: ${text}`)
  return { line: index + 1, text: DOCS[doc][index].trim() }
}

const PRELUDE = [
  `export PATH="${dirname(process.execPath).replace(/\\/g, '/')}:$PATH"`,
  `export HOME="${USER_HOME.replace(/\\/g, '/')}" TMP="${TMP_DIR.replace(/\\/g, '/')}"`,
  `export DARKMECHANICUS_HOME="${HOME_DIR.replace(/\\/g, '/')}" DARKMECHANICUS_REPO="${REPO.replace(/\\/g, '/')}"`,
  `APP="${WT.replace(/\\/g, '/')}" REPO="${REPO.replace(/\\/g, '/')}" HOME_DIR="${HOME_DIR.replace(/\\/g, '/')}"`,
  `dm() { ELECTRON_RUN_AS_NODE=1 "${ELECTRON.replace(/\\/g, '/')}" "$APP/out/main/cli.js" --repo "$REPO" "$@"; }`,
  'DM=dm',
  'unset DM_SESSION_TOKEN DM_DESKTOP_PIPE CI ELECTRON_RUN_AS_NODE NODE_OPTIONS'
].join('\n')

const steps = []
function bash(command, token) {
  const script = `${PRELUDE}\n${token ? `export DM_SESSION_TOKEN='${token}'\n` : ''}cd "$APP"\n${command}\n`
  const env = { ...process.env }
  for (const name of ['DM_SESSION_TOKEN', 'DM_DESKTOP_PIPE', 'CI', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[name]
  const result = spawnSync(BASH, ['-c', script], { env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
}
function parse(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}
/** Runs one documented line as `who`, with placeholders replaced; records it and whether it matched its expectation. */
function run(doc, text, { as, who = as ? as.label : 'no grant', subst = {}, expect, prefix = '' }) {
  const source = docLine(doc, text)
  let command = source.text.replace(/\s+#\s.*$/, '')
  for (const [from, to] of Object.entries(subst)) command = command.split(from).join(to)
  const result = bash(`${prefix}${command}`, as?.token)
  const out = parse(result.stdout)
  const verdict = expect({ ...result, out })
  steps.push({ doc: `${doc === 'cli' ? 'docs/runbooks/cli.md' : 'docs/verification/skitarii-messaging.md'}:${source.line}`, documented: source.text, ran: `${prefix}${command}`, as: who, exitCode: result.exitCode, out: out ?? result.stdout.slice(0, 2000), stderr: result.stderr.trim().slice(0, 1000) || undefined, pass: verdict === true })
  console.log(`${verdict === true ? 'PASS' : 'FAIL'} ${doc}:${source.line} ${source.text.slice(0, 90)}`)
  return out
}
const okJson = ({ exitCode, out }) => exitCode === 0 && out?.ok === true
const deniedJson = (code) => ({ exitCode, out }) => exitCode === 1 && out?.ok === false && out.error.code === code
const alpha = { label: 'alpha (bound worker)', token: A.token }
const beta = { label: 'beta (bound reviewer)', token: B.token }

// Discover, then call.
run('cli', 'node out/main/cli.js --help', { expect: ({ exitCode, stdout }) => exitCode === 0 && stdout.includes('call') })
run('cli', 'node out/main/cli.js --list', { expect: ({ exitCode, out }) => exitCode === 0 && ['get_agent_identity', 'list_agent_peers', 'send_agent_message', 'read_agent_inbox', 'acknowledge_agent_messages', 'get_agent_mail_status', 'take_agent_mail_wake'].every((n) => JSON.stringify(out).includes(n)) })
run('cli', 'node out/main/cli.js --describe claim_ticket', { expect: okJson })
run('cli', "node out/main/cli.js call list_epics '{}'", { expect: ({ exitCode, out }) => okJson({ exitCode, out }) && JSON.stringify(out).includes(epic.id) })
run('cli', `node out/main/cli.js call get_epic '{"epicId":"ep_…"}'`, { subst: { 'ep_…': epic.id }, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.id === epic.id })

// Authority: token file and environment (an orchestrator grant, as create_epic needs).
run('cli', "umask 077 && printf '%s' 'dmg_…' > ~/.config/dm-token", { who: 'orchestrator (token written to a scratch HOME)', subst: { 'dmg_…': orchestrator.token }, prefix: 'mkdir -p ~/.config && ', expect: ({ exitCode }) => exitCode === 0 })
run('cli', `node out/main/cli.js --token-file ~/.config/dm-token call create_epic '{"title":"…"}'`, { who: 'orchestrator via --token-file', subst: { '"…"': '"Docs token-file epic"' }, expect: okJson })
run('cli', "export DM_SESSION_TOKEN='dmg_…'", { who: 'orchestrator via env', subst: { 'dmg_…': orchestrator.token }, expect: ({ exitCode }) => exitCode === 0 })
run('cli', `node out/main/cli.js call create_epic '{"title":"…"}'`, { who: 'orchestrator via env', subst: { '"…"': '"Docs env epic"' }, prefix: `export DM_SESSION_TOKEN='${orchestrator.token}' && `, expect: okJson })

// Agent mail between Skitarii chats (cli.md), alpha sends, beta reads, replies and acknowledges.
run('cli', `printf '%s' '{"limit":10}' | dm call list_agent_peers -`, { as: alpha, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.peers.some((p) => p.endpointId === B.endpointId) })
const sent = run('cli', `printf '%s' '{"to":"me_…","clientMessageId":"review-1","body":"Ready for review?"}' | dm call send_agent_message -`, { as: alpha, subst: { 'me_…': B.endpointId }, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.duplicate === false })
const M = sent?.data?.messageId ?? 'mm_missing'
run('cli', 'dm call get_agent_mail_status', { as: beta, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.pendingCount === 1 })
run('cli', `printf '%s' '{"unacknowledgedOnly":true}' | dm call read_agent_inbox -`, { as: beta, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.messages[0]?.id === M && out.data.messages[0].body === 'Ready for review?' })
run('cli', `printf '%s' '{"to":"me_…","clientMessageId":"review-1-reply","body":"Reviewed.","inReplyTo":"mm_…"}' > "$TMP/reply.json"`, { as: beta, subst: { 'me_…': A.endpointId, 'mm_…': M }, expect: ({ exitCode }) => exitCode === 0 })
run('cli', 'dm call send_agent_message --args-file "$TMP/reply.json"', { as: beta, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.inReplyTo === M })
run('cli', `printf '%s' '{"messageIds":["mm_…"]}' > "$TMP/ack.json"`, { as: beta, subst: { 'mm_…': M }, expect: ({ exitCode }) => exitCode === 0 })
run('cli', 'dm call acknowledge_agent_messages --args-file "$TMP/ack.json"', { as: beta, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.acknowledged[0].messageId === M })

// The acceptance procedure's CLI lines (verification doc step 6), as alpha replying to beta's reply.
const alphaInbox = parse(bash(`printf '%s' '{"unacknowledgedOnly":true}' | dm call read_agent_inbox -`, A.token).stdout)
const R = alphaInbox?.data?.messages[0]?.id ?? 'mm_missing'
run('verification', '$DM call get_capabilities', { as: alpha, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.mailbox.bound === true && out.data.mailbox.endpointId === A.endpointId })
run('verification', `printf '%s' '{"limit":10}' | $DM call list_agent_peers -`, { as: alpha, expect: okJson })
run('verification', `printf '%s' '{"unacknowledgedOnly":true}' | $DM call read_agent_inbox -`, { as: alpha, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.messages[0]?.id === R && out.data.messages[0].acknowledgedAt === null })
run('verification', `printf '%s' '{"to":"<A>","clientMessageId":"reply-1","body":"Reviewed: ship it.","inReplyTo":"<M1>"}' > "$TMP/reply.json"`, { as: alpha, subst: { '<A>': B.endpointId, '<M1>': R }, expect: ({ exitCode }) => exitCode === 0 })
run('verification', '$DM call send_agent_message --args-file "$TMP/reply.json"', { as: alpha, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.inReplyTo === R && out.data.duplicate === false })
run('verification', `printf '%s' '{"messageIds":["<M1>"]}' > "$TMP/ack.json"`, { as: alpha, subst: { '<M1>': R }, expect: ({ exitCode }) => exitCode === 0 })
const ack1 = run('verification', '$DM call acknowledge_agent_messages --args-file "$TMP/ack.json"', { as: alpha, expect: okJson })
const ack2 = parse(bash('$DM call acknowledge_agent_messages --args-file "$TMP/ack.json"', A.token).stdout)
steps.push({ doc: 'docs/verification/skitarii-messaging.md (second identical acknowledge line)', as: alpha.label, out: ack2, pass: ack2?.ok === true && ack2.data.acknowledged[0].acknowledgedAt === ack1?.data?.acknowledged[0].acknowledgedAt && Date.parse(ack1.data.acknowledged[0].expiresAt) - Date.parse(ack1.data.acknowledged[0].acknowledgedAt) === 7 * 86_400_000 })
run('verification', '$DM call get_agent_mail_status', { as: alpha, expect: ({ exitCode, out }) => okJson({ exitCode, out }) && out.data.pendingCount === 0 })
const unknown = parse(bash(`printf '%s' '{"to":"${B.endpointId}","clientMessageId":"reply-2","body":"x","inReplyTo":"mm_unknown"}' | $DM call send_agent_message -`, A.token).stdout)
steps.push({ doc: 'docs/verification/skitarii-messaging.md:108 ("inReplyTo":"mm_unknown" is refused)', as: alpha.label, out: unknown, pass: unknown?.ok === false && ['reply_unavailable', 'invalid_input'].includes(unknown.error.code), expectedDenial: true })

// Intentional refusals: no grant (step 8), reader grant, agent backup, MCP stdio.
run('verification', 'cd "$REPO" && DARKMECHANICUS_HOME="$HOME_DIR" node "$APP/out/main/cli.js" --repo "$REPO" call get_agent_identity', { who: 'no grant (expected denial)', expect: deniedJson('unauthorized') })
const readerDenied = parse(bash('dm call get_agent_identity', reader.token).stdout)
steps.push({ doc: 'docs/runbooks/cli.md:249 (a reader grant gets unauthorized)', as: 'reader (expected denial)', out: readerDenied, pass: readerDenied?.ok === false && readerDenied.error.code === 'unauthorized', expectedDenial: true })
const backupDenied = parse(bash("dm call backup_database '{}'", A.token).stdout)
steps.push({ doc: 'docs/verification/skitarii-messaging.md:127 / cli.md:310 (backup_database is desktop-only)', as: 'alpha (expected denial)', out: backupDenied, pass: backupDenied?.ok === false && backupDenied.error.code === 'unauthorized', expectedDenial: true })
const orchestratorBackup = parse(bash("dm call backup_database '{}'", orchestrator.token).stdout)
steps.push({ doc: 'docs/runbooks/cli.md:310 (unbound orchestrator full backup)', as: 'orchestrator (expected denial)', out: orchestratorBackup, pass: orchestratorBackup?.ok === false && orchestratorBackup.error.code === 'unauthorized', expectedDenial: true })
const transport = new StdioClientTransport({ command: ELECTRON, args: [join(WT, 'out', 'main', 'mcp.js'), '--repo', REPO, '--role', 'worker'], env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DM_|CI$|NODE_OPTIONS)/.test(k))), ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: HOME_DIR, DM_SESSION_TOKEN: A.token }, stderr: 'pipe' })
const client = new Client({ name: 'dm505-docs', version: '1.0.0' })
await client.connect(transport)
const mcpIdentity = (await client.callTool({ name: 'get_agent_identity', arguments: {} })).structuredContent
await client.close()
steps.push({ doc: 'docs/runbooks/cli.md:239-241 / verification:126 (MCP stdio session, even with an inherited bound DM_SESSION_TOKEN)', as: 'MCP stdio worker (expected denial)', out: mcpIdentity, pass: mcpIdentity?.ok === false && mcpIdentity.error.code === 'unauthorized', expectedDenial: true })

desk.close()
const results = {
  ticket: 'DM-505',
  criteria: ['c8 (documented CLI examples)'],
  ranAt: new Date().toISOString(),
  shell: execFileSync(BASH, ['--version'], { encoding: 'utf8' }).split('\n')[0],
  node: process.version,
  commit: execFileSync('git', ['-C', WT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  steps,
  summary: { steps: steps.length, failed: steps.filter((s) => !s.pass).map((s) => s.doc) }
}
let text = JSON.stringify(results, null, 2)
for (const token of tokens) text = text.split(token).join('[token]')
text = text.split(S).join('<scratch>').split(S.replace(/\\/g, '/')).join('<scratch>')
writeFileSync(RESULTS, `${text}\n`)
rmSync(S, { recursive: true, force: true })
console.log(`${steps.length} steps, ${results.summary.failed.length} failed`)
process.exit(results.summary.failed.length === 0 ? 0 : 1)
