import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluateAudit } from './security-audit.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkerPath = join(root, 'scripts/security-audit.mjs')

const allowedAdvisory = {
  source: 1_247_710,
  name: 'picomatch',
  dependency: 'picomatch',
  title: 'picomatch vulnerable to ReDoS through single-branch repeated extglobs',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  severity: 'high',
  range: '<=4.0.7'
}

function vulnerability(severity, via) {
  return {
    name: 'fixture',
    severity,
    via,
    effects: [],
    range: '*',
    nodes: []
  }
}

describe('evaluateAudit', () => {
  it('accepts and reports every transitive finding rooted only in the allowed picomatch advisory', () => {
    const audit = {
      vulnerabilities: {
        picomatch: vulnerability('high', [allowedAdvisory]),
        fdir: vulnerability('high', ['picomatch']),
        tinyglobby: vulnerability('high', ['fdir', 'picomatch']),
        vite: vulnerability('high', ['fdir', 'tinyglobby']),
        vitest: vulnerability('high', ['picomatch', 'tinyglobby'])
      }
    }

    expect(evaluateAudit(audit)).toEqual({
      allowed: ['fdir', 'picomatch', 'tinyglobby', 'vite', 'vitest'],
      blocked: []
    })
  })
})

describe('evaluateAudit unrelated advisories', () => {

  it.each(['moderate', 'high', 'critical'])(
    'blocks an unrelated %s advisory while retaining the allowed findings',
    (severity) => {
      const audit = {
        vulnerabilities: {
          picomatch: vulnerability('high', [allowedAdvisory]),
          fdir: vulnerability('high', ['picomatch']),
          unrelated: vulnerability(severity, [
            {
              name: 'unrelated',
              title: 'Unrelated vulnerability',
              url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
              severity
            }
          ])
        }
      }

      expect(evaluateAudit(audit)).toEqual({
        allowed: ['fdir', 'picomatch'],
        blocked: ['unrelated']
      })
    }
  )
})

describe('evaluateAudit mixed transitive chains', () => {

  it('blocks a transitive package when any vulnerability path reaches an unrelated advisory', () => {
    const audit = {
      vulnerabilities: {
        picomatch: vulnerability('high', [allowedAdvisory]),
        unrelated: vulnerability('high', [
          {
            name: 'unrelated',
            title: 'Unrelated vulnerability',
            url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
            severity: 'high'
          }
        ]),
        consumer: vulnerability('high', ['picomatch', 'unrelated'])
      }
    }

    expect(evaluateAudit(audit)).toEqual({
      allowed: ['picomatch'],
      blocked: ['consumer', 'unrelated']
    })
  })
})

describe('evaluateAudit unresolved chains', () => {

  it('blocks an unresolved vulnerability chain instead of silently accepting it', () => {
    const audit = {
      vulnerabilities: {
        orphan: vulnerability('high', ['missing-package'])
      }
    }

    expect(evaluateAudit(audit)).toEqual({
      allowed: [],
      blocked: ['orphan']
    })
  })
})

describe('security audit CLI', () => {
  it('exits nonzero for a synthetic unrelated moderate advisory', () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'dm-audit-'))
    const fixturePath = join(fixtureDirectory, 'audit.json')
    writeFileSync(
      fixturePath,
      JSON.stringify({
        vulnerabilities: {
          unrelated: vulnerability('moderate', [
            {
              name: 'unrelated',
              title: 'Unrelated vulnerability',
              url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
              severity: 'moderate'
            }
          ])
        }
      })
    )

    try {
      const result = spawnSync(process.execPath, [checkerPath, fixturePath], {
        encoding: 'utf8'
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Unallowlisted moderate-or-higher vulnerabilities:')
      expect(result.stderr).toContain('- unrelated')
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true })
    }
  })
})