import type { PlannedTestCase } from './bundle'

type StandardizationKind = 'epic' | 'sprint' | 'ticket' | 'kanban'
type StandardizationDisposition = 'updated' | 'compliant' | 'follow_up'

interface StandardizationTarget {
  kind: StandardizationKind
  id: string
  epicId?: string
}

export interface StandardizationPatch extends StandardizationTarget {
  disposition: StandardizationDisposition
  requirements?: string
  deploymentVerification?: string
  testCases?: PlannedTestCase[]
  tests?: string[]
  acceptanceCriteria?: string[]
  reason: string
}

export type StandardsNoticeRoute = 'inbox' | 'refresh' | 'current_chat'

export interface StandardsNotice {
  worker?: StandardsNoticeRoute
  orchestrator: StandardsNoticeRoute
}

export interface StandardizationItem extends StandardizationTarget {
  title: string
  active: boolean
  completed: boolean
  notifications?: StandardsNotice
  disposition: StandardizationDisposition | 'pending'
  reason?: string
}

export interface StandardizeProjectWorkInput {
  expectedRevision: number
  includeInProgress: boolean
  items?: StandardizationPatch[]
}

export interface StandardizeProjectWorkResult {
  revision: number
  items: StandardizationItem[]
}
