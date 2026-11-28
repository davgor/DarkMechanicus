import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { BrowserApi } from '../../../shared/browser/browserApi'
import { Icon } from '../components/Icon'

const EMPTY_TEXT = 'No sites are always allowed yet. Choose Always allow on a site prompt to add one.'

/** Closes the popover on Escape (focus back on its button) or a press outside it, only while it is open. */
function useDismiss(open: boolean, anchor: RefObject<HTMLElement>, close: () => void): void {
  useEffect(() => {
    if (!open) return undefined
    const onPress = (event: MouseEvent): void => {
      if (!(event.target instanceof Node && anchor.current?.contains(event.target))) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      close()
      anchor.current?.querySelector<HTMLElement>('.bp-sites-trigger')?.focus()
    }
    document.addEventListener('mousedown', onPress)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPress)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, anchor, close])
}

/**
 * The Browser panel's Sites button and popover: the folder's always-allowed origins from `browser.sites`, each with
 * Remove (`browser.removeSite`). The list is read again each time it opens. The panel hides the native view while it
 * is open, since the popover drops over the page area.
 */
export function SitesPopover({ folder, api, open, onOpenChange }: {
  folder: string | null
  api: BrowserApi
  open: boolean
  onOpenChange(open: boolean): void
}): JSX.Element {
  const anchor = useRef<HTMLDivElement>(null)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  useDismiss(open, anchor, close)
  return (
    <div className="bp-sites" ref={anchor}>
      <button type="button" className="btn btn-ghost btn-sm bp-sites-trigger" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => onOpenChange(!open)}>
        <Icon name="globe" />
        Sites
      </button>
      {open && <SitesList folder={folder} api={api} />}
    </div>
  )
}

function SitesList({ folder, api }: { folder: string | null; api: BrowserApi }): JSX.Element {
  const [sites, setSites] = useState<readonly string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void api.sites({ folder }).then((result) => {
      if (!alive.current) return
      if (result.ok) setSites(result.data)
      else setError(result.error.message)
    })
    return () => { alive.current = false }
  }, [api, folder])

  async function remove(origin: string): Promise<void> {
    setRemoving(origin)
    setError(null)
    const result = await api.removeSite({ folder, origin })
    if (!alive.current) return
    setRemoving(null)
    if (result.ok) setSites((list) => list?.filter((site) => site !== origin) ?? null)
    else setError(result.error.message)
  }

  return (
    <div className="bp-sites-popover" role="dialog" aria-label="Always-allowed sites">
      <p className="bp-sites-title">Always allowed in this folder</p>
      {error !== null && <p className="bp-error" role="alert">{error}</p>}
      {sites === null
        ? error === null && <p className="bp-sites-note">Loading…</p>
        : sites.length === 0
          ? <p className="bp-sites-note">{EMPTY_TEXT}</p>
          : <ul className="bp-sites-list" aria-label="Always-allowed sites">
            {sites.map((origin) => (
              <li key={origin} className="bp-sites-row">
                <span className="bp-sites-origin" title={origin}>{origin}</span>
                <button type="button" className="btn btn-sm" aria-label={`Remove ${origin}`} disabled={removing !== null}
                  onClick={() => { void remove(origin) }}>Remove</button>
              </li>
            ))}
          </ul>}
    </div>
  )
}
