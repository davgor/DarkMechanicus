import type { DeliveryPolicy, StandardsPrompts } from './deliveryPolicy'

const planning = 'Give every implementation ticket specific test cases with a starting condition, action, expected result and verification method. Plan each sprint around a deployable deliverable the person can use and verify. Keep coupled changes together and split independently verifiable work.'
const epic = 'Before closing the epic, compare the delivered sprints to its intended outcome, preserve evidence of what shipped, and surface remaining criteria for review.'
const verification = 'Run the named ticket tests. Diagnose and fix flakes and timeouts. A rerun alone cannot establish passing evidence.'
const closeout = { push: true, verifyRemote: true, cleanTemporaryFiles: true, removeWorktree: true }

const legacyDefaults: DeliveryPolicy = {
  epicTicket: {
    verification,
    acceptance: 'The orchestrator reviews test coverage and passing evidence for each acceptance criterion.',
    integration: 'Integrate into the epic worktree and verify integration before marking the ticket Accepted.',
    delivery: 'Record the tested and integrated revisions.'
  },
  kanban: {
    verification,
    acceptance: 'After merge to main, mark the card Ready for human review. The person determines completion.',
    integration: 'Open a pull request, fix failing checks, and merge to main once CI passes.',
    delivery: 'Confirm and record the merged revision on main.'
  },
  sprint: 'Verify the combined deliverable and required tests. Open the sprint PR, resolve failures, merge and own deployment through rollout. Confirm the deployed revision, then tell the person which version to install and what to verify. At checkpoint the person can accept, request corrections or replan the next sprint.',
  kanbanCloseout: { ...closeout },
  epicCloseout: { ...closeout }
}

function ticketText(label: string, rules: DeliveryPolicy['kanban']): string {
  return [label, rules.verification, rules.acceptance, rules.integration, rules.delivery].join('\n')
}

function closeoutText(rules: DeliveryPolicy['kanbanCloseout']): string {
  const choices = [
    ['Push', rules.push], ['Verify remote', rules.verifyRemote],
    ['Clean temporary files', rules.cleanTemporaryFiles], ['Remove worktree', rules.removeWorktree]
  ] as const
  return choices.map(([label, enabled]) => label + ': ' + (enabled ? 'yes' : 'no')).join('. ')
}

export function effectivePrompts(policy: DeliveryPolicy = legacyDefaults): StandardsPrompts {
  if (policy.prompts) return { ...policy.prompts }
  return {
    planned: planning,
    ticket: [ticketText('Epic ticket', policy.epicTicket), ticketText('Standalone Kanban ticket', policy.kanban),
      'Kanban closeout: ' + closeoutText(policy.kanbanCloseout)].join('\n\n'),
    sprint: policy.sprint,
    epic: epic + '\n\nEpic closeout: ' + closeoutText(policy.epicCloseout)
  }
}

export const defaultPrompts = effectivePrompts()
export const baselineDeliveryPolicy: DeliveryPolicy = { ...legacyDefaults, prompts: defaultPrompts }
