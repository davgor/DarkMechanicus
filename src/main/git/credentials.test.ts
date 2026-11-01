import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { credentialArgs, sshPromptEnv } from './credentials'
import { createGitRunner } from './runner'

const LOGIN = 'octo-cat'
const TOKEN = 'gho_FAKE_TOKEN_never_leak_123'
const signedIn = { getAccount: () => ({ login: LOGIN }), getToken: () => TOKEN }
const signedOut = { getAccount: () => null, getToken: () => null }

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

describe('credentialArgs', () => {
  it('clears every helper git would use for https://github.com, then adds the env helper scoped to it', () => {
    const creds = credentialArgs('https://github.com/octo/hello.git', signedIn)
    expect(creds?.args).toEqual([
      '-c',
      'credential.https://github.com.helper=',
      '-c',
      'credential.https://github.com.helper=!f() { echo username="$DM_GITHUB_LOGIN"; echo password="$DM_GITHUB_TOKEN"; }; f'
    ])
    expect(creds?.env).toEqual({ DM_GITHUB_LOGIN: LOGIN, DM_GITHUB_TOKEN: TOKEN, GIT_TRACE_REDACT: '1' })
    expect(creds?.secrets).toEqual([TOKEN, Buffer.from(`${LOGIN}:${TOKEN}`).toString('base64')])
    expect(JSON.stringify(creds?.args)).not.toContain(TOKEN)
  })

  it.each([
    ['signed out', 'https://github.com/octo/hello.git', signedOut],
    ['an account whose token cannot be read', 'https://github.com/octo/hello.git', { getAccount: () => ({ login: LOGIN }), getToken: () => null }],
    ['scp-like SSH', 'git@github.com:octo/hello.git', signedIn],
    ['ssh://', 'ssh://git@github.com/octo/hello.git', signedIn],
    ['plain http', 'http://github.com/octo/hello.git', signedIn],
    ['another host', 'https://gitlab.com/octo/hello.git', signedIn],
    ['a look-alike host', 'https://github.com.evil.example/octo/hello.git', signedIn],
    ['an explicit port', 'https://github.com:443/octo/hello.git', signedIn],
    ['a file path', '/srv/git/hello.git', signedIn],
    ['a token with a newline', 'https://github.com/octo/hello.git', { getAccount: () => ({ login: LOGIN }), getToken: () => 'abc\npassword=evil' }],
    ['a login with a space', 'https://github.com/octo/hello.git', { getAccount: () => ({ login: 'a b' }), getToken: () => TOKEN }]
  ])('returns nothing for %s', (_name, url, session) => {
    expect(credentialArgs(url, session)).toBeNull()
  })
})

/** A global config whose helpers (generic, github.com-scoped, path- and user-scoped, wildcard) each leave a marker if they run. */
function hostileGlobalConfig(): { markers: string[]; home: string } {
  const dir = scratchDir('dm-cred-')
  cleanups.push(dir.cleanup)
  const keys = [
    'credential.helper',
    'credential.https://github.com.helper',
    'credential.https://github.com/octo.helper',
    'credential.https://octo@github.com.helper',
    'credential.https://*.com.helper'
  ]
  const markers = keys.map((_key, at) => join(dir.path, `helper-${at}-ran`))
  const helper = (marker: string): string => `!f() { echo ran > '${marker}'; echo username=machine; echo password=machine-secret; }; f`
  const global = join(dir.path, 'gitconfig')
  writeFileSync(global, '')
  keys.forEach((key, at) => gitIn(dir.path, 'config', '--file', global, key, helper(markers[at])))
  gitIn(dir.path, 'config', '--file', global, 'credential.useHttpPath', 'true')
  vi.stubEnv('GIT_CONFIG_GLOBAL', global)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  return { markers, home: dir.path }
}

async function credentialFill(cwd: string, args: readonly string[], env: Record<string, string> = {}, request = 'host=github.com'): Promise<string> {
  const result = await createGitRunner().run({ cwd, args: [...args, 'credential', 'fill'], kind: 'network', stdin: `protocol=https\n${request}\n\n`, env })
  return result.stdout
}

describe('git credential fill (offline)', () => {
  it('answers with the account login and token, and no other helper runs', async () => {
    const { markers, home } = hostileGlobalConfig()
    const local = join(home, 'repo')
    gitIn(home, 'init', '-q', local)
    gitIn(local, 'config', 'credential.helper', `!f() { echo ran > '${join(home, 'local-ran')}'; }; f`)
    const creds = credentialArgs('https://github.com/octo/hello.git', signedIn)
    if (creds === null) {
      throw new Error('expected credentials')
    }
    // The exact request the ticket names, then one with a path and a user name (credential.useHttpPath is on).
    for (const request of ['host=github.com', 'host=github.com\nusername=octo\npath=octo/hello.git']) {
      const answer = await credentialFill(local, creds.args, creds.env, request)
      expect(answer).toContain(`username=${LOGIN}\n`)
      expect(answer).toContain(`password=${TOKEN}\n`)
      expect(answer).not.toContain('machine')
    }
    for (const marker of [...markers, join(home, 'local-ran')]) {
      expect(existsSync(marker), marker).toBe(false)
    }
  })

  it('never hands the GitHub token to another host, whose own helpers still answer', async () => {
    const { markers, home } = hostileGlobalConfig()
    const creds = credentialArgs('https://github.com/octo/hello.git', signedIn)
    if (creds === null) {
      throw new Error('expected credentials')
    }
    const answer = await credentialFill(home, creds.args, creds.env, 'host=gitlab.example')
    expect(answer).toContain('password=machine-secret')
    expect(answer).not.toContain(TOKEN)
    expect(existsSync(markers[0])).toBe(true)
  })

  it('without our arguments (signed out) the machine helper answers', async () => {
    const { markers, home } = hostileGlobalConfig()
    expect(await credentialFill(home, [])).toContain('password=machine-secret')
    expect(existsSync(markers[0])).toBe(true)
  })
})

describe('sshPromptEnv', () => {
  it('runs ssh in batch mode, so it fails instead of prompting', () => {
    expect(sshPromptEnv(null, {})).toEqual({ GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' })
    expect(sshPromptEnv(null, { GIT_SSH_COMMAND: '' })).toEqual({ GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' })
  })

  it("leaves the person's own ssh command alone", () => {
    expect(sshPromptEnv('ssh -i ~/.ssh/work', {})).toEqual({})
    expect(sshPromptEnv(null, { GIT_SSH_COMMAND: 'ssh -v' })).toEqual({})
    expect(sshPromptEnv(null, { GIT_SSH: 'plink' })).toEqual({})
  })
})
