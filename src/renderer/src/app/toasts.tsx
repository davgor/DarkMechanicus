import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import type { Dispatch, ReactNode } from 'react'
import { errorMessage } from '../api/dm'
import { ToastViewport } from '../components/Toast'
import type { Scheduler } from './scheduler'
import { INITIAL_TOASTS, toastReducer } from './toastState'
import type { Toast, ToastAction, ToastTone } from './toastState'

interface ToastApi {
  push(tone: ToastTone, message: string): void
  /** Shows a command failure using its message. */
  reportError(error: unknown): void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToasts(): ToastApi {
  const api = useContext(ToastContext)
  if (api === null) {
    throw new Error('useToasts must be used inside a ToastProvider')
  }
  return api
}

const AUTO_DISMISS_MS: Record<ToastTone, number> = { error: 10_000, success: 4_000, info: 5_000 }

/** Schedules each toast's disappearance exactly once, however often the list re-renders. */
function useAutoDismiss(
  toasts: readonly Toast[],
  scheduler: Scheduler,
  dispatch: Dispatch<ToastAction>
): void {
  const scheduled = useRef(new Set<number>())
  useEffect(() => {
    for (const toast of toasts) {
      if (!scheduled.current.has(toast.id)) {
        scheduled.current.add(toast.id)
        scheduler.after(AUTO_DISMISS_MS[toast.tone], () => dispatch({ type: 'dismiss', id: toast.id }))
      }
    }
  }, [toasts, scheduler, dispatch])
}

interface ToastProviderProps {
  scheduler: Scheduler
  children: ReactNode
}

export function ToastProvider({ scheduler, children }: ToastProviderProps): JSX.Element {
  const [state, dispatch] = useReducer(toastReducer, INITIAL_TOASTS)
  useAutoDismiss(state.toasts, scheduler, dispatch)
  const api = useMemo<ToastApi>(
    () => ({
      push: (tone, message) => dispatch({ type: 'push', tone, message }),
      reportError: (error) => dispatch({ type: 'push', tone: 'error', message: errorMessage(error) })
    }),
    []
  )
  const dismiss = useCallback((id: number) => dispatch({ type: 'dismiss', id }), [])
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={state.toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}
