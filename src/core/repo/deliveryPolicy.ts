import { storedDeliveryPolicy } from '../deliveryPolicySchema'
import type { DeliveryPolicy, StoredDeliveryPolicy } from '../../shared/domain/deliveryPolicy'
import { prettyJson } from '../canonical'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { getMeta, META_KEYS, setMeta } from '../meta'
import { writeFileSafely } from './finalizer'
import { readProject } from './initialize'
import type { ProjectRecord } from './portable'
import type { FsAdapter, RepoLayout } from './types'

export function policyForStore(layout: RepoLayout, db: Db, project: ProjectRecord): StoredDeliveryPolicy | undefined {
  if (layout.mode === 'repo') return project.deliveryStandards
  const value = getMeta(db, META_KEYS.deliveryStandards)
  return value === null ? undefined : storedDeliveryPolicy.parse(JSON.parse(value))
}

/** Called with the workspace database write lock held, including for portable writes. */
export function savePolicy(env: { layout: RepoLayout; fs: FsAdapter }, db: Db, expected: number, policy: DeliveryPolicy): StoredDeliveryPolicy {
  const project = readProject(env.layout, env.fs) ?? fail('not_initialized', 'Initialize the project before saving standards.')
  const current = policyForStore(env.layout, db, project)
  if ((current?.revision ?? 0) !== expected) fail('conflict', 'Project standards changed. Reload and review before saving.')
  if (current && prettyJson(current.policy) === prettyJson(policy)) return current
  const next = storedDeliveryPolicy.parse({ revision: expected + 1, policy })
  if (env.layout.mode === 'db') setMeta(db, META_KEYS.deliveryStandards, prettyJson(next))
  else writeFileSafely(env, env.layout.projectFile, prettyJson({ ...project, deliveryStandards: next }))
  return next
}
