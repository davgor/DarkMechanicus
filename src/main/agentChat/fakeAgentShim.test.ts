import { cpSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { fakeAgentFixture, runFakeLauncher } from './__mocks__/agentChatRig'
import { fakeAgentShim } from './__mocks__/fakeAgentShim'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeScratch(root) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dm launcher spaces '))
  roots.push(root)
  const fixtures = join(root, "fixture's source with spaces")
  cpSync(dirname(fakeAgentFixture), fixtures, { recursive: true })
  const fixture = join(fixtures, 'fakeAgentCli.mjs')
  const env: NodeJS.ProcessEnv & { FAKE_AGENT_LOG: string } = { ...process.env, FAKE_AGENT_LOG: join(root, 'argv.jsonl') }
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH'
  env[key] = `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${env[key] ?? ''}`
  return { root, fixture, env }
}

it('executes the host-native launcher for version/auth and preserves spaced arguments', () => {
  const { root, fixture, env } = setup()
  const executable = fakeAgentShim(join(root, 'launcher with spaces'), fixture)
  const args = ['--version', 'argument with spaces', "apostrophe's value"]
  const version = runFakeLauncher(executable, args, env)
  expect(version.error).toBeUndefined()
  expect(version.status).toBe(0)
  expect(version.stdout).toContain('Claude Code')
  const auth = runFakeLauncher(executable, ['auth', 'status'], env)
  expect(auth.status).toBe(0)
  expect(JSON.parse(auth.stdout)).toEqual({ loggedIn: true })
  const records = readFileSync(env.FAKE_AGENT_LOG, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  expect(records[0].argv).toEqual(args)
  expect(records[1].mode).toBe('auth')
  if (process.platform !== 'win32') expect(statSync(executable).mode & 0o111).toBe(0o111)
})

it('generates CRLF npm-style Windows shims using file URLs for dynamic import', () => {
  const { root, fixture } = setup()
  const executable = fakeAgentShim(join(root, 'windows'), fixture, 'win32')
  expect(readFileSync(executable, 'utf8')).toBe('@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nnode "%dp0%\\fake-claude.js" %*\r\n')
  expect(readFileSync(join(dirname(executable), 'fake-claude.js'), 'utf8'))
    .toBe(`import(require('node:url').pathToFileURL(${JSON.stringify(fixture)}).href)\n`)
})

it('generates the POSIX exec-node contract with safe apostrophe quoting and intact argv', () => {
  const { root, fixture } = setup()
  const executable = fakeAgentShim(join(root, 'posix'), fixture, 'linux')
  const quoted = `'${fixture.replaceAll("'", "'\\''")}'`
  expect(readFileSync(executable, 'utf8')).toBe(`#!/bin/sh\nexec node ${quoted} "$@"\n`)
  // On Windows this is contract inspection only; the native test above executes POSIX on POSIX hosts.
  if (process.platform !== 'win32') expect(statSync(executable).mode & 0o111).toBe(0o111)
})
