/**
 * The Past runs drawer: each ended run with when it started, its end reason, how long it lasted and its chronicle. The
 * chronicle is the Magos's own text, so it is rendered as inert text (React escapes it; nothing is parsed as HTML or
 * Markdown). Each run leaves a slot for its read-only pipeline, which the pipeline ticket fills.
 */
import type { CultRunDetail } from '../../../shared/cults/cultApi'
import { Button } from '../components/Button'
import { END_TEXT, runDuration } from './cultPageModel'

export function PastRunsDrawer({ runs, onClose }: { runs: readonly CultRunDetail[]; onClose(): void }): JSX.Element {
  return (
    <aside className="cult-past-drawer" aria-label="Past runs" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <header className="cult-past-head">
        <h2>Past runs</h2>
        <Button size="sm" variant="ghost" icon="close" aria-label="Close past runs" onClick={onClose} />
      </header>
      {runs.length === 0 ? <p className="cult-empty-note">No run of this cult has ended yet.</p> : (
        <ol className="cult-past-runs">
          {runs.map(({ run }) => (
            <li key={run.id} className="cult-past-run">
              <div className="cult-past-meta">
                <span className="mono">{new Date(run.startedAt).toLocaleString()}</span>
                <span className="badge">{run.endReason === null ? 'Ended' : END_TEXT[run.endReason]}</span>
                <span className="mono">{runDuration(run)}</span>
              </div>
              {run.chronicle === null ? <p className="cult-empty-note">No chronicle was written.</p> : <p className="cult-chronicle">{run.chronicle}</p>}
              <div className="cult-past-pipeline" data-slot="past-pipeline" data-run-id={run.id} />
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}
