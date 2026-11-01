/**
 * The signed-in GitHub account (`userData/github-account.json`): `{ version: 1, login, name, scopes, token }`,
 * where `token` is the base64 of the OS-encrypted token (Electron's `safeStorage` in the app). The
 * token is never stored in plain text: without OS encryption, saving refuses with
 * `secure_storage_unavailable`. The plain token is never cached: `getToken` decrypts on every call, and
 * `getAccount` decrypts once per loaded file only to check the account is usable here (a file whose
 * token cannot be decrypted is signed out).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { GithubError } from './errors'

/** OS encryption; in the app, Electron's `safeStorage`. */
export interface AccountCrypto {
  isAvailable(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

/** The filesystem surface the store uses; tests inject faults through it. */
export interface AccountFs {
  readFile(path: string): string
  writeFile(path: string, data: string): void
  rename(from: string, to: string): void
  mkdirp(path: string): void
  /** Deletes the file; a missing file is fine. */
  remove(path: string): void
}

/** What main keeps of the account; `scopes` is GitHub's `X-OAuth-Scopes` header value. */
export interface GithubAccount {
  login: string
  name: string | null
  scopes: string
}

export interface AccountStore {
  canEncrypt(): boolean
  /** The stored account, or null when there is none or its token cannot be decrypted here (then it is unusable). */
  getAccount(): GithubAccount | null
  /** Main-only: the decrypted token, or null when signed out or it cannot be decrypted. */
  getToken(): string | null
  /** Encrypts and stores the account atomically; throws `secure_storage_unavailable` without OS encryption. */
  save(account: GithubAccount, token: string): void
  /** Deletes the account file. */
  signOut(): void
}

const FILE_VERSION = 1

const accountFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  login: z.string().min(1),
  name: z.string().nullable(),
  scopes: z.string(),
  token: z.string().min(1)
})

type AccountFile = z.infer<typeof accountFileSchema>

const nodeAccountFs: AccountFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  // Owner-only: the token is encrypted, but the file is nobody else's business either.
  writeFile: (path, data) => writeFileSync(path, data, { encoding: 'utf8', mode: 0o600 }),
  rename: renameSync,
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true })
  },
  remove: (path) => rmSync(path, { force: true })
}

/** A missing, unreadable or corrupt file is no account; loading never throws. */
function load(fs: AccountFs, file: string): AccountFile | null {
  try {
    const parsed = accountFileSchema.safeParse(JSON.parse(fs.readFile(file)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The stored token in plain text, or null when OS encryption is unavailable or it cannot be decrypted. */
function decryptToken(crypto: AccountCrypto, record: AccountFile): string | null {
  if (!crypto.isAvailable()) {
    return null
  }
  try {
    return crypto.decrypt(Buffer.from(record.token, 'base64'))
  } catch {
    return null
  }
}

export function createAccountStore(options: { file: string; crypto: AccountCrypto; fs?: AccountFs }): AccountStore {
  const { file, crypto } = options
  const temp = `${file}.tmp`
  const fs = options.fs ?? nodeAccountFs
  let stored: AccountFile | null | undefined
  /** Whether the stored token decrypts, checked once per loaded record; the plain token is never kept. */
  let decryptable: boolean | undefined

  const current = (): AccountFile | null => {
    stored ??= load(fs, file)
    return stored
  }

  return {
    canEncrypt: () => crypto.isAvailable(),
    getAccount: () => {
      const record = current()
      if (record === null || !crypto.isAvailable()) {
        return null
      }
      decryptable ??= decryptToken(crypto, record) !== null
      return decryptable ? { login: record.login, name: record.name, scopes: record.scopes } : null
    },
    getToken: () => {
      const record = current()
      return record === null ? null : decryptToken(crypto, record)
    },
    save: (account, token) => {
      if (!crypto.isAvailable()) {
        throw new GithubError('secure_storage_unavailable')
      }
      const next: AccountFile = { version: FILE_VERSION, login: account.login, name: account.name, scopes: account.scopes, token: crypto.encrypt(token).toString('base64') }
      fs.mkdirp(dirname(file))
      fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`)
      fs.rename(temp, file)
      stored = next
      decryptable = true
    },
    signOut: () => {
      fs.remove(file)
      fs.remove(temp)
      stored = null
      decryptable = undefined
    }
  }
}
