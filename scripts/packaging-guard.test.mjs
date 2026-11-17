import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { linkedNodeModulesProblem } from './packaging-guard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = []

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'packaging-guard-'))
  scratch.push(root)
  return root
}

afterEach(() => {
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('linkedNodeModulesProblem', () => {
  it('lets a checkout with its own node_modules folder package', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'node_modules', 'zod'), { recursive: true })

    expect(linkedNodeModulesProblem(root)).toBeNull()
  })

  it('stops a checkout whose node_modules is a junction or symbolic link, naming the link, its target and the effect', () => {
    const shared = tempRoot()
    mkdirSync(join(shared, 'node_modules', 'zod'), { recursive: true })
    const root = tempRoot()
    // A junction on Windows; the type is ignored elsewhere, where this makes a directory symlink.
    symlinkSync(join(shared, 'node_modules'), join(root, 'node_modules'), 'junction')

    const problem = linkedNodeModulesProblem(root)

    expect(problem).toContain(join(root, 'node_modules'))
    expect(problem).toContain(join(shared, 'node_modules'))
    expect(problem).toContain('app.asar')
    expect(problem).toContain('npm ci')
  })

  it('leaves a checkout with no node_modules to electron-builder', () => {
    expect(linkedNodeModulesProblem(tempRoot())).toBeNull()
  })
})

describe('package scripts', () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts

  it('run the guard before electron-builder on Windows and macOS', () => {
    for (const name of ['package:win', 'package:mac']) {
      const script = scripts[name]
      const guardAt = script.indexOf('node scripts/packaging-guard.mjs &&')
      expect(guardAt, name).toBe(0)
      expect(script.indexOf('electron-builder'), name).toBeGreaterThan(guardAt)
    }
  })
})
