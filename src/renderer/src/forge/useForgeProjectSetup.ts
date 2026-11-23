import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ForgeSetupApi, ForgeSetupProjectView } from '../../../shared/desktop/forgeSetup'
import { errorMessage } from '../api/dm'
import type { Scheduler } from '../app/scheduler'

function useProjectRead({ api, member, scheduler, load, fence, working, onRead, onError }: {
  api: ForgeSetupApi; member: string; scheduler: Scheduler; load: number; fence: RefObject<number>
  working: RefObject<boolean>; onRead(value: ForgeSetupProjectView): void; onError(error: string | null): void
}): void {
  useEffect(() => {
    let live = true
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending || working.current) return
      const version = fence.current
      const current = (): boolean => live && version === fence.current
      pending = true
      try {
        const record = await api.project(member)
        if (current()) { onRead(record); onError(null) }
      } catch (failure) {
        if (current()) onError(errorMessage(failure))
      } finally {
        pending = false
      }
    }
    void refresh()
    const stop = scheduler.every(5000, () => void refresh())
    return () => { live = false; stop() }
  }, [api, member, scheduler, load, fence, working, onRead, onError])
}

export function useForgeProjectSetup(api: ForgeSetupApi, member: string, scheduler: Scheduler) {
  const [view, setView] = useState<ForgeSetupProjectView | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [load, setLoad] = useState(0)
  const mounted = useRef(false)
  const generation = useRef(0)
  const working = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useProjectRead({ api, member, scheduler, load, fence: generation, working, onRead: setView, onError: setReadError })

  async function act<T>(work: () => Promise<T>, apply: (answer: T) => void): Promise<T | undefined> {
    if (working.current) return undefined
    working.current = true
    generation.current += 1
    setBusy(true)
    setError(null)
    try {
      const result = await work()
      if (!mounted.current) return undefined
      apply(result)
      return result
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure))
      return undefined
    } finally {
      working.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return { view, setView, readError, error, busy, act, reload: () => setLoad(n => n + 1) }
}
