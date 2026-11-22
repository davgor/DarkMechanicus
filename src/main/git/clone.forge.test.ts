import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneRig } from '../../test/cloneRig'
import { isolateGitConfig, useRemoteRepos } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { forgeWorldAt } from '../desktop/forgeContext'
import { createForge } from '../desktop/forgeManifest'

const cleanups: Array<() => void> = []
const remotes = useRemoteRepos()
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => { vi.unstubAllEnvs(); while (cleanups.length) cleanups.pop()?.() })

async function validateWorld(path: string): Promise<string> {
  if (!forgeWorldAt(path)) throw new Error('Choose a Forge World repository containing forge-world.json.')
  return path
}

describe('Forge-only clone mode', () => {
  it('validates a real cloned world before registering it and never routes it through ordinary project opening', async () => {
    const { local, bare } = remotes(cleanups)
    createForge(local.root, 'example')
    local.git('add', 'forge-world.json')
    local.git('commit', '-m', 'World manifest')
    local.git('push', 'origin', 'HEAD')
    const validated: string[] = []
    const rig = cloneRig(cleanups, {
      openWorld: async path => { const root = await validateWorld(path); validated.push(root); return root },
      openProject: async () => { throw new Error('Ordinary project path must not be used') },
      track: path => expect(validated).toEqual([path])
    })
    await rig.cloner.chooseParent()
    const result = await rig.cloner.clone({ operationId: 'world', url: pathToFileURL(bare).href, name: 'World', mode: 'forge-world' })
    expect(result.path).toBe(join(rig.parent, 'World'))
    expect(rig.tracked).toEqual([result.path])
  })

  it('rejects an ordinary code clone with a link config, cleans only a newly owned target, and tracks nothing', async () => {
    const { local, bare } = remotes(cleanups)
    put(local.root, '.forge-world.json', JSON.stringify({ version: 1, worldRepository: 'https://github.com/example/world.git', projectFolder: 'Code' }))
    local.git('add', '.forge-world.json')
    local.git('commit', '-m', 'Code project link')
    local.git('push', 'origin', 'HEAD')
    const rig = cloneRig(cleanups, { openWorld: validateWorld })
    await rig.cloner.chooseParent()
    await expect(rig.cloner.clone({ operationId: 'new', url: pathToFileURL(bare).href, name: 'new', mode: 'forge-world' })).rejects.toThrow('Choose a Forge World')
    expect(existsSync(join(rig.parent, 'new'))).toBe(false)
    mkdirSync(join(rig.parent, 'existing'))
    await expect(rig.cloner.clone({ operationId: 'old', url: pathToFileURL(bare).href, name: 'existing', mode: 'forge-world' })).rejects.toThrow('Choose a Forge World')
    expect(existsSync(join(rig.parent, 'existing', '.forge-world.json'))).toBe(true)
    expect(rig.tracked).toEqual([])
  })
})
