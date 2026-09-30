import type { Toast, ToastTone } from '../app/toastState'
import { Button } from './Button'
import { Icon } from './Icon'

const TONE_LABEL: Record<ToastTone, string> = {
  error: 'Error',
  success: 'Success',
  info: 'Notice'
}

interface ToastViewportProps {
  toasts: readonly Toast[]
  onDismiss(id: number): void
}

/** Errors are announced as alerts; everything else politely. The tone is spelled out in text. */
export function ToastViewport({ toasts, onDismiss }: ToastViewportProps): JSX.Element {
  return (
    <div className="toast-viewport">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
        >
          <Icon name={toast.tone === 'error' ? 'warning' : 'check'} />
          <span className="toast-message">
            <span className="sr-only">{TONE_LABEL[toast.tone]}: </span>
            {toast.message}
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon="close"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(toast.id)}
          />
        </div>
      ))}
    </div>
  )
}
