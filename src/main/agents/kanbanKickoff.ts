/**
 * What Dark Mechanicus tells an agent it starts as a Kanban card's orchestrator when a person presses Play
 * (`docs/design/chat-shells.md`, "The card chat Play opens"): the title of its chat, the kickoff, and the guidance.
 *
 * - **The kickoff** is the chat's first input, sent with its first start only: fixed text, the card's id, key and
 *   title, the checked-out branch and the first step, then any additional instructions the person typed in Play
 *   (`kickoffInstructions.ts`). Claude Code takes it as its positional prompt, and every other CLI has it as its
 *   first paste. Without instructions it is short enough for any command line; with them it is also recorded as the
 *   chat's first input (`firstPrompt`), so a start that ends before it went delivers it once, later.
 * - **The guidance** is for the whole session, so it goes in the chat's instructions (`terminalFiles.ts`, for a chat
 *   with a `cardId`), after the `dm` instructions: the steps (claim, one worker that reports back, review, submit,
 *   stop, claim again after a kick-back) and the orchestrator and worker guides read from the same skill sources the
 *   MCP server serves as prompts, since a chat has no way to open an MCP prompt. A card chat started again (an exit,
 *   an app restart) on a new session still knows its card.
 *
 * Both are built from the card's id, key and title and the branch only, never from anything that grants access:
 * the claim token is issued when the orchestrator calls `claim_kanban_card`, and it hands the token to its worker
 * subagent. Every line goes through the claim token mask in case a title or branch name carries one.
 */
import { LIMITS } from '../../core/schemas'
import { skillBody } from '../../mcp/skills'
import { maskClaimTokens } from './claimTokenMask'
import { instructionsSection } from './kickoffInstructions'

export interface KanbanKickoffInput {
  cardId: string
  /** The card's display key, such as `DM-42`. */
  key: string
  title: string
  /** The checkout's current branch, which a card works on directly; null when it cannot be read. */
  branch: string | null
  /** What the person typed in the Play dialog: non-blank, appended as a section of its own. */
  instructions?: string
}

const TITLE_PREFIX = 'Kanban · '

/** One line: titles come from people and agents, so they cannot start a paragraph (or a step) of their own. */
function oneLine(text: string): string {
  return maskClaimTokens(text.replace(/\s+/g, ' ').trim())
}

/** "Kanban · <KEY> <title>", cut to the title limit. */
export function kanbanTitle(key: string, title: string): string {
  return `${TITLE_PREFIX}${oneLine(key)} ${oneLine(title)}`.slice(0, LIMITS.title)
}

/** The chat's first input: fixed text, the card lines and the first step, then any instructions the person added. */
export function kanbanKickoff(input: KanbanKickoffInput): string {
  const cardId = oneLine(input.cardId)
  return [
    'Carry this Dark Mechanicus Kanban card to Ready for review as its orchestrator, following the Kanban card guidance in your instructions. A person pressed Play in the desktop app.',
    '',
    `Card: ${oneLine(input.key)} ${oneLine(input.title)} (${cardId})`,
    input.branch === null ? 'Branch: the checked-out branch could not be read; cards work on whatever branch is checked out' : `Branch: ${oneLine(input.branch)}`,
    '',
    `First step: call get_capabilities and confirm your role is orchestrator, then call claim_kanban_card with cardId ${cardId}.`,
    ...(input.instructions === undefined
      ? []
      : ['', instructionsSection(input.instructions, 'this card', 'your role, your grants, Allow save or the card’s acceptance criteria')])
  ].join('\n')
}

const GUIDES_NOTE =
  'The two guides below are the same text as the darkmechanicus-orchestrator and darkmechanicus-worker MCP prompts. ' +
  'They are written for epics and runs; for this card, use claim_kanban_card, heartbeat_kanban_card, submit_kanban_card and fail_kanban_card where they name the ticket tools, and where they differ from the steps above (who submits, which branch), follow the steps. ' +
  'This chat has no way to open MCP prompts or skills, so where the guidance names one, use the text below.'

/** One guide, set off by a marker line so the person can see where it starts. */
function guide(heading: string, name: string): string[] {
  return [`=== ${heading} ===`, '', skillBody(name).trimEnd(), '']
}

/** What the instructions of the chat Play opened for card `cardId` add to the `dm` instructions. */
export function kanbanGuidance(cardId: string): string {
  const card = oneLine(cardId)
  return [
    '## Carrying a Dark Mechanicus Kanban card',
    '',
    `The desktop app started this chat as the orchestrator of the Kanban card ${card}, after a person pressed Play; your first message names the card and the checked-out branch. ` +
      'If this conversation has lost track of the card, start from step 1: claim_kanban_card returns its packet again.',
    '',
    '1. Call get_capabilities first and confirm your role is orchestrator.',
    `2. Call claim_kanban_card with cardId ${card}. It returns the card's packet: its content, the branch, every earlier kick-back comment and a claim token. If the packet's card lists attachments, they are the card's reference images or mockups: fetch each with get_attachment and give the worker what they show.`,
    '3. Start one worker subagent with three things written into the message you give it: the whole packet, the worker guidance below, and this rule: do not call submit_kanban_card or fail_kanban_card, report back to the orchestrator instead. ' +
      'The 5-minute check and 10-minute alarm are supervisory, not a worker deadline: productive workers continue on the same assignment and claim. Report progress/evidence, current operation, expected next result and blockers; investigate suspected stalled workers from evidence. A single card must not wait on an unsolicited epic or its Save. ' +
      'The claim token is a secret: give it only to the worker, and never put it in a commit, comment, report or note.',
    '4. Use the checked-out branch for legacy cards. Follow the configured Ticket standards and packet reporting instructions for branch and integration. The worker commits the change, calls heartbeat_kanban_card with a progress note every heartbeatIntervalSeconds, and reports back to you. It does not submit the card.',
    '5. Review what the worker reports against the acceptance criteria of the card and the Definition of Done in the packet. Send it back to the worker until it meets them. ' +
      'Keep calling heartbeat_kanban_card yourself while you review, until you submit, so the claim does not expire.',
    '6. Call submit_kanban_card after the project’s Ticket standards are met. Under the default Ticket standards, record the PR, green checks and main merge in evidence.merge (pullRequest, branch, commit, checksUrl). Include the outputs (summary, commits, changed files, branch) and evidence for each acceptance criterion. If the card cannot be done, call fail_kanban_card with the reason instead.',
    '7. Stop. A person approves or kicks back the card in the desktop app.',
    `8. If a message later says the card was kicked back by a person, call claim_kanban_card with cardId ${card} again and carry the card once more, addressing every comment.`,
    '',
    GUIDES_NOTE,
    '',
    ...guide('Orchestrator guidance (for you)', 'orchestrator'),
    ...guide('Worker guidance (give all of it to the worker subagent, with its packet)', 'worker'),
    '=== End of guidance ==='
  ].join('\n')
}
