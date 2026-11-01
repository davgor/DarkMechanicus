import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccountStore, type AccountCrypto, type AccountFs } from './accountStore'
import { GithubError } from './errors'

const TOKEN = 'gho_FAKE_TOKEN_never_leak_123'
const ACCOUNT = { login: 'octocat', name: 'The Octocat', scopes: 'repo, read:user, workflow' }

/** Reversible and obviously not plain text: the bytes are reversed and prefixed. */
function fakeCrypto(available = true): AccountCrypto & { decrypts: number } {
  const crypto = {
    decrypts: 0,
    isAvailable: () => available,
    encrypt: (text: string) => Buffer.from(`enc:${[...text].reverse().join('')}`),
    decrypt: (data: Buffer) => {
      crypto.decrypts += 1
      const text = data.toString()
      if (!text.startsWith('enc:')) {
        throw new Error('not ours')
      }
      return Array.from(text.slice(4)).reverse().join('')
    }
  }
  return crypto
}

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dm-github-store-'))
  file = join(dir, 'nested', 'github-account.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createAccountStore', () => {
  it('round-trips the account and token through encryption, across store instances', () => {
    const store = createAccountStore({ file, crypto: fakeCrypto() })
    expect(store.getAccount()).toBeNull()
    expect(store.getToken()).toBeNull()
    store.save(ACCOUNT, TOKEN)
    expect(store.getAccount()).toEqual(ACCOUNT)
    expect(store.getToken()).toBe(TOKEN)

    const reopened = createAccountStore({ file, crypto: fakeCrypto() })
    expect(reopened.getAccount()).toEqual(ACCOUNT)
    expect(reopened.getToken()).toBe(TOKEN)
  })

  it('writes version 1 with the token as base64 of the encrypted bytes, never the plain token', () => {
    createAccountStore({ file, crypto: fakeCrypto() }).save(ACCOUNT, TOKEN)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(TOKEN)
    expect(JSON.parse(text)).toEqual({
      version: 1,
      login: 'octocat',
      name: 'The Octocat',
      scopes: 'repo, read:user, workflow',
      token: Buffer.from(`enc:${[...TOKEN].reverse().join('')}`).toString('base64')
    })
    expect(readdirSync(join(dir, 'nested'))).toEqual(['github-account.json'])
  })

  it('never keeps the decrypted token: getAccount checks a loaded account decrypts once, getToken decrypts on every call', () => {
    const saving = fakeCrypto()
    const saved = createAccountStore({ file, crypto: saving })
    saved.save(ACCOUNT, TOKEN)
    expect(saved.getAccount()).toEqual(ACCOUNT)
    expect(saving.decrypts).toBe(0)

    const crypto = fakeCrypto()
    const store = createAccountStore({ file, crypto })
    store.getAccount()
    store.getAccount()
    expect(crypto.decrypts).toBe(1)
    store.getToken()
    store.getToken()
    expect(crypto.decrypts).toBe(3)
  })
})

describe('createAccountStore: refusal and sign-out', () => {
  it('refuses with secure_storage_unavailable when OS encryption is unavailable, and writes nothing', () => {
    const store = createAccountStore({ file, crypto: fakeCrypto(false) })
    expect(store.canEncrypt()).toBe(false)
    expect(() => store.save(ACCOUNT, TOKEN)).toThrow(GithubError)
    expect(() => store.save(ACCOUNT, TOKEN)).toThrow(expect.objectContaining({ code: 'secure_storage_unavailable' }))
    expect(existsSync(file)).toBe(false)
  })

  it('sign-out deletes the file and forgets the account', () => {
    const store = createAccountStore({ file, crypto: fakeCrypto() })
    store.save(ACCOUNT, TOKEN)
    store.signOut()
    expect(existsSync(file)).toBe(false)
    expect(store.getAccount()).toBeNull()
    expect(store.getToken()).toBeNull()
    expect(() => store.signOut()).not.toThrow()
  })

  it('sign-out also deletes a tmp file an interrupted write left behind', () => {
    const store = createAccountStore({ file, crypto: fakeCrypto() })
    store.save(ACCOUNT, TOKEN)
    writeFileSync(`${file}.tmp`, 'left over')
    store.signOut()
    expect(readdirSync(join(dir, 'nested'))).toEqual([])
  })
})

describe('createAccountStore: atomic writes', () => {
  it('writes a tmp file, then renames it over the account file', () => {
    const operations: string[] = []
    const fs: AccountFs = {
      readFile: (path) => readFileSync(path, 'utf8'),
      writeFile: (path, data) => {
        operations.push(`write ${path}`)
        writeFileSync(path, data)
      },
      rename: (from, to) => {
        operations.push(`rename ${from} -> ${to}`)
        renameSync(from, to)
      },
      mkdirp: () => undefined,
      remove: () => undefined
    }
    writeFileSync(join(dir, 'github-account.json'), '{}')
    createAccountStore({ file: join(dir, 'github-account.json'), crypto: fakeCrypto(), fs }).save(ACCOUNT, TOKEN)
    expect(operations).toEqual([
      `write ${join(dir, 'github-account.json.tmp')}`,
      `rename ${join(dir, 'github-account.json.tmp')} -> ${join(dir, 'github-account.json')}`
    ])
  })

  it('keeps the previous account when the write fails', () => {
    const store = createAccountStore({ file, crypto: fakeCrypto() })
    store.save(ACCOUNT, TOKEN)
    const failing = createAccountStore({
      file,
      crypto: fakeCrypto(),
      fs: {
        readFile: (path) => readFileSync(path, 'utf8'),
        writeFile: () => {
          throw new Error('disk full')
        },
        rename: renameSync,
        mkdirp: () => undefined,
        remove: () => undefined
      }
    })
    expect(() => failing.save({ ...ACCOUNT, login: 'other' }, 'gho_other')).toThrow('disk full')
    expect(failing.getAccount()).toEqual(ACCOUNT)
  })
})

describe('createAccountStore: unreadable files', () => {
  it('treats a missing, corrupt or undecryptable file as signed out', () => {
    expect(createAccountStore({ file, crypto: fakeCrypto() }).getAccount()).toBeNull()
    createAccountStore({ file, crypto: fakeCrypto() }).save(ACCOUNT, TOKEN)
    writeFileSync(file, '{ not json')
    expect(createAccountStore({ file, crypto: fakeCrypto() }).getAccount()).toBeNull()
    writeFileSync(file, JSON.stringify({ version: 1, login: 'octocat', name: null, scopes: '', token: Buffer.from('plain').toString('base64') }))
    const store = createAccountStore({ file, crypto: fakeCrypto() })
    expect(store.getAccount()).toBeNull()
    expect(store.getToken()).toBeNull()
  })

  it('treats the account as signed out, without decrypting, while OS encryption is unavailable', () => {
    createAccountStore({ file, crypto: fakeCrypto() }).save(ACCOUNT, TOKEN)
    const crypto = fakeCrypto(false)
    const store = createAccountStore({ file, crypto })
    expect(store.getToken()).toBeNull()
    expect(store.getAccount()).toBeNull()
    expect(crypto.decrypts).toBe(0)
    // The file is kept: encryption may come back (a keyring unlocked later).
    expect(existsSync(file)).toBe(true)
  })
})
