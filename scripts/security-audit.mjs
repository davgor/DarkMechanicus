/**
 * Apply the repository's narrow npm audit policy.
 *
 * GHSA-fc5q-39xc-vjpf affects every currently published picomatch version
 * (<=4.0.7), so upgrading or overriding cannot remove it yet. The installed
 * paths are development/build/test tooling; `npm audit --omit=dev` is clean.
 * Remove this exception as soon as a patched picomatch release is available
 * and package-lock.json has been upgraded to that release.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BLOCKED_SEVERITIES = new Set(['moderate', 'high', 'critical'])

export const AUDIT_POLICY = Object.freeze({
  advisory: 'GHSA-fc5q-39xc-vjpf',
  exposure:
    'The affected dependency paths are development-only build, test, packaging, and dead-code tooling.',
  rationale:
    'All published picomatch versions are affected and GitHub lists no patched version, so no safe upgrade or override is currently available.',
  removalCondition:
    'Remove this exception when a patched picomatch release is published and the lockfile (package-lock.json) is upgraded to that release.'
})

/** @param {unknown} value */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} advisory */
function advisoryId(advisory) {
  if (!isObject(advisory) || typeof advisory.url !== 'string') return null
  const match = /\/advisories\/(GHSA-[\w-]+)\/?$/.exec(advisory.url)
  return match?.[1] ?? null
}

/**
 * Find every root advisory reachable through npm's transitive `via` graph.
 * Missing references and chains with no advisory are deliberately unresolved.
 *
 * @param {string} start
 * @param {Record<string, unknown>} vulnerabilities
 */
function traceAdvisories(start, vulnerabilities) {
  const advisories = new Set()
  const visited = new Set()
  let unresolved = false

  /** @param {string} packageName */
  function visit(packageName) {
    if (visited.has(packageName)) return
    visited.add(packageName)

    const vulnerability = vulnerabilities[packageName]
    if (!isObject(vulnerability) || !Array.isArray(vulnerability.via)) {
      unresolved = true
      return
    }

    for (const cause of vulnerability.via) {
      if (typeof cause === 'string') {
        if (!(cause in vulnerabilities)) {
          unresolved = true
        } else {
          visit(cause)
        }
        continue
      }

      const id = advisoryId(cause)
      if (id === null) {
        unresolved = true
      } else {
        advisories.add(id)
      }
    }
  }

  visit(start)
  if (advisories.size === 0) unresolved = true
  return { advisories, unresolved }
}

/**
 * Split moderate-or-higher findings into the documented exception and findings
 * that must still fail CI.
 *
 * @param {unknown} audit
 */
export function evaluateAudit(audit) {
  const vulnerabilities =
    isObject(audit) && isObject(audit.vulnerabilities) ? audit.vulnerabilities : {}
  const allowed = []
  const blocked = []

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    if (
      !isObject(vulnerability) ||
      typeof vulnerability.severity !== 'string' ||
      !BLOCKED_SEVERITIES.has(vulnerability.severity)
    ) {
      continue
    }

    const trace = traceAdvisories(packageName, vulnerabilities)
    if (
      !trace.unresolved &&
      trace.advisories.size === 1 &&
      trace.advisories.has(AUDIT_POLICY.advisory)
    ) {
      allowed.push(packageName)
    } else {
      blocked.push(packageName)
    }
  }

  allowed.sort()
  blocked.sort()
  return { allowed, blocked }
}

/** @param {string | undefined} inputPath */
function loadAudit(inputPath) {
  let source
  let errorDetail = 'npm audit did not return JSON'

  if (inputPath) {
    source = readFileSync(inputPath, 'utf8')
    errorDetail = `Audit input is not valid JSON: ${inputPath}`
  } else {
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
    const args =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npm audit --json --audit-level=moderate']
        : ['audit', '--json', '--audit-level=moderate']
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.error) throw result.error
    source = result.stdout
    errorDetail = result.stderr?.trim() || errorDetail
  }

  try {
    return JSON.parse(source)
  } catch {
    throw new Error(errorDetail)
  }
}

function main() {
  const audit = loadAudit(process.argv[2])

  const { allowed, blocked } = evaluateAudit(audit)
  if (allowed.length > 0) {
    console.log(`Documented exception (${AUDIT_POLICY.advisory}):`)
    for (const packageName of allowed) console.log(`- ${packageName}`)
    console.log(`Rationale: ${AUDIT_POLICY.rationale}`)
    console.log(`Exposure: ${AUDIT_POLICY.exposure}`)
    console.log(`Removal condition: ${AUDIT_POLICY.removalCondition}`)
  }

  if (blocked.length > 0) {
    console.error('\nUnallowlisted moderate-or-higher vulnerabilities:')
    for (const packageName of blocked) console.error(`- ${packageName}`)
    process.exitCode = 1
    return
  }

  console.log('\nNo unallowlisted moderate-or-higher vulnerabilities found.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}