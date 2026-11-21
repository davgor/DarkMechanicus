interface TicketStandards {
  verification: string
  acceptance: string
  integration: string
  delivery: string
}

interface CloseoutStandards {
  push: boolean
  verifyRemote: boolean
  cleanTemporaryFiles: boolean
  removeWorktree: boolean
}

export interface StandardsPrompts {
  planned: string
  ticket: string
  sprint: string
  epic: string
}

type StandardsSetupDecision = 'defaults' | 'agent' | 'edited'

export interface DeliveryPolicy {
  /** Absent on policies written before the four-prompt editor was introduced. */
  prompts?: StandardsPrompts
  setupDecision?: StandardsSetupDecision
  kanban: TicketStandards
  epicTicket: TicketStandards
  sprint: string
  kanbanCloseout: CloseoutStandards
  epicCloseout: CloseoutStandards
}

export interface StoredDeliveryPolicy {
  revision: number
  policy: DeliveryPolicy
}
