import { contentHash } from '../canonical'
import type { Db } from '../db/database'
import { getMeta, META_KEYS, setMeta } from '../meta'

const CLEAN_RECONCILE = contentHash({ conflicts: [], profileConflicts: [], kanbanConflicts: [], rejected: [] })

function hasLegacyCleanReconcile(db: Db): boolean {
  const problems = getMeta(db, META_KEYS.reconcileProblems)
  if (problems === null) return false
  if (problems === CLEAN_RECONCILE) return true
  // A previous version may have seen new problems after a successful import. Use the existing
  // (epic_id, seq) index to bound that search. A clean event is stronger proof than sync_state,
  // where a first, partially rejected reconcile can still have imported some valid records.
  return db.get(`
    SELECT 1 FROM (
      SELECT kind, payload_json FROM events WHERE epic_id IS NULL ORDER BY seq DESC LIMIT 256
    ) WHERE CASE WHEN kind = 'repository.reconciled' AND json_valid(payload_json) THEN
      json_type(payload_json, '$.conflicts') = 'integer' AND json_extract(payload_json, '$.conflicts') = 0 AND
      json_type(payload_json, '$.rejected') = 'integer' AND json_extract(payload_json, '$.rejected') = 0
    ELSE 0 END LIMIT 1
  `) !== undefined
}

/** Machine-local proof that this database already held a clean portable import. */
export function hasValidatedRepositoryCache(db: Db): boolean {
  return getMeta(db, META_KEYS.validatedRepositoryCache) === '1' || hasLegacyCleanReconcile(db)
}

/** Inside the import transaction, preserve the prior proof before the latest problem digest is replaced. */
export function rememberValidatedRepositoryCache(db: Db, clean: boolean): void {
  if (getMeta(db, META_KEYS.validatedRepositoryCache) === '1') return
  if (clean || hasLegacyCleanReconcile(db)) {
    setMeta(db, META_KEYS.validatedRepositoryCache, '1')
  }
}
