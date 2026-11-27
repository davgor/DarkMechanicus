/**
 * The cult's Shrine (DM-632): the latest file a member published, sized by its container, live. The content is untrusted
 * and is only ever addressed as `dm-shrine://shrine/<run id>/<revision>` (main serves that run's recorded file, never a
 * path): an image or SVG as `<img>`, so an SVG's scripts never run; HTML in an `<iframe sandbox="allow-scripts">`
 * without `allow-same-origin`, so it has an opaque origin and reaches neither the app, its preload nor the top window,
 * and its CSP (from main) gives it no network. A new revision is a new address, so an edit of the file reloads the view.
 *
 * `compact` is the chamber viewscreen's mode: the content only, with a small Enlarge button. Enlarge opens a dialog with
 * the same sandboxed view, large, and the details (file, publisher, updated time).
 */
import { useState } from 'react'
import type { CultShrineView } from '../../../shared/cults/cultApi'
import { shrineUrl } from '../../../shared/cults/shrine'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import './shrine.css'

interface ShrinePanelProps {
  /** The run whose Shrine this is: the only thing the address names besides the revision. */
  runId: string
  /** The run snapshot's Shrine (`CultRunDetail.shrine`); null shows the empty state. */
  shrine: CultShrineView | null
  /** The viewscreen mode: content only, with a small Enlarge button. */
  compact?: boolean
  /** Told when the person opens the Enlarge dialog (the chamber may react to it). */
  onEnlarge?(): void
}

/** The file's own name; the rest of its path stays out of the view. */
const fileName = (path: string): string => path.split(/[\\/]/).pop()!

/** The untrusted content: an image as `img`, HTML only inside the scripts-only sandbox. Keyed by revision, so it reloads. */
function ShrineContent({ runId, shrine }: { runId: string; shrine: CultShrineView }): JSX.Element {
  const src = shrineUrl(runId, shrine.revision)
  const label = `Shrine: ${fileName(shrine.path)}`
  if (shrine.kind === 'image') return <img key={src} className="shrine-image" src={src} alt={label} draggable={false} />
  return <iframe key={src} className="shrine-frame" src={src} title={label} sandbox="allow-scripts" referrerPolicy="no-referrer" />
}

function ShrineDetails({ shrine }: { shrine: CultShrineView }): JSX.Element {
  return (
    <dl className="shrine-details">
      <dt>File</dt><dd className="mono">{fileName(shrine.path)}</dd>
      <dt>Published by</dt><dd>{shrine.publishedBy ?? 'Unknown member'}</dd>
      <dt>Updated</dt><dd><time dateTime={shrine.updatedAt}>{new Date(shrine.updatedAt).toLocaleTimeString()}</time></dd>
    </dl>
  )
}

/** Before any publish; the viewscreen is too small for more than the two words. */
function EmptyShrine({ compact }: { compact: boolean }): JSX.Element {
  return (
    <div className="shrine-empty" role="status">
      {compact ? null : <span className="shrine-empty-title">Shrine</span>}
      <span>{compact ? 'No offering yet' : 'No offering yet: no member has published to it.'}</span>
    </div>
  )
}

export function ShrinePanel({ runId, shrine, compact = false, onEnlarge }: ShrinePanelProps): JSX.Element {
  const [enlarged, setEnlarged] = useState(false)
  if (shrine === null) return <section className="shrine-panel" data-compact={compact} aria-label="Shrine"><EmptyShrine compact={compact} /></section>
  const enlarge = (): void => {
    setEnlarged(true)
    onEnlarge?.()
  }
  return (
    <section className="shrine-panel" data-compact={compact} aria-label="Shrine">
      <div className="shrine-view"><ShrineContent runId={runId} shrine={shrine} /></div>
      {compact ? null : <ShrineDetails shrine={shrine} />}
      <Button className="shrine-enlarge" size="sm" variant={compact ? 'ghost' : 'default'} onClick={enlarge}>Enlarge</Button>
      {enlarged ? (
        <Dialog title="Shrine" description={<ShrineDetails shrine={shrine} />} onClose={() => setEnlarged(false)}
          actions={<Button onClick={() => setEnlarged(false)}>Close</Button>}>
          <div className="shrine-view shrine-enlarged"><ShrineContent runId={runId} shrine={shrine} /></div>
        </Dialog>
      ) : null}
    </section>
  )
}
