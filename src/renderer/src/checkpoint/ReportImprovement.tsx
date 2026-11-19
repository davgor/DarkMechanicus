/**
 * A sprint report's Improvement tab, shared by the checkpoint review and a completed epic's history: the retro read as
 * one chain, from the measured result (the scorecard frozen with the revision) to the findings read from it, the
 * experiments the retro drew from them and the corrective work each one led to, every link to its evidence. Findings
 * and experiments are read when the tab opens and again when the workspace reloads; they are frozen or derived, so they
 * are never polled. With a corrective host the person can select experiments and create their work as draft work (see
 * `CorrectivePlanner`); opening the tab, or a low grade, starts nothing.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { ExperimentView, RetroExperiment } from '../../../shared/domain/experiments'
import type { RetroFindingsView } from '../../../shared/domain/retroFindings'
import type { RunView, SprintReportView } from '../../../shared/domain/views'
import { bindRunner, type Failure, failureOf } from '../epic/runner'
import { EvidenceList, type EvidenceOpener } from '../scorecard/ScorecardParts'
import { correctionRoute } from './correctionRoute'
import { CorrectivePlanner, type CorrectionHost } from './CorrectivePlanner'
import { CrossRepoCorrection } from './CrossRepoCorrection'
import { retroLookup } from './gateView'
import {
  assessmentView,
  drawnFrom,
  experimentStatus,
  type FindingRow,
  findingsView,
  findingStatement,
  holdingEpics,
  selectability,
  type Selectability
} from './improvementView'
import { plannerKey, usePlanner } from './plannerStore'
import { reportOpener, type ReportScoreSource } from './ReportScorecard'
import { ticketNames } from './reportScorecardView'
import { useReportTabs } from './ReportTabs'
import { ExperimentCard, Field, Lines } from './RetroSections'
import { experimentRow, type RetroLookup } from './retroView'
import { TicketKey } from './TicketKey'

export interface ImprovementProps {
  report: SprintReportView
  run: RunView
  /** The plan the run executed (ticket keys and titles). */
  bundle: PlanBundle | null
  epicTitle: string
  /** A completed epic's corrective work goes into a follow-up epic. */
  epicCompleted: boolean
  /** Where the reads go (the folder) and the workspace's reload version. */
  source: ReportScoreSource
  /** Previews and creates corrective work; absent, the tab is read-only. */
  corrections?: CorrectionHost
  onSelectTicket(ticketId: string): void
}

type Read<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; failure: Failure }

interface Reads {
  /** Null for a report submitted before scorecards: it has no findings to read. */
  findings: Read<RetroFindingsView> | null
  experiments: ReadonlyMap<string, Read<ExperimentView>>
  retry(): void
}

/**
 * Reads the findings of the revision's frozen scorecard and each experiment's standing and outcome, again whenever the
 * workspace reloads (`version`) or on Try again. Answers for another report revision are never shown.
 */
function useImprovementReads(folder: string, report: SprintReportView, version: number | string): Reads {
  const [attempt, setAttempt] = useState(0)
  const measured = report.scorecard !== undefined
  const ids = (report.report.retro?.experiments ?? []).map((experiment) => experiment.id).join(' ')
  const reportKey = `${folder}|${report.id}|${report.reportRevision}`
  const [findings, setFindings] = useState<{ key: string; read: Read<RetroFindingsView> } | null>(null)
  const [experiments, setExperiments] = useState<{ key: string; reads: Map<string, Read<ExperimentView>> }>({ key: '', reads: new Map() })
  useEffect(() => {
    let live = true
    const run = bindRunner(folder)
    if (measured) {
      run('getRetroFindings', { reportId: report.id, reportRevision: report.reportRevision }).then(
        (value) => live && setFindings({ key: reportKey, read: { status: 'ready', value } }),
        (error: unknown) => live && setFindings({ key: reportKey, read: { status: 'error', failure: failureOf(error) } })
      )
    }
    for (const experimentId of ids.split(' ').filter((id) => id !== '')) {
      const settle = (read: Read<ExperimentView>): void => {
        if (!live) return
        setExperiments((current) => ({ key: reportKey, reads: new Map(current.key === reportKey ? current.reads : []).set(experimentId, read) }))
      }
      run('getExperiment', { experimentId }).then(
        (value) => settle({ status: 'ready', value }),
        (error: unknown) => settle({ status: 'error', failure: failureOf(error) })
      )
    }
    return () => {
      live = false
    }
  }, [folder, report.id, report.reportRevision, reportKey, measured, ids, version, attempt])
  return {
    findings: measured ? (findings?.key === reportKey ? findings.read : { status: 'loading' }) : null,
    experiments: experiments.key === reportKey ? experiments.reads : new Map(),
    retry: () => setAttempt((count) => count + 1)
  }
}

function Unavailable(props: { what: string; failure: Failure; onRetry(): void }): JSX.Element {
  return (
    <div role="alert" className="sc-error">
      <p>
        {props.what} could not be read: {props.failure.message} The rest of the report is still shown, and nothing was changed.
      </p>
      <button type="button" className="btn" onClick={props.onRetry}>
        Try again
      </button>
    </div>
  )
}

function Assessment({ report }: { report: SprintReportView }): JSX.Element {
  const view = assessmentView(report)
  const tabs = useReportTabs()
  return (
    <section className="cp-section" aria-label="Measured result">
      <h3 className="ew-eyebrow">1 · MEASURED RESULT</h3>
      {view.headline === null ? null : (
        <p className="cp-imp-headline">
          <span className="sc-letter" role="img" aria-label={`Sprint grade ${view.headline.letter}`}>
            {view.headline.letter}
          </span>
          <span>
            Sprint grade · {view.headline.score} · {view.headline.status} · {view.headline.coverage}
          </span>
        </p>
      )}
      {view.facts.length === 0 ? null : (
        <dl className="cp-experiment-fields">
          {view.facts.map((fact) => (
            <Field key={fact.label} label={fact.label}>
              {fact.value}
            </Field>
          ))}
        </dl>
      )}
      <p className="ew-muted">{view.note}</p>
      {view.headline === null || tabs === null ? null : (
        <button type="button" className="btn btn-ghost cp-open-tab" onClick={() => tabs.open('scorecard')}>
          Open the full Scorecard →
        </button>
      )}
    </section>
  )
}

/** Moves the view to another link of the chain. */
function jump(id: string): void {
  const target = document.getElementById(id)
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  target?.focus({ preventScroll: true })
}

function FindingItem(props: { row: FindingRow; id: string; anchorOf(experimentId: string): string; opener: EvidenceOpener; onSelectTicket(ticketId: string): void }): JSX.Element {
  const { row } = props
  return (
    <li className="cp-experiment" id={props.id} tabIndex={-1}>
      <span className="cp-experiment-head">
        <span className="ew-pill ew-tone-attention">{row.heading}</span>
        <span>{row.statement}</span>
      </span>
      <dl className="cp-experiment-fields">
        <Field label="Subject">
          {row.subject}
          {row.subjectTicket === null ? null : (
            <>
              {' '}
              <TicketKey ticket={row.subjectTicket} onSelect={props.onSelectTicket} />
            </>
          )}
        </Field>
        <Field label="Component">{row.component}</Field>
        <Field label="Magnitude">{row.magnitude}</Field>
        <Field label="Coverage">{row.coverage}</Field>
        <Field label="Hypotheses">{row.hypotheses.length === 0 ? 'None offered' : <Lines items={row.hypotheses} />}</Field>
        <Field label="Proposal">{row.proposal === null ? (row.withheld ?? 'None') : <Lines items={row.proposal} />}</Field>
        {row.contradictedBy.length === 0 ? null : <Field label="Contradicted by">{row.contradictedBy.join(', ')}</Field>}
        <Field label="Evidence">
          <EvidenceList refs={row.evidence} opener={props.opener} />
        </Field>
        <Field label="Experiments">
          {row.experiments.length === 0 ? (
            'No experiment of this retro was drawn from it'
          ) : (
            <ul>
              {row.experiments.map((link) => (
                <li key={link.experimentId}>
                  <button type="button" className="sc-link" onClick={() => jump(props.anchorOf(link.experimentId))}>
                    → {link.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Field>
      </dl>
    </li>
  )
}

interface ChainContext {
  anchor(kind: 'finding' | 'experiment', id: string): string
  opener: EvidenceOpener
  lookup: RetroLookup
  onSelectTicket(ticketId: string): void
}

function Findings(props: { read: Reads['findings']; experiments: RetroExperiment[]; ctx: ChainContext; onRetry(): void }): JSX.Element {
  const { read, ctx } = props
  const body = ((): JSX.Element => {
    if (read === null) return <p className="ew-muted">No findings: the report was submitted before scorecards, so nothing measured them.</p>
    if (read.status === 'loading')
      return (
        <p role="status" className="ew-muted">
          Reading the findings…
        </p>
      )
    if (read.status === 'error') return <Unavailable what="The findings" failure={read.failure} onRetry={props.onRetry} />
    const view = findingsView(read.value, props.experiments, ctx.lookup)
    return (
      <>
        {view.status === null ? null : <p className="ew-muted">{view.status}</p>}
        <ul className="cp-experiments">
          {view.rows.map((row) => (
            <FindingItem
              key={row.id}
              row={row}
              id={ctx.anchor('finding', row.id)}
              anchorOf={(experimentId) => ctx.anchor('experiment', experimentId)}
              opener={ctx.opener}
              onSelectTicket={ctx.onSelectTicket}
            />
          ))}
        </ul>
        {[...view.contradictions, ...view.notes].length === 0 ? null : <Lines items={[...view.contradictions, ...view.notes]} />}
      </>
    )
  })()
  const count = read?.status === 'ready' ? ` · ${read.value.findings.length}` : ''
  return (
    <section className="cp-section" aria-label="Findings">
      <h3 className="ew-eyebrow">2 · FINDINGS{count}</h3>
      <p className="field-hint">Measured gaps of the frozen scorecard, largest first. Each states a fact; what might explain it is a hypothesis, never a proven cause.</p>
      {body}
    </section>
  )
}

/** The selection box of an experiment, when corrective work can be planned here. */
interface Selection {
  checked: boolean
  onChange(checked: boolean): void
}

/**
 * An experiment's box: operable while it can be selected, and while it is still in the selection though it can no
 * longer be (it is left out of the request then, and unticking it clears it).
 */
function SelectBox(props: { experimentId: string; selection: Selection | null; can: Selectability }): JSX.Element | null {
  const { selection, can } = props
  if (selection === null) return null
  const status = can.selectable ? 'Select' : selection.checked ? 'Left out: untick to clear' : 'Not selectable'
  return (
    <label className="cp-plan-select">
      <input
        type="checkbox"
        aria-label={`Select ${props.experimentId} for corrective work`}
        disabled={!can.selectable && !selection.checked}
        checked={selection.checked}
        onChange={(event) => selection.onChange(event.target.checked)}
      />
      <span className="ew-muted">{status}</span>
    </label>
  )
}

function FromFindings(props: { experiment: RetroExperiment; findings: RetroFindingsView | null; ctx: ChainContext }): JSX.Element {
  const { findings, ctx } = props
  if (findings === null) return <Field label="From findings">No findings to link: none were read for this revision</Field>
  const sources = drawnFrom(props.experiment, findings.findings)
  return (
    <Field label="From findings">
      {sources.length === 0 ? (
        "No finding of this revision's scorecard shows its measure"
      ) : (
        <ul>
          {sources.map((finding) => (
            <li key={finding.id}>
              <button type="button" className="sc-link" onClick={() => jump(ctx.anchor('finding', finding.id))}>
                ← #{finding.rank} {findingStatement(finding, ctx.lookup)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Field>
  )
}

function Standing(props: { read: Read<ExperimentView> | undefined; can: Selectability; onRetry(): void }): JSX.Element {
  const { read } = props
  if (read === undefined || read.status === 'loading') {
    return (
      <Field label="Standing">
        <span className="ew-muted">Reading…</span>
      </Field>
    )
  }
  if (read.status === 'error') {
    return (
      <Field label="Standing">
        <Unavailable what="Its standing and outcome" failure={read.failure} onRetry={props.onRetry} />
      </Field>
    )
  }
  return (
    <Field label="Standing">
      <span className="ew-chip">{experimentStatus(read.value)}</span>
      {props.can.note === null ? null : <span className="ew-muted"> {props.can.note}</span>}
    </Field>
  )
}

/** The follow-up epics holding the experiment's corrective work, each opened in its own workspace. */
function HeldIn(props: { epics: { epicId: string; title: string }[]; onOpenEpic: ((epicId: string) => void) | null }): JSX.Element | null {
  const open = props.onOpenEpic
  if (props.epics.length === 0) return null
  return (
    <Field label="Held in">
      <ul>
        {props.epics.map((epic) => (
          <li key={epic.epicId}>
            Follow-up epic &quot;{epic.title}&quot; <span className="ew-mono ew-muted">{epic.epicId}</span>{' '}
            {open === null ? null : (
              <button type="button" className="sc-link" onClick={() => open(epic.epicId)}>
                Open it
              </button>
            )}
          </li>
        ))}
      </ul>
    </Field>
  )
}

/** Where an experiment aimed at the Dark Mechanicus source is routed from: this folder, its reload version, navigation. */
interface CrossRepoContext {
  folder: string
  version: number | string
  openFolderEpic: CorrectionHost['openFolderEpic']
  folderChanged: CorrectionHost['folderChanged']
}

interface ExperimentItemProps {
  experiment: RetroExperiment
  read: Read<ExperimentView> | undefined
  findings: RetroFindingsView | null
  report: SprintReportView
  /** The epic the report belongs to: work held in any other epic is a follow-up epic's. */
  homeEpicId: string
  ctx: ChainContext
  selection: Selection | null
  onOpenEpic: ((epicId: string) => void) | null
  /** Null where corrective work cannot be planned (a read-only report). */
  crossRepo: CrossRepoContext | null
  onRetry(): void
}

/** An experiment as a link of the chain: the findings it was drawn from, its standing, outcome and corrective work. */
function ExperimentItem(props: ExperimentItemProps): JSX.Element {
  const { experiment, read, ctx, crossRepo } = props
  const view = read?.status === 'ready' ? read.value : null
  const outcome = view?.outcome ?? props.report.experimentOutcomes?.find((item) => item.experimentId === experiment.id)
  const can = canSelect(experiment, read)
  const toSource = crossRepo !== null && correctionRoute(experiment.destination).kind === 'darkmechanicus_source'
  return (
    <ExperimentCard
      row={experimentRow(experiment, outcome, ctx.lookup)}
      id={ctx.anchor('experiment', experiment.id)}
      lead={<SelectBox experimentId={experiment.id} selection={props.selection} can={can} />}
      evidence={<EvidenceList refs={experiment.issue.evidence} opener={ctx.opener} />}
      onSelectTicket={ctx.onSelectTicket}
    >
      <FromFindings experiment={experiment} findings={props.findings} ctx={ctx} />
      <Standing read={read} can={can} onRetry={props.onRetry} />
      <HeldIn epics={holdingEpics(view, props.homeEpicId)} onOpenEpic={props.onOpenEpic} />
      {toSource ? (
        <Field label="Dark Mechanicus source">
          <CrossRepoCorrection
            folder={crossRepo.folder}
            reportId={props.report.id}
            experiment={experiment}
            read={view}
            version={crossRepo.version}
            openFolderEpic={crossRepo.openFolderEpic}
            folderChanged={crossRepo.folderChanged}
          />
        </Field>
      ) : null}
    </ExperimentCard>
  )
}

interface ExperimentsProps {
  experiments: RetroExperiment[]
  reads: Reads
  report: SprintReportView
  homeEpicId: string
  ctx: ChainContext
  /** The planner's selection; null when nothing can be planned here (a read-only report). */
  selection: { selected: string[]; toggle(experimentId: string, checked: boolean): void } | null
  /** Where corrective work is planned and opened; null for a read-only report. */
  host: CorrectionHost | null
  source: ReportScoreSource
}

function Experiments(props: ExperimentsProps): JSX.Element {
  const { experiments, reads, selection, host } = props
  const findings = reads.findings?.status === 'ready' ? reads.findings.value : null
  const crossRepo = host === null ? null : { folder: props.source.folderPath, version: props.source.version, openFolderEpic: host.openFolderEpic, folderChanged: host.folderChanged }
  return (
    <section className="cp-section" aria-label="Experiments">
      <h3 className="ew-eyebrow">3 · EXPERIMENTS · {experiments.length}</h3>
      {experiments.length === 0 ? <p className="ew-muted">The retro proposes no experiment, so there is no corrective work to plan from it.</p> : null}
      <ul className="cp-experiments">
        {experiments.map((experiment) => (
          <ExperimentItem
            key={experiment.id}
            experiment={experiment}
            read={reads.experiments.get(experiment.id)}
            findings={findings}
            report={props.report}
            homeEpicId={props.homeEpicId}
            ctx={props.ctx}
            selection={selection === null ? null : { checked: selection.selected.includes(experiment.id), onChange: (checked) => selection.toggle(experiment.id, checked) }}
            onOpenEpic={host === null ? null : host.openDraft}
            crossRepo={crossRepo}
            onRetry={reads.retry}
          />
        ))}
      </ul>
    </section>
  )
}

/**
 * Whether an experiment can be selected now: as its standing reads, and not while that read failed (its standing is
 * unknown until Try again reads it).
 */
function canSelect(experiment: RetroExperiment, read: Read<ExperimentView> | undefined): Selectability {
  if (read?.status === 'error') return { selectable: false, note: 'Its standing could not be read: Try again before selecting it.' }
  return selectability(experiment, read?.status === 'ready' ? read.value : null)
}

/** The Improvement tab: measured result → findings → experiments → corrective work, each linked to the next. */
export function ReportImprovement(props: ImprovementProps): JSX.Element {
  const { report, run, bundle } = props
  const folder = props.source.folderPath
  const reads = useImprovementReads(folder, report, props.source.version)
  const experiments = report.report.retro?.experiments ?? []
  const uid = useId()
  const lookup = useMemo(() => retroLookup({ run, bundle }), [run, bundle])
  const opener = useMemo(() => reportOpener(run, ticketNames(bundle), props.onSelectTicket), [run, bundle, props.onSelectTicket])
  const ctx: ChainContext = { anchor: (kind, id) => `${uid}-${kind}-${id}`, opener, lookup, onSelectTicket: props.onSelectTicket }
  const [planner, update] = usePlanner(plannerKey(folder, report))
  const host = props.corrections
  const unselectable = new Map(
    experiments.flatMap((experiment) => {
      const can = canSelect(experiment, reads.experiments.get(experiment.id))
      return can.selectable ? [] : [[experiment.id, can.note ?? 'It cannot be selected now.'] as const]
    })
  )
  const toggle = (experimentId: string, checked: boolean): void =>
    update((now) => ({ ...now, selected: [...now.selected.filter((id) => id !== experimentId), ...(checked ? [experimentId] : [])] }))
  return (
    <div className="cp-improvement" role="group" aria-label="Improvement">
      <p className="cp-imp-chain">Measured result → findings → experiments → corrective work. Each step links to the records it stands on.</p>
      <Assessment report={report} />
      <Findings read={reads.findings} experiments={experiments} ctx={ctx} onRetry={reads.retry} />
      <Experiments
        experiments={experiments}
        reads={reads}
        report={report}
        homeEpicId={run.epicId}
        ctx={ctx}
        selection={host === undefined ? null : { selected: planner.selected, toggle }}
        host={host ?? null}
        source={props.source}
      />
      {host === undefined || experiments.length === 0 ? null : (
        <CorrectivePlanner
          folder={folder}
          report={report}
          epicTitle={props.epicTitle}
          epicCompleted={props.epicCompleted}
          sprintOrdinal={bundle?.sprints.find((sprint) => sprint.id === report.sprintId)?.ordinal ?? null}
          experiments={experiments}
          unselectable={unselectable}
          host={host}
        />
      )}
    </div>
  )
}
