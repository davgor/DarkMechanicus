export type ToastTone = 'error' | 'success' | 'info'

export interface Toast {
  id: number
  tone: ToastTone
  message: string
}

export interface ToastState {
  toasts: readonly Toast[]
  nextId: number
}

export type ToastAction =
  | { type: 'push'; tone: ToastTone; message: string }
  | { type: 'dismiss'; id: number }

export const INITIAL_TOASTS: ToastState = { toasts: [], nextId: 1 }

export const MAX_TOASTS = 4

/** A repeat of a toast that is already visible is dropped, so a failing poll cannot flood the UI. */
export function toastReducer(state: ToastState, action: ToastAction): ToastState {
  if (action.type === 'dismiss') {
    return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) }
  }
  const repeated = state.toasts.some(
    (toast) => toast.tone === action.tone && toast.message === action.message
  )
  if (repeated) {
    return state
  }
  const added: Toast = { id: state.nextId, tone: action.tone, message: action.message }
  return { toasts: [...state.toasts, added].slice(-MAX_TOASTS), nextId: state.nextId + 1 }
}
