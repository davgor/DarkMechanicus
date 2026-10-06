import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileChange } from '../../../shared/git/status'

/** How much of a file a commit takes. `partial` is reserved for choosing single lines; nothing sets it yet. */
type Inclusion = 'all' | 'none' | 'partial'

/** What the header checkbox shows: every file, some of them, or none. */
type HeaderInclusion = 'all' | 'some' | 'none'

export interface InclusionModel {
  /** Whether (and how much of) a file is included. Files not seen before are `all`. */
  of(path: string): Inclusion
  toggle(path: string): void
  /** Includes every file when not all are included, otherwise none. */
  toggleAll(): void
  header: HeaderInclusion
  /** The files a commit would take: everything not `none`. */
  included: FileChange[]
}

interface Stored {
  folder: string
  /** Only the files that deviate from the default (`all`). */
  overrides: ReadonlyMap<string, Inclusion>
}

/** Inclusion of the changed files of one folder, by path. It survives status refreshes and drops files that disappear. */
export function useInclusion(folder: string, files: readonly FileChange[]): InclusionModel {
  const [stored, setStored] = useState<Stored>({ folder, overrides: new Map() })
  const overrides = stored.folder === folder ? stored.overrides : new Map<string, Inclusion>()

  useEffect(() => {
    const present = new Set(files.map((file) => file.path))
    setStored((previous) => {
      const kept = [...previous.overrides].filter(([path]) => present.has(path))
      if (previous.folder === folder && kept.length === previous.overrides.size) {
        return previous
      }
      return { folder, overrides: previous.folder === folder ? new Map(kept) : new Map() }
    })
  }, [folder, files])

  const of = useCallback((path: string): Inclusion => overrides.get(path) ?? 'all', [overrides])

  const set = useCallback(
    (change: (previous: ReadonlyMap<string, Inclusion>) => Map<string, Inclusion>) => {
      setStored((previous) => ({ folder, overrides: change(previous.folder === folder ? previous.overrides : new Map()) }))
    },
    [folder]
  )

  const toggle = useCallback(
    (path: string) =>
      set((previous) => {
        const next = new Map(previous)
        if ((previous.get(path) ?? 'all') === 'none') {
          next.delete(path)
        } else {
          next.set(path, 'none')
        }
        return next
      }),
    [set]
  )

  return useMemo(() => {
    const included = files.filter((file) => (overrides.get(file.path) ?? 'all') !== 'none')
    const header: HeaderInclusion = included.length === files.length ? 'all' : included.length === 0 ? 'none' : 'some'
    const toggleAll = (): void =>
      set(() => (header === 'all' ? new Map(files.map((file) => [file.path, 'none' as const])) : new Map()))
    return { of, toggle, toggleAll, header: files.length === 0 ? 'none' : header, included }
  }, [files, overrides, of, toggle, set])
}
