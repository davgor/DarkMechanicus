import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { discoverForgeSetup, type ForgeSetupDescriptorReader, type ForgeSetupTreeEntry } from './forgeSetupDetection'

const repository = 'https://github.com/example/software.git'
const commit = 'a'.repeat(40)
const treeSha = 'b'.repeat(40)

function blobSha(bytes: Uint8Array, objectHash: 'sha1' | 'sha256' = 'sha1'): string {
  return createHash(objectHash).update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
}

function fixture(files: Record<string, string | Uint8Array>, extra: ForgeSetupTreeEntry[] = [], objectHash: 'sha1' | 'sha256' = 'sha1') {
  const calls: string[] = []
  const blobs = new Map<string, Uint8Array>()
  const entries: ForgeSetupTreeEntry[] = [...extra]
  for (const [path, text] of Object.entries(files)) {
    const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text
    const sha = blobSha(bytes, objectHash)
    entries.push({ path, mode: '100644', type: 'blob', sha, size: bytes.length })
    blobs.set(sha, bytes)
  }
  const reader: ForgeSetupDescriptorReader = {
    async head(remote) {
      calls.push('head ' + remote)
      return objectHash === 'sha1' ? { commit, tree: treeSha } : { commit: 'a'.repeat(64), tree: 'b'.repeat(64) }
    },
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
  { engine: '>=24', pin: '18', status: 'ambiguous' },
  { engine: '<22.10', pin: '22.10.0', status: 'ambiguous' },
  { engine: '>22', pin: '22', status: 'ambiguous' },
  { engine: '<=22.9', pin: '22.9.1', status: 'detected' },
  { engine: '24.1', pin: '24.2', status: 'ambiguous' },
  { engine: '>=22.12', pin: '22', status: 'detected' },
  { engine: '>=24', pin: 'lts/*', status: 'detected' },
  { engine: '>=24 || <20', pin: '18', status: 'detected' }
] as const)('retains $engine and $pin evidence without guessing pin overlap ($status)', async ({ engine, pin, status }) => {
  const { reader } = fixture({
    'package.json': JSON.stringify({ engines: { node: engine } }), '.nvmrc': pin + '\n'
  })
  const result = await discoverForgeSetup(repository, reader)
  expect(result).toMatchObject({ status, source: { repository, commit }, facts: [
    { kind: 'node', value: engine, source: 'package.json' }, { kind: 'node', value: pin, source: '.nvmrc' }
  ] })
  if (status === 'ambiguous') expect(result).toMatchObject({ reason: 'conflicting-requirements' })
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

it('accepts a pinned SHA-256 Git snapshot and carries only the Node line from tool versions', async () => {
  const toolVersions = 'ruby 3.4.1\n# Shared developer toolchain\nnodejs 22.12.1\npython 3.13.1\n'
  const { reader, calls } = fixture({ 'package.json': '{}', '.tool-versions': toolVersions }, [], 'sha256')
  await expect(discoverForgeSetup(repository, reader)).resolves.toEqual({
    detectorVersion: 1, status: 'detected', source: { repository, commit: 'a'.repeat(64) },
    facts: [{ kind: 'node', value: '22.12.1', source: '.tool-versions' }]
  })
  expect(calls).toContain('tree ' + repository + ' ' + 'b'.repeat(64))
  expect(calls).toContain('blob ' + repository + ' ' + blobSha(Buffer.from(toolVersions), 'sha256'))
})

it.each([
  { otherPath: '.tool-versions', versionFile: 'ruby 3.4.1\n', status: 'detected' },
  { otherPath: '.tool-versions', versionFile: 'nodejs 22.12.1\nnodejs 24.0.0\n', status: 'ambiguous' },
  { otherPath: '.node-version', versionFile: 'clearly-not-a-node-pin\n', status: 'ambiguous' },
  { otherPath: '.node-version', versionFile: '24.0.0\n', status: 'ambiguous' }
] as const)('keeps earlier Node facts when $otherPath contains $versionFile', async ({ otherPath, versionFile, status }) => {
  const { reader } = fixture({ 'package.json': '{}', '.nvmrc': '22.12.1\n', [otherPath]: versionFile })
  const result = await discoverForgeSetup(repository, reader)
  expect(result).toMatchObject({ status, source: { repository, commit }, facts: expect.arrayContaining([
    { kind: 'node', source: '.nvmrc', value: '22.12.1' }
  ]) })
  if (status === 'ambiguous') expect(result).toMatchObject({ reason: 'conflicting-requirements' })
  if (versionFile === '24.0.0\n') expect(result.facts).toContainEqual({ kind: 'node', source: otherPath, value: '24.0.0' })
  else expect(result.facts).toHaveLength(1)
})

it.each([
  { metadata: { engines: { node: 22 } }, facts: [] },
  { metadata: { packageManager: 'npm@file:local-tools' }, facts: [] },
  { metadata: { devDependencies: { electron: 'file:./wrapper' } }, facts: [] },
  { metadata: { peerDependencies: { electron: '^41.0.0' }, devDependencies: { electron: '^42.0.0' } }, facts: [] },
  { metadata: { packageManager: 'npm@11.1.0+sha224.' + 'd'.repeat(56) }, facts: [
    { kind: 'package-manager', source: 'package.json', value: 'npm@11.1.0' }
  ] }
])('rejects non-release or contradictory pins and omits package manager integrity from facts', async ({ metadata, facts }) => {
  const { reader } = fixture({ 'package.json': JSON.stringify(metadata), 'pnpm-lock.yaml': 'locked descriptor body' })
  await expect(discoverForgeSetup(repository, reader)).resolves.toEqual({
    detectorVersion: 1, status: 'ambiguous', reason: 'conflicting-requirements', source: { repository, commit },
    facts: [...facts, { kind: 'lockfile', source: 'pnpm-lock.yaml', value: 'pnpm' }]
  })
})

it.each([Buffer.from([0xc3, 0x28]), '[]', '{bad-json'])('does not publish partial facts from an invalid pinned manifest', async (manifest) => {
  const { reader } = fixture({ 'package.json': manifest, '.nvmrc': '22\n', 'package-lock.json': 'lock body' })
  await expect(discoverForgeSetup(repository, reader)).resolves.toEqual({
    detectorVersion: 1, status: 'unavailable', reason: 'invalid-descriptor', source: { repository, commit }, facts: []
  })
})

it('refuses invalid head identities before requesting a tree', async () => {
  const { reader } = fixture({ 'package.json': '{}' })
  reader.head = async () => ({ commit, tree: 'main' })
  reader.tree = async () => { throw new Error('Tree request should not be attempted') }
  await expect(discoverForgeSetup(repository, reader)).resolves.toMatchObject({
    status: 'unavailable', reason: 'invalid-descriptor', source: null, facts: []
  })
})

it('rejects missing descriptor sizes and enforces the total budget before reading any blob', async () => {
  const missingSize = fixture({}, [{ path: 'package.json', mode: '100644', type: 'blob', sha: 'c'.repeat(40) }])
  await expect(discoverForgeSetup(repository, missingSize.reader)).resolves.toMatchObject({
    status: 'unavailable', reason: 'invalid-descriptor', facts: []
  })
  const total = fixture({ 'package.json': ' '.repeat(64000), '.nvmrc': ' '.repeat(64000), '.node-version': ' '.repeat(4096) })
  await expect(discoverForgeSetup(repository, total.reader)).resolves.toMatchObject({
    status: 'unavailable', reason: 'descriptor-limits', facts: []
  })
  for (const candidate of [missingSize, total]) expect(candidate.calls.map(call => call.split(' ')[0])).toEqual(['head', 'tree'])
})
