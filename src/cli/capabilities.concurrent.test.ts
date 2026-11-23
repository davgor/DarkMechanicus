import { buildSync } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { isBusyError, openDatabase, type Db } from '../core/db/database'
import { hashToken } from '../core/services/grants'
import { bindAgentMailEndpoint, provisionAgentMailEndpoint } from '../core/services/agentMail'
import { runWorkspaceOperation } from '../main/desktop/workspaceOperations'
import { createHarness, type Harness } from '../test/workspaceHarness'
import type { CapabilitiesView } from '../shared/domain/views'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const GRANT_BARRIER = 'DM_CAPABILITIES_GRANT_BARRIER'

let harness: Harness | undefined
let writer: Db | undefined
let bundleDir: string | undefined
const children: ChildProcess[] = []

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('close', () => resolve())
    child.kill()
  })))
  writer?.close()
  writer = undefined
  harness?.cleanup()
  harness = undefined
  if (bundleDir !== undefined) rmSync(bundleDir, { recursive: true, force: true })
  bundleDir = undefined
})

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Bundle the source CLI like the existing Forge child fixtures, including the real shipped skill text. */
function capabilityBundle(): string {
  if (bundleDir !== undefined) return join(bundleDir, 'capabilities.cjs')
  bundleDir = mkdtempSync(join(tmpdir(), 'dm-capabilities-child-'))
  const file = join(bundleDir, 'capabilities.cjs')
  buildSync({
    stdin: { resolveDir: ROOT, contents: `
      import { readFileSync, writeSync } from 'node:fs';
      import { openWorkspace } from './src/core/workspace';
      import { runCli } from './src/cli/main';
      const { root, home, token } = JSON.parse(process.env.DM_CAPABILITIES_FIXTURE);
      let paused = false;
      const clock = {
        nowMs: () => Date.now(),
        nowIso: () => {
          if (!paused) {
            paused = true;
            writeSync(2, ${JSON.stringify(GRANT_BARRIER + '\n')});
            readFileSync(0);
          }
          return new Date().toISOString();
        }
      };
      void runCli({
        argv: ['--repo', root, 'call', 'get_capabilities', '{}'],
        env: { DM_SESSION_TOKEN: token }, cwd: root,
        execPath: process.execPath, cliPath: __filename,
        open: (options) => openWorkspace({ ...options, homeDir: home, clock, databaseSynchronous: 'off' }),
        readFile: (path) => readFileSync(path, 'utf8'), readStdin: () => readFileSync(0, 'utf8'),
        writeStdout: (text) => writeSync(1, text), writeStderr: (text) => writeSync(2, text),
        exit: (code) => { process.exitCode = code; }
      });` },
    outfile: file, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    loader: { '.md': 'text' }, logLevel: 'warning',
    banner: { js: `require = require('node:module').createRequire(${JSON.stringify(join(ROOT, 'package.json'))});` }
  })
  return file
}

/** Pause at the supported clock seam immediately before grant redemption, without changing SQLite or command code. */
function capabilityProcess(root: string, home: string, token: string, atGrant: () => Promise<void>): Promise<CliResult> {
  const child = spawn(process.execPath, [capabilityBundle()], {
    cwd: ROOT, env: { ...process.env, DM_CAPABILITIES_FIXTURE: JSON.stringify({ root, home, token }) }
  })
  children.push(child)
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let paused = false
    let barrierError: unknown
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (paused || !stderr.split(/\r?\n/).includes(GRANT_BARRIER)) return
      paused = true
      void atGrant().catch((error: unknown) => { barrierError = error }).finally(() => child.stdin.end())
    })
    child.on('error', reject)
    child.stdin.on('error', reject)
    child.on('close', (code) => {
      if (barrierError !== undefined) reject(barrierError)
      else resolve({ code, stdout, stderr })
    })
  })
}

async function capabilityFixture() {
  harness = createHarness()
  harness.clock.set(new Date().toISOString())
  const desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'Concurrent capabilities', mode: 'db' })
  const grants = await Promise.all(Array.from({ length: 3 }, (_, index) => desktop.issueGrant({ role: 'worker', label: `Worker ${index}` })))
  const endpoints = grants.map(({ grant }, index) => {
    const endpoint = provisionAgentMailEndpoint(desktop.ctx(), { chatId: `worker-${index}`, name: `Worker ${index}` })
    bindAgentMailEndpoint(desktop.ctx(), { endpointId: endpoint.id, grantId: grant.id })
    return endpoint
  })
  return { desktop, grants, endpoints }
}

it('returns authorized capabilities and clean CLI exits for three concurrent workers while serializing their grant audits', async () => {
  const { desktop, grants, endpoints } = await capabilityFixture()
  const probe = writer = openDatabase(desktop.ctx().db.path, { busyTimeoutMs: 0, beginRetries: 0, synchronous: 'off' })
  const interventions: string[] = []
  let held = false
  const results = await Promise.all(grants.map(({ grant, token }) => capabilityProcess(harness!.root, harness!.homeDir, token, async () => {
    // Intervene before grant redemption, not after a timed delay. The atomic audit must already hold the writer lock;
    // without it this competing writer gets in and the CLI's unguarded grant UPDATE fails, at the unchanged timeout.
    if (held) interventions.push('acquired')
    else {
      try {
        probe.exec('BEGIN IMMEDIATE')
        held = true
        interventions.push('acquired')
      } catch (error) {
        if (!isBusyError(error)) throw error
        expect(error).toMatchObject({ errcode: 5 })
        interventions.push('busy')
      }
    }
    await runWorkspaceOperation(desktop, { kind: 'native', name: 'verifyChatGrant', args: [grant.id, hashToken(token), 'chat.name'] }, harness!.homeDir)
  }))).finally(() => {
    if (held) probe.exec('ROLLBACK')
  })
  const sessions = new Set<string | null>()
  for (const [index, result] of results.entries()) {
    expect(result.code, result.stderr + result.stdout).toBe(0)
    const response = JSON.parse(result.stdout) as { ok: boolean; data: CapabilitiesView }
    expect(response.ok).toBe(true)
    expect(response.data).toMatchObject({ initialized: true, role: 'worker', mailbox: { bound: true, endpointId: endpoints[index]!.id } })
    sessions.add(response.data.sessionId)
    expect(response.data.capabilities).toContain('read')
    expect(response.data.capabilities).not.toContain('checkpoint.approve')
    expect(response.data.capabilities).not.toContain('grant.issue')
    expect(desktop.ctx().db.get('SELECT grant_id, role, ended_at FROM sessions WHERE id = ?', response.data.sessionId!))
      .toMatchObject({ grant_id: grants[index]!.grant.id, role: 'worker', ended_at: expect.any(String) })
    expect(desktop.ctx().db.get('SELECT last_used_at FROM grants WHERE id = ?', grants[index]!.grant.id))
      .toMatchObject({ last_used_at: expect.any(String) })
  }
  expect(interventions).toEqual(['busy', 'busy', 'busy'])
  expect(sessions.size).toBe(3)
})
