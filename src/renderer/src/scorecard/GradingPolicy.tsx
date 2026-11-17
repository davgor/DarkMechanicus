/**
 * The default balanced grading policy and its calculation, read from the core (`getGradingPolicy`) and shown as it is:
 * each component's base weight and share, its rule and formula, what happens when it cannot be scored, how the composite
 * and the letter follow, and the bands. Read-only: there is no policy editor. Folded until opened, and read once per
 * folder when first opened.
 */
import { useEffect, useState } from 'react'
import type { GradingPolicyView } from '../../../shared/domain/scoreReads'
import { SPACE_COMPONENT_LABELS } from '../../../shared/domain/space'
import { runCommand } from '../api/dm'
import { failureOf } from '../epic/runner'
import { shortHash, weightText } from './scorecardFormat'

type PolicyRead = { status: 'idle' | 'loading' } | { status: 'ready'; policy: GradingPolicyView } | { status: 'error'; message: string }

function PolicyBody({ policy }: { policy: GradingPolicyView }): JSX.Element {
  return (
    <>
      <p className="sc-note">
        Policy {policy.policy.policyId} v{policy.policy.version} · <span className="ew-mono">{shortHash(policy.policy.hash)}</span>: every component starts with the same
        weight. A grade frozen under another version keeps that version.
      </p>
      <table className="sc-policy-table">
        <thead>
          <tr>
            <th scope="col">Component</th>
            <th scope="col">Base weight</th>
            <th scope="col">Rule and formula</th>
            <th scope="col">When it cannot be scored</th>
          </tr>
        </thead>
        <tbody>
          {policy.components.map((entry) => (
            <tr key={entry.component}>
              <th scope="row">
                <span className="ew-mono">{entry.component}</span> {SPACE_COMPONENT_LABELS[entry.component]}
                <span className="sc-note"> · {entry.required ? 'required' : 'optional'}, {entry.signal}</span>
              </th>
              <td>
                {entry.weight} ({weightText(entry.baseShare)})
              </td>
              <td>
                <span className="ew-mono">{entry.rule}</span>: {entry.formula}
              </td>
              <td>{entry.whenMissing}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="sc-explanation" aria-label="How the grade is calculated">
        <li>Composite: {policy.composite}.</li>
        <li>
          Letters: {policy.bands.map((band) => (band.min === 0 ? `${band.letter} below ${policy.bands.at(-2)?.min ?? 0}` : `${band.letter} ≥ ${band.min}`)).join(', ')}.
        </li>
        <li>Fewer than {policy.minScoredComponents} scored components: ungraded, never a letter.</li>
        <li>Scores are {policy.precision}.</li>
      </ul>
    </>
  )
}

/** "How grades are calculated": the policy in force for new grades, folded until the person opens it. */
export function GradingPolicyDetails({ folderPath }: { folderPath: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [read, setRead] = useState<PolicyRead>({ status: 'idle' })
  useEffect(() => {
    if (!open || read.status !== 'idle') {
      return
    }
    setRead({ status: 'loading' })
    runCommand(folderPath, 'getGradingPolicy', undefined).then(
      (policy) => setRead({ status: 'ready', policy }),
      (error: unknown) => setRead({ status: 'error', message: failureOf(error).message })
    )
  }, [open, read.status, folderPath])
  return (
    <details className="sc-policy-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>How grades are calculated (the default balanced policy)</summary>
      {read.status === 'ready' ? <PolicyBody policy={read.policy} /> : null}
      {read.status === 'loading' ? <p className="sc-note">Reading the policy…</p> : null}
      {read.status === 'error' ? (
        <div className="sc-error" role="alert">
          <p>Could not read the policy: {read.message}</p>
          <button type="button" className="btn" onClick={() => setRead({ status: 'idle' })}>
            Try again
          </button>
        </div>
      ) : null}
    </details>
  )
}
