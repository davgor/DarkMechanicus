/**
 * Themed cultist names ("Magos Vettius", "Acolyte Ferrum-7"), deterministic from a seed and never one already
 * taken in the run (compared case-insensitively, as the store does). Pure, shared with the renderer.
 */

type CultistRole = 'magos' | 'acolyte'

const MAGOS_NAMES = [
  'Vettius', 'Cawl', 'Dominus', 'Severax', 'Orthan', 'Lucan', 'Tharsis', 'Varro', 'Hesper', 'Corvane',
  'Mordax', 'Septimus', 'Arkhan', 'Velix', 'Quintus', 'Belisar'
] as const

const ACOLYTE_STEMS = [
  'Ferrum', 'Cogitas', 'Aurum', 'Plumbum', 'Vox', 'Stannum', 'Cuprum', 'Argent', 'Noctis', 'Fulgur', 'Ignis', 'Ordo'
] as const

/** A small, stable string hash (FNV-1a) so the same seed always starts at the same name. */
function seedIndex(seed: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** The n-th candidate of a role's endless, repeat-free sequence: one round through the names, then the next round. */
function candidate(role: CultistRole, start: number, n: number): string {
  const names = role === 'magos' ? MAGOS_NAMES : ACOLYTE_STEMS
  const name = names[(start + n) % names.length]
  const round = Math.floor(n / names.length)
  if (role === 'magos') return round === 0 ? `Magos ${name}` : `Magos ${name} ${round + 1}`
  return `Acolyte ${name}-${(start % 9) + 1 + round}`
}

/** A name for a new member of `role` that is not in `taken`; the same seed and taken names give the same name. */
export function cultistName(taken: Iterable<string>, role: CultistRole, seed = ''): string {
  const used = new Set(Array.from(taken, (name) => name.trim().toLowerCase()))
  const start = seedIndex(`${role}:${seed}`)
  for (let n = 0; ; n++) {
    const name = candidate(role, start, n)
    if (!used.has(name.toLowerCase())) return name
  }
}
