/**
 * Renders a sprint report's Improvement tab (`ReportImprovement`) over a FakeDm answering `getRetroFindings` and
 * `getExperiment`, with a recording corrective host. Every call builds fresh fakes; the folder names the planner store
 * key, so pass one per test.
 */
import { render, type RenderResult } from '@testing-library/react'
import type { CorrectionPlanView, CorrectionsInput, CorrectionsResultView, CreateCorrectionsInput } from '../../../shared/domain/corrections'
import type { ExperimentView, RetroExperiment } from '../../../shared/domain/experiments'
import type { RetroFindingsView } from '../../../shared/domain/retroFindings'
import type { SprintReportView } from '../../../shared/domain/views'
import type { CorrectionHost } from '../checkpoint/CorrectivePlanner'
import { type ImprovementProps, ReportImprovement } from '../checkpoint/ReportImprovement'
import { bundle, runView, SCORES } from '../epic/__mocks__/fixtures'
import type { Result } from '../epic/workspaceActions'
import type { Deferred } from './deferred'
import { FakeDm } from './fakeDm'
import { experimentRead, findings, planView, resultOf } from './improvementFixtures'

interface RecordingHost extends CorrectionHost {
  previews: CorrectionsInput[]
  creates: CreateCorrectionsInput[]
  opened: string[]
  reloads: string[]
  /** What the next preview and create answer (by default: the plan of the request, created). */
  previewAnswer: ((input: CorrectionsInput) => Result<CorrectionPlanView>) | null
  createAnswer: ((input: CreateCorrectionsInput) => Result<CorrectionsResultView>) | null
  /** Holds every preview or create until resolved. */
  hold: Deferred | null
}

export function recordingHost(patch: Partial<CorrectionHost> = {}): RecordingHost {
  const host: RecordingHost = {
    busy: false,
    sprints: [],
    draftRevision: 7,
    previews: [],
    creates: [],
    opened: [],
    reloads: [],
    previewAnswer: null,
    createAnswer: null,
    hold: null,
    async preview(input) {
      host.previews.push(input)
      await host.hold?.promise
      return host.previewAnswer?.(input) ?? { ok: true, value: planView(input.experimentIds) }
    },
    async create(input) {
      host.creates.push(input)
      await host.hold?.promise
      return host.createAnswer?.(input) ?? { ok: true, value: resultOf(planView(input.experimentIds)) }
    },
    openDraft: (epicId) => host.opened.push(epicId),
    openFolderEpic: null,
    folderChanged: null,
    reload: () => host.reloads.push('reload'),
    ...patch
  }
  return host
}

export interface ImprovementWorld {
  dm: FakeDm
  host: RecordingHost
  selected: string[]
  props: ImprovementProps
  view: RenderResult
  rerender(patch: Partial<ImprovementProps>): void
}

interface WorldSetup {
  folder: string
  report: SprintReportView
  findings?: RetroFindingsView
  reads?: Record<string, ExperimentView>
  host?: RecordingHost | null
  epicCompleted?: boolean
}

/** Installs a FakeDm answering the reads, then renders the tab. Experiments without a read answer as proposed. */
export function renderImprovement(setup: WorldSetup): ImprovementWorld {
  const dm = new FakeDm()
  const experiments: RetroExperiment[] = setup.report.report.retro?.experiments ?? []
  dm.responses.getRetroFindings = setup.findings ?? findings([])
  dm.handlers.getExperiment = (input) => {
    const id = typeof input === 'object' && input !== null && 'experimentId' in input ? String(input.experimentId) : ''
    const of = experiments.find((item) => item.id === id)
    return setup.reads?.[id] ?? (of === undefined ? undefined : experimentRead(of))
  }
  window.dm = dm
  const host = setup.host === undefined ? recordingHost() : setup.host
  const selected: string[] = []
  const props: ImprovementProps = {
    report: setup.report,
    run: runView({ state: 'awaiting_checkpoint' }),
    bundle: bundle(),
    epicTitle: 'Checkout revamp',
    epicCompleted: setup.epicCompleted ?? false,
    source: { ...SCORES, folderPath: setup.folder },
    ...(host === null ? {} : { corrections: host }),
    onSelectTicket: (ticketId) => selected.push(ticketId)
  }
  const view = render(<ReportImprovement {...props} />)
  return {
    dm,
    host: host ?? recordingHost(),
    selected,
    props,
    view,
    rerender: (patch) => view.rerender(<ReportImprovement {...props} {...patch} />)
  }
}
