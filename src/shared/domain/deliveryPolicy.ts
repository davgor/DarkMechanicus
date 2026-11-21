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

export interface DeliveryPolicy {
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
