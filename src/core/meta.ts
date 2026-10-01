import type { Db } from './db/database'

/** Keys of the local `meta` table (machine-local, never exported). */
export const META_KEYS = {
  projectId: 'project_id',
  projectName: 'project_name',
  keyPrefix: 'key_prefix',
  machineId: 'machine_id',
  /** Checkout branch recorded at the last reconcile; a different current branch means `branch_changed`. */
  checkoutBranch: 'checkout_branch',
  lastFlushAt: 'last_flush_at',
  lastReconcileAt: 'last_reconcile_at',
  /** Digest of the conflicts and rejections the last reconcile reported; repeating them records no event. */
  reconcileProblems: 'reconcile_problems'
} as const

type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS]

export function getMeta(db: Db, key: MetaKey): string | null {
  return db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null
}

/** Upserts a meta value; call inside a transaction when it belongs to a larger mutation. */
export function setMeta(db: Db, key: MetaKey, value: string): void {
  db.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value
  )
}
