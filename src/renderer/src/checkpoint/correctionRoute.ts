/**
 * Where an experiment's corrective work is routed from a sprint report. Same-repository work (this project's
 * repository, or one repository of a folder of repositories) is previewed and created as draft work right here
 * (`previewCorrections` / `createCorrections`). Work aimed at the Dark Mechanicus source goes to the Dark Mechanicus
 * checkout chosen on this machine (`window.dm.sourceCheckout`) as a target-owned correction epic, previewed and created
 * there through `window.dm.crossRepoCorrections` (`CrossRepoCorrection`), never created in this project.
 */
import type { ExperimentDestinationKind, RetroExperiment } from '../../../shared/domain/experiments'

type CorrectionRoute = { kind: 'same_repository'; repository: string | null } | { kind: 'darkmechanicus_source' }

/** Where an experiment's work goes: from its destination, or from a finding proposal's destination kind. */
export function correctionRoute(destination: RetroExperiment['destination'] | ExperimentDestinationKind): CorrectionRoute {
  if (typeof destination === 'string') return destination === 'darkmechanicus_source' ? { kind: 'darkmechanicus_source' } : { kind: 'same_repository', repository: null }
  return destination.kind === 'darkmechanicus_source' ? { kind: 'darkmechanicus_source' } : { kind: 'same_repository', repository: destination.repository }
}

/** "Source repository api", "Source repository" or "Dark Mechanicus source (a new epic in your Dark Mechanicus checkout)". */
export function routeText(route: CorrectionRoute): string {
  if (route.kind === 'darkmechanicus_source') return 'Dark Mechanicus source (a new epic in your Dark Mechanicus checkout)'
  return route.repository === null ? 'Source repository' : `Source repository ${route.repository}`
}
