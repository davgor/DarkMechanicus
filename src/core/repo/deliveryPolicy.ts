import { join } from 'node:path'
import { z } from 'zod'
import { storedDeliveryPolicy } from '../deliveryPolicySchema'
import type { DeliveryPolicy, StoredDeliveryPolicy } from '../../shared/domain/deliveryPolicy'
import { effectivePrompts } from '../../shared/domain/standardsPrompts'
import { prettyJson } from '../canonical'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { getMeta, META_KEYS, setMeta } from '../meta'
import { writeFileSafely } from './finalizer'
import { readProject } from './initialize'
import { assertContained } from './paths'
import { readOwnedRecord, type ProjectRecord } from './portable'
import { SQLITE_STANDARDS_FILE } from './storageMode'
import type { FsAdapter, RepoLayout } from './types'

type PolicyEnv = { layout: RepoLayout; fs: FsAdapter }
const portableSettings = z.strictObject({
  format: z.literal('darkmechanicus.delivery-standards'),
  formatVersion: z.literal(1),
  standards: storedDeliveryPolicy
})

function sqliteSettings(env: PolicyEnv) {
  const layout = { ...env.layout, dmDir: env.layout.root, displayBase: env.layout.root }
  const file = join(layout.root, SQLITE_STANDARDS_FILE)
  assertContained(layout, env.fs, file)
  return { layout, file, fs: env.fs }
}

export function portablePolicy(env: PolicyEnv): StoredDeliveryPolicy | undefined {
  const { fs, layout, file } = sqliteSettings(env)
  return readOwnedRecord({ fs, layout }, portableSettings, file)?.standards
}

export function publishSqlitePolicy(env: PolicyEnv, policy: StoredDeliveryPolicy): void {
  const { file, layout, fs } = sqliteSettings(env)
  const existing = portablePolicy(env)
  if (existing && prettyJson(existing) === prettyJson(policy)) return
  writeFileSafely({ layout, fs }, file, prettyJson({
    format: 'darkmechanicus.delivery-standards', formatVersion: 1, standards: policy
  }))
}

/** A desktop upgrade makes a previously local-only policy portable, preserving its original revision and setup history. */
export function recoverSqlitePolicy(env: PolicyEnv, db: Db): void {
  if (env.layout.mode !== 'db' || getMeta(db, META_KEYS.deliveryStandards) === null || portablePolicy(env)) return
  db.tx(() => {
    if (portablePolicy(env)) return
    const value = getMeta(db, META_KEYS.deliveryStandards)
    if (value !== null) publishSqlitePolicy(env, storedDeliveryPolicy.parse(JSON.parse(value)))
  })
}

/** Called after the destination owns the policy. Never delete a concurrently modified record. */
export function retireSqlitePolicy(env: PolicyEnv, expected: StoredDeliveryPolicy | undefined): void {
  const existing = portablePolicy(env)
  if (!existing) return
  if (prettyJson(existing) !== prettyJson(expected)) fail('conflict', 'The portable SQLite standards changed during migration.')
  env.fs.remove(sqliteSettings(env).file)
}

export function policyForStore(layout: RepoLayout, db: Db, project: ProjectRecord, fs: FsAdapter): StoredDeliveryPolicy | undefined {
  if (layout.mode === 'repo') return project.deliveryStandards
  const portable = portablePolicy({ layout, fs })
  if (portable) return portable
  const value = getMeta(db, META_KEYS.deliveryStandards)
  return value === null ? undefined : storedDeliveryPolicy.parse(JSON.parse(value))
}

function approvedRevision(current: StoredDeliveryPolicy | undefined, expected: number, policy: DeliveryPolicy): StoredDeliveryPolicy {
  if (current?.policy.prompts && !policy.prompts) fail('conflict', 'Reload the four saved standards prompts before editing.')
  const approved = { ...policy, prompts: effectivePrompts(policy), setupDecision: policy.setupDecision ?? current?.policy.setupDecision ?? 'edited' }
  return current && prettyJson(current.policy) === prettyJson(approved)
    ? current : storedDeliveryPolicy.parse({ revision: expected + 1, policy: approved })
}

/** Called with the workspace database write lock held, including for portable writes. */
export function savePolicy(env: PolicyEnv, db: Db, expected: number, policy: DeliveryPolicy): StoredDeliveryPolicy {
  const project = readProject(env.layout, env.fs) ?? fail('not_initialized', 'Initialize the project before saving standards.')
  const current = policyForStore(env.layout, db, project, env.fs)
  if ((current?.revision ?? 0) !== expected) fail('conflict', 'Project standards changed. Reload and review before saving.')
  const next = approvedRevision(current, expected, policy)
  if (env.layout.mode === 'db') {
    publishSqlitePolicy(env, next)
    setMeta(db, META_KEYS.deliveryStandards, prettyJson(next))
  } else if (next !== current) {
    writeFileSafely(env, env.layout.projectFile, prettyJson({ ...project, deliveryStandards: next }))
  }
  return next
}
