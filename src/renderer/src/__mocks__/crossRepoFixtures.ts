/**
 * Builders for the Dark Mechanicus source panel (`CrossRepoCorrection`) and correction epics: a source project "Shop"
 * asking the chosen Dark Mechanicus checkout (project `pj_dm` at `C:/code/dm`) for a new correction epic. Each call
 * returns fresh objects (test support only).
 */
import type { SourceCheckoutView } from '../../../shared/desktop/sourceCheckout'
import type { CorrectionProvenance } from '../../../shared/domain/bundle'
import type {
  CrossRepoCorrectionLinkView,
  CrossRepoCorrectionPreview,
  CrossRepoCorrectionResult,
  CrossRepoTargetAvailability,
  CrossRepoTargetEpicView
} from '../../../shared/domain/crossRepoCorrections'
import type { CorrectionTicketView } from '../../../shared/domain/corrections'
import type { RetroExperiment } from '../../../shared/domain/experiments'

export const SHOP = 'C:/code/shop'
export const DM = 'C:/code/dm'
const XP = 'xp_0001'
export const REPORT = 'rp_0003'
export const KEY = `${REPORT}/${XP}/from:pj_shop/to:pj_dm`

export function xrTarget(patch: Partial<CrossRepoTargetAvailability> = {}): CrossRepoTargetAvailability {
  return {
    status: 'available',
    projectId: 'pj_dm',
    projectName: 'Dark Mechanicus',
    path: DM,
    displayPath: '~/code/dm',
    problem: null,
    message: null,
    recovery: null,
    ...patch
  }
}

export function xrTargetEpic(patch: Partial<CrossRepoTargetEpicView> = {}): CrossRepoTargetEpicView {
  return {
    projectId: 'pj_dm',
    epicId: 'ep_fix',
    epicTitle: 'Correction from Shop: slow claims',
    sprintId: 'sp_fix',
    ticketIds: ['tk_7', 'tk_8'],
    keys: ['DM-7', 'DM-8'],
    draftRevision: 1,
    status: 'backlog',
    saved: false,
    created: false,
    ...patch
  }
}

export function xrLink(patch: Partial<CrossRepoCorrectionLinkView> = {}): CrossRepoCorrectionLinkView {
  return {
    key: KEY,
    experimentId: XP,
    reportId: REPORT,
    sourceEpicId: 'ep_shop',
    targetProjectId: 'pj_dm',
    payloadHash: 'ph_1',
    state: 'linked',
    target: xrTargetEpic(),
    attempts: 1,
    lastError: null,
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    linkedAt: '2026-11-10T09:00:00.000Z',
    results: null,
    ...patch
  }
}

/** The work ticket and the Fireguard ticket a preview plans as DM-7 and DM-8 (DM-8 needs DM-7). */
function previewTickets(): CorrectionTicketView[] {
  return [
    {
      ref: `${XP}#0`,
      role: 'work',
      experimentId: XP,
      workIndex: 0,
      key: 'DM-7',
      title: 'Cache the claim packet',
      ticketId: null,
      existing: false,
      body: 'Cache it.',
      size: 'small',
      tags: [],
      repo: null,
      acceptanceCriteria: [{ id: 'c1', text: 'Cached.', covers: null }],
      dependsOn: []
    },
    {
      ref: 'fireguard',
      role: 'fireguard',
      experimentId: null,
      workIndex: null,
      key: 'DM-8',
      title: 'Grade the corrective tests with Fireguard',
      ticketId: null,
      existing: false,
      body: 'Grade them.',
      size: null,
      tags: [],
      repo: null,
      acceptanceCriteria: [
        { id: 'c1', text: 'Graded.', covers: null },
        { id: 'c2', text: 'No flakes.', covers: null }
      ],
      dependsOn: [`${XP}#0`]
    }
  ]
}

/** A ready preview: nothing requested yet, the chosen checkout available. */
export function xrPreview(patch: Partial<CrossRepoCorrectionPreview> = {}): CrossRepoCorrectionPreview {
  return {
    source: {
      projectId: 'pj_shop',
      projectName: 'Shop',
      epicId: 'ep_shop',
      epicTitle: 'Checkout flow',
      epicStatus: 'in_progress',
      runId: 'rn_shop',
      sprintId: 'sp_shop',
      sprintOrdinal: 1,
      reportId: REPORT,
      reportRevision: 3
    },
    experimentId: XP,
    concern: 'orchestration_tooling',
    state: 'ready',
    problems: [],
    target: xrTarget(),
    key: KEY,
    payloadHash: 'ph_1',
    provenance: null,
    epic: { title: 'Correction from Shop: slow claims', intent: 'Faster claims.', successCriteria: ['Claims take under a minute.'] },
    tickets: previewTickets(),
    dependencies: [{ from: 'DM-8', to: 'DM-7' }],
    validation: { valid: true, errors: [], warnings: [] },
    link: null,
    existing: null,
    needsRecreate: false,
    nextSteps: ['Create it: the Dark Mechanicus source gets a new backlog epic holding this draft.'],
    ...patch
  }
}

/** A create or retry answer; linked and written by default. */
export function xrResult(patch: Partial<CrossRepoCorrectionResult> = {}): CrossRepoCorrectionResult {
  return {
    progress: 'linked',
    changed: true,
    link: xrLink(),
    target: xrTargetEpic({ created: true }),
    failure: null,
    nextSteps: ['Open it in Dark Mechanicus to review, Save and start it.'],
    ...patch
  }
}

export function checkoutView(patch: Partial<SourceCheckoutView> = {}): SourceCheckoutView {
  return {
    status: 'available',
    target: { kind: 'darkmechanicus_source', projectId: 'pj_dm', projectName: 'Dark Mechanicus' },
    local: { path: DM, displayPath: '~/code/dm', associatedAt: '2026-11-01T09:00:00.000Z' },
    problem: null,
    message: null,
    recovery: null,
    ...patch
  }
}

export function retroExperiment(patch: Partial<RetroExperiment> = {}): RetroExperiment {
  return {
    id: XP,
    source: {
      revision: 'own',
      epicId: 'ep_shop',
      runId: 'rn_shop',
      sprintId: 'sp_shop',
      reportId: REPORT,
      reportRevision: 3,
      snapshotId: 'sn_1',
      policyHash: 'po_1',
      assessmentId: 'as_1',
      subject: { level: 'sprint', id: 'sp_shop' },
      inputHash: 'in_1'
    },
    concern: 'orchestration_tooling',
    issue: { summary: 'Claims are slow.', evidence: [] },
    hypothesis: 'The claim packet is rebuilt each time.',
    destination: { kind: 'darkmechanicus_source' },
    proposedWork: [{ title: 'Cache the claim packet', body: 'Cache it.', size: 'small' }],
    baseline: { measure: 'T.actual_ms', unit: 'milliseconds', value: 4_200_000, state: 'observed' },
    expectedChange: { direction: 'decrease', amount: 20, unit: 'percent' },
    guardrails: [],
    window: { basis: 'sprints', count: 1 },
    ...patch
  }
}

/** The provenance a correction epic carries: asked by Shop's report revision 3 of the Dark Mechanicus project. */
export function correctionProvenance(source: Partial<CorrectionProvenance['source']> = {}, targetProjectId = 'pj_dm'): CorrectionProvenance {
  return {
    kind: 'cross_repo_correction',
    key: KEY,
    payloadHash: 'ph_1',
    source: {
      projectId: 'pj_shop',
      projectName: 'Shop',
      epicId: 'ep_shop',
      runId: 'rn_shop',
      sprintId: 'sp_shop',
      reportId: REPORT,
      reportRevision: 3,
      reportHash: 'rh_1',
      experimentId: XP,
      assessment: { reportId: REPORT, assessmentId: 'as_1', snapshotId: 'sn_1', policyHash: 'po_1' },
      ...source
    },
    target: { projectId: targetProjectId },
    note: 'Corrective work asked by Shop.'
  }
}
