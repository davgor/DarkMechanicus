/** A narrow plan.save request, local to this folder and machine; never a general delegation. */
export interface SavePermissionRequestView {
  id: string
  sessionId: string
  grantId: string | null
  requesterLabel: string
  reason: string
  status: 'pending' | 'approved' | 'denied'
  requestedAt: string
  decidedAt: string | null
  decidedBySessionId: string | null
  decisionReason: string | null
}
