import type { StoredDeliveryPolicy } from './deliveryPolicy'
import { defaultPrompts } from './standardsPrompts'

export const applyQuestion = 'Apply these standards to all existing project work now, including items already in progress?'

export function standardsChat(task: 'prepare' | 'standardize', saved?: StoredDeliveryPolicy): string {
  const revision = saved?.revision ?? 0
  const scope = 'Work only on the project bound to this chat. Read get_project and verify the current standards revision before writing.'
  if (task === 'standardize') {
    return [scope, `Apply saved Delivery Standards revision ${revision} to this project. The person explicitly approved including in-progress work.`,
      'Call standardize_project_work with that expectedRevision and includeInProgress true. Inspect pending items, submit project-specific patches, and verify the final accounting. Account for each epic, sprint, epic ticket, and Kanban card in every state. Preserve recorded evidence and identity, notify the active worker and orchestrator of changes, and report updated, already compliant, and follow-up counts. Resume existing work for this revision.'].join('\n')
  }
  return [scope, `Prepare the four Delivery Standards prompts with the person, starting from revision ${revision}.`,
    'Planned standards govern ticket tests and deployable sprint outcomes. Ticket standards distinguish epic integration and standalone Kanban review. Sprint standards govern combined testing, merge, rollout, and the deployed checkpoint. Epic standards govern evidence and closeout.',
    'Inspect this project’s test commands, independently runnable suites, CI checks, merge workflow, deployments, and how to identify a running revision. Look for measured test runtimes and recurring failures. Distinguish observations from proposed feedback loops. Discuss costs and risks, challenge weak coverage or expensive gates, and propose concrete edits.',
    'Show the edits, then save the agreed prompts with set_delivery_standards and setupDecision agent. Retain all existing structured policy fields. A stale revision requires reloading and discussing conflicting edits.',
    `After a successful save ask exactly: "${applyQuestion}" On Yes, use standardize_project_work with the newly saved expectedRevision and includeInProgress true. Inspect pending items, submit project-specific patches, and verify the final accounting. Later leaves the saved revision available.`,
    saved ? 'Read the saved prompts from get_project. For a legacy record, preserve its ticket, sprint and closeout rules when preparing the four prompts.' : JSON.stringify(defaultPrompts, null, 2)].join('\n\n')
}
