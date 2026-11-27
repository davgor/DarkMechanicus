import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { browserScheduler, type Scheduler } from '../app/scheduler'

/** Where Copy writes and what times its "Copied" feedback; tests provide a fake of each. */
export interface CopyTarget {
  writeText(text: string): Promise<void>
  scheduler: Scheduler
}

export const CopyContext = createContext<CopyTarget>({
  writeText: (text) => navigator.clipboard.writeText(text),
  scheduler: browserScheduler
})

/** How long "Copied" shows before the button reads "Copy" again. */
export const COPIED_MS = 1_500

type CopyState = 'idle' | 'copied' | 'failed'

const LABELS: Record<CopyState, string> = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' }

interface CopyButtonProps {
  /** Exactly what lands on the clipboard: a message's stored Markdown, or a code block's code. */
  text: string
  /** What the button copies, as its tooltip: "Copy message", "Copy code". */
  title: string
  className?: string
}

/** Copies `text`, then says so in place: "Copied" for 1.5 s, or "Copy failed" until the next try. Never throws. */
export function CopyButton({ text, title, className }: CopyButtonProps): JSX.Element {
  const { writeText, scheduler } = useContext(CopyContext)
  const [state, setState] = useState<CopyState>('idle')
  const cancel = useRef<(() => void) | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancel.current?.()
    }
  }, [])

  const copy = (): void => {
    cancel.current?.()
    cancel.current = null
    void Promise.resolve()
      .then(() => writeText(text))
      .then(
        () => {
          if (!mounted.current) return
          setState('copied')
          cancel.current = scheduler.after(COPIED_MS, () => {
            cancel.current = null
            setState('idle')
          })
        },
        () => {
          if (mounted.current) setState('failed')
        }
      )
  }

  return (
    <button type="button" className={className ? `copy-button ${className}` : 'copy-button'} data-state={state} title={title} onClick={copy}>
      <span aria-live="polite">{LABELS[state]}</span>
    </button>
  )
}
