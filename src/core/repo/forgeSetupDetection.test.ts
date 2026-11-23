import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { discoverForgeSetup, type ForgeSetupDescriptorReader, type ForgeSetupTreeEntry } from './forgeSetupDetection'

const repository = 'https://github.com/example/software.git'
const commit = 'a'.repeat(40)
const treeSha = 'b'.repeat(40)

function blobSha(bytes: Uint8Array): string {
  return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
}

function fixture(files: Record<string, string>, extra: ForgeSetupTreeEntry[] = []) {
  const calls: string[] = []
  const blobs = new Map<string, Uint8Array>()
  const entries: ForgeSetupTreeEntry[] = [...extra]
  for (const [path, text] of Object.entries(files)) {
    const bytes = Buffer.from(text)
    const sha = blobSha(bytes)
    entries.push({ path, mode: '100644', type: 'blob', sha, size: bytes.length })
    blobs.set(sha, bytes)
  }
  const reader: ForgeSetupDescriptorReader = {
    async head(remote) { calls.push('head ' + remote); return { commit, tree: treeSha } },
    async tree(remote, sha) { calls.push('tree ' + remote + ' ' + sha); return { entries, truncated: false } },
    async blob(remote, sha) { calls.push('blob ' + remote + ' ' + sha); return blobs.get(sha)! }
  }
  return { reader, calls }
}

it('pins one tree and only reads bounded Node or Electron descriptor bodies', async () => {
  const pkg = JSON.stringify({ name: 'demo', engines: { node: '>=22.12' }, packageManager: 'npm@11.0.0',
    devDependencies: { electron: '^42.0.0' }, scripts: { build: 'SECRET=this-must-not-travel vite', test: 'vitest' } })
  const files = { 'package.json': pkg, '.nvmrc': '22\n', 'package-lock.json': 'do not read', '.env': 'SECRET=no', 'docs/setup.md': 'do not read' }
  const { reader, calls } = fixture(files)
  const result = await discoverForgeSetup(repository, reader)
  expect(result).toMatchObject({ status: 'detected', source: { repository, commit }, facts: expect.arrayContaining([
    { kind: 'node', value: '>=22.12', source: 'package.json' },
    { kind: 'node', value: '22', source: '.nvmrc' },
    { kind: 'package-manager', value: 'npm@11.0.0', source: 'package.json' },
    { kind: 'electron', value: '^42.0.0', source: 'package.json' },
    { kind: 'script', value: 'build', source: 'package.json' },
    { kind: 'lockfile', value: 'npm', source: 'package-lock.json' }
  ]) })
  expect(JSON.stringify(result)).not.toContain('this-must-not-travel')
  expect(calls).toEqual([
    'head ' + repository, 'tree ' + repository + ' ' + treeSha,
    'blob ' + repository + ' ' + blobSha(Buffer.from(pkg)),
    'blob ' + repository + ' ' + blobSha(Buffer.from('22\n'))
  ])
})

it('reports unsupported, offline and competing lock evidence without claiming setup is complete', async () => {
  await expect(discoverForgeSetup(repository, fixture({ 'pyproject.toml': 'other stack' }).reader)).resolves.toMatchObject({
    status: 'unsupported', reason: 'no-node-manifest', facts: []
  })
  const { reader } = fixture({})
  reader.head = async () => null
  await expect(discoverForgeSetup(repository, reader)).resolves.toMatchObject({ status: 'unavailable', reason: 'source-unavailable', source: null })
  const locks = fixture({ 'package.json': '{}', 'pnpm-lock.yaml': 'one', 'yarn.lock': 'another' })
  await expect(discoverForgeSetup(repository, locks.reader)).resolves.toMatchObject({ status: 'ambiguous', reason: 'conflicting-requirements' })
  expect(locks.calls).toHaveLength(3)
})

it('keeps an oversized numeric package-manager version out of portable facts', async () => {
  const manifest = JSON.stringify({ packageManager: 'npm@' + '1'.repeat(120) + '.1.1' })
  const { reader } = fixture({ 'package.json': manifest, 'package-lock.json': 'lock body is ignored' })
  await expect(discoverForgeSetup(repository, reader)).resolves.toMatchObject({
    status: 'ambiguous', reason: 'conflicting-requirements', source: { repository, commit },
    facts: [{ kind: 'lockfile', value: 'npm', source: 'package-lock.json' }]
  })
})

it.each([
  { mode: '120000', type: 'blob', size: 12, reason: 'invalid-descriptor' },
  { mode: '160000', type: 'commit', size: 12, reason: 'invalid-descriptor' },
  { mode: '100644', type: 'blob', size: 999_999, reason: 'descriptor-limits' }
])('refuses a $mode descriptor before requesting its blob', async ({ mode, type, size, reason }) => {
  const { reader, calls } = fixture({}, [{ path: 'package.json', mode, type, size, sha: 'c'.repeat(40) }])
  await expect(discoverForgeSetup(repository, reader)).resolves.toMatchObject({ status: 'unavailable', reason, facts: [] })
  expect(calls).toHaveLength(2)
})

it('refuses truncated and hash-inconsistent snapshots', async () => {
  const truncated = fixture({ 'package.json': '{}' })
  truncated.reader.tree = async () => ({ truncated: true, entries: [] })
  await expect(discoverForgeSetup(repository, truncated.reader)).resolves.toMatchObject({ reason: 'descriptor-limits', facts: [] })
  const forged = fixture({ 'package.json': '{}' })
  forged.reader.blob = async () => Buffer.from('[]')
  await expect(discoverForgeSetup(repository, forged.reader)).resolves.toMatchObject({ reason: 'invalid-descriptor', facts: [] })
})
