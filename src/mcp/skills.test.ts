import { describe, expect, it } from 'vitest'
import agentsStandards from '../../.agents/skills/delivery-standards/SKILL.md?raw'
import claudeStandards from '../../.claude/skills/delivery-standards/SKILL.md?raw'
import cursorStandards from '../../.cursor/skills/delivery-standards/SKILL.md?raw'
import architecture from '../../docs/architecture.md?raw'
import correctiveWork from '../../docs/runbooks/corrective-work.md?raw'
import mcpSetup from '../../docs/runbooks/mcp-setup.md?raw'
import spaceGrading from '../../docs/space-grading.md?raw'
import linearTransferSource from '../../skills/linear-transfer.md?raw'
import linearRunbook from '../../docs/runbooks/linear-transfer.md?raw'
import { BUILTIN_KNOWLEDGE } from '../core/knowledge/builtin'
import { parseFact } from '../core/knowledge/fact'
import { SKILLS_VERSION } from '../core/version'
import { LINEAR_SETUP_LINES } from '../shared/domain/linearSetup'
import { markdownSection, missingPhrases } from '../test/markdownSections'
import { SKILLS, skillBody, splitSkillSource } from './skills'

const EXPECTED = [
  ['planner', 'Planner'],
  ['graph-planner', 'Graph planner'],
  ['orchestrator', 'Orchestrator'],
  ['worker', 'Worker'],
  ['reviewer', 'Reviewer'],
  ['sprint-reporter', 'Sprint reporter'],
  ['linear-transfer', 'Linear transfer'],
  ['collaboration', 'Collaboration policy']
]

const VENDOR_WORDS = /claude|anthropic|openai|gpt|gemini|llama|mistral|copilot|codex|sonnet|opus|haiku/i

/** The Linear transfer guide gives each CLI's setup line; nothing else in a skill may name a vendor. */
function withoutLinearSetup(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.includes('https://mcp.linear.app/mcp'))
    .join('\n')
}

function skill(name: string) {
  const found = SKILLS.find((candidate) => candidate.name === name)
  if (found === undefined) {
    throw new Error(`missing skill ${name}`)
  }
  return found
}

describe('SKILLS', () => {
  it('ships the skills in a stable order with their titles', () => {
    expect(SKILLS.map((item) => [item.name, item.title])).toEqual(EXPECTED)
  })

  it('gives each skill a one-line description that reads as a sentence', () => {
    for (const item of SKILLS) {
      expect(item.description).not.toContain('\n')
      expect(item.description.length).toBeGreaterThan(40)
      expect(item.description.length).toBeLessThanOrEqual(300)
      expect(item.description.startsWith('#')).toBe(false)
      expect(item.description.endsWith('.')).toBe(true)
    }
  })

  it('starts each body with its own title heading, without repeating the description', () => {
    for (const item of SKILLS) {
      expect(item.body.startsWith(`# ${item.title}\n`)).toBe(true)
      expect(item.body).not.toContain(item.description)
    }
  })

  it('keeps bodies provider neutral, apart from the Linear setup lines', () => {
    for (const item of SKILLS) {
      expect(VENDOR_WORDS.test(withoutLinearSetup(item.body))).toBe(false)
      expect(VENDOR_WORDS.test(item.description)).toBe(false)
    }
  })

  it('gives each Linear setup line of dm transfer and the app verbatim in the transfer guide', () => {
    const guideLines = linearTransferSource.split('\n')
    expect(LINEAR_SETUP_LINES.map((entry) => entry.cli)).toEqual(['Claude Code', 'Codex', 'Cursor'])
    for (const entry of LINEAR_SETUP_LINES) {
      expect(guideLines.filter((guideLine) => guideLine.includes(entry.guide)), entry.cli).toHaveLength(1)
    }
  })

  it('makes every skill treat task text as data that cannot override the rules', () => {
    for (const item of SKILLS) {
      expect(item.body).toContain('task data')
      expect(item.body).toContain('never override')
    }
  })

  it('ends every body with a single newline and uses plain LF line endings', () => {
    for (const item of SKILLS) {
      expect(item.body.endsWith('\n')).toBe(true)
      expect(item.body.endsWith('\n\n')).toBe(false)
      expect(item.body).not.toContain('\r')
    }
  })
})

describe('the Linear transfer runbook', () => {
  it('gives each Linear setup line verbatim in its setup table, once', () => {
    const runbookLines = linearRunbook.split('\n')
    for (const entry of LINEAR_SETUP_LINES) {
      expect(runbookLines.filter((runbookLine) => runbookLine.includes(`| ${entry.cli} | ${entry.guide} |`)), entry.cli).toHaveLength(1)
    }
  })
})

describe('SKILLS_VERSION', () => {
  it('uses a semantic skills version', () => {
    expect(SKILLS_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('moved past 1.2.0 when the sizing and dispatch guidance was added', () => {
    const [major = 0, minor = 0] = SKILLS_VERSION.split('.').map(Number)
    expect(major > 1 || (major === 1 && minor >= 3)).toBe(true)
  })

  it('moved past 1.3.0 when the light-ticket, row-check and acceptance-round cadence was added', () => {
    const [major = 0, minor = 0] = SKILLS_VERSION.split('.').map(Number)
    expect(major > 1 || (major === 1 && minor >= 4)).toBe(true)
  })

  it('moved past 1.4.0 when the retro and the redraft loop was added', () => {
    const [major = 0, minor = 0] = SKILLS_VERSION.split('.').map(Number)
    expect(major > 1 || (major === 1 && minor >= 5)).toBe(true)
  })

  it('moved past 1.6.1 when the Linear guide reworded the final read-back part', () => {
    const [major = 0, minor = 0, patch = 0] = SKILLS_VERSION.split('.').map(Number)
    expect(major > 1 || (major === 1 && (minor > 6 || (minor === 6 && patch >= 2)))).toBe(true)
  })

  it('moved past 1.6.2 when the guides started routing isolated tickets to the Kanban board', () => {
    const [major = 0, minor = 0] = SKILLS_VERSION.split('.').map(Number)
    expect(major > 1 || (major === 1 && minor >= 7)).toBe(true)
  })

  it('moved past 1.7.0 when the guides started covering image attachments', () => {
    const [major = 0, minor = 0] = SKILLS_VERSION.split('.').map(Number)
    expect(major > 1 || (major === 1 && minor >= 8)).toBe(true)
  })

  it('moved past 1.8.0 when the guides started treating flaky and timed-out checks as failures', () => {
    const [major = 0, minor = 0] = SKILLS_VERSION.split('.').map(Number)
    expect(major > 1 || (major === 1 && minor >= 9)).toBe(true)
  })

  it('moved past 1.9.0 when the planning guides started requiring one key deliverable per sprint', () => {
    const [major = 0, minor = 0] = SKILLS_VERSION.split('.').map(Number)
    expect(major > 1 || (major === 1 && minor >= 10)).toBe(true)
  })

  it('moved past 1.10.0 when the orchestrator guide split into a kernel and built-in knowledge facts', () => {
    const [major = 0, minor = 0] = SKILLS_VERSION.split('.').map(Number)
    expect(major > 1 || (major === 1 && minor >= 11)).toBe(true)
  })

  it('moved past 1.11.0 when the guides started covering SPACE measurement, grades and corrective work', () => {
    const [major = 0, minor = 0] = SKILLS_VERSION.split('.').map(Number)
    expect(major > 1 || (major === 1 && minor >= 12)).toBe(true)
  })
})

/** The orchestrator's rules live in its kernel guide plus the built-in orchestrator knowledge facts (those whose id starts with `idPrefix`). */
function orchestratorFactBodies(idPrefix = 'orchestrator.'): string[] {
  return BUILTIN_KNOWLEDGE.flatMap(({ path, source }) => {
    const result = parseFact(source, { layer: 'builtin', path })
    return result.ok && result.fact.scope.roles.includes('orchestrator') && result.fact.id.startsWith(idPrefix) ? [result.fact.body] : []
  })
}

/** Phrases each skill must keep; a guard against accidentally dropping a rule during edits. */
const REQUIRED: [string, string[]][] = [
  [
    'planner',
    [
      'success criteria',
      'acceptanceCriteria',
      'capability',
      'reasoning',
      'ESTIMATE',
      '`update_plan_draft`',
      '`validate_plan`',
      '`save_plan`',
      '--allow-save',
      'press Save',
      '`provenance`',
      'NEW epic',
      'Give every ticket a `size`',
      'one obvious change in one or two files',
      'one coherent change inside one module',
      'Call out micro tasks',
      '`reasoning.effort`',
      'Leave `quality` unset unless the person asked',
      'Precise ticket bodies',
      '## 7. Replan while a run is executing',
      'Edit only future sprints',
      'Never edit a sprint the run has passed',
      'A run does not redo a sprint it has passed',
      '`get_run`',
      'set `repo` on every work ticket',
      'One ticket changes one repository',
      'one ticket per repository',
      'give the title without it',
      'Acceptance nodes take no `repo`',
      'redraft',
      '`update_kanban_card`'
    ]
  ],
  [
    'graph-planner',
    [
      "B requires A's ACCEPTED result",
      'parallel',
      'join',
      'integration ticket',
      'later sprint',
      'exitCriteria',
      'validate_plan',
      'Explain the graph',
      '## The acceptance node',
      'implicitly requires every required work ticket',
      'one `covers` criterion per ticket',
      'the specific screenshot, measurement or end-to-end check',
      'only for work that must combine mid-sprint',
      '`set_definition_of_done`',
      'its own ticket',
      'row',
      'each covering criterion names the repository its check runs in',
      'one key deliverable',
      'Never cut a sprint boundary',
      'by layer',
      'what can the person use or see',
      'spike sprint',
      'a vetted next sprint',
      'ship its first real consumer in the same epic'
    ]
  ],
  [
    'orchestrator',
    [
      '## Rules that always apply',
      'returns `context`',
      '`get_context`',
      '`get_capabilities`',
      '`register_host`',
      '`start_run`',
      '`get_ready_tickets`',
      '`match_capabilities`',
      '`claim_ticket`',
      '`heartbeat_attempt`',
      '`submit_attempt`',
      '`accept_attempt`',
      '`reject_attempt`',
      '`reconcile_attempt`',
      '`submit_sprint_report`',
      '`get_checkpoint`',
      '`advance_sprint`',
      '`adopt_revision`',
      '`takeover_run`',
      'feature branch',
      'cannot approve',
      'rationale',
      'subagent',
      'never do a ticket yourself',
      'the `efforts` it can run at',
      'Use the recommended model and effort',
      'at the model and effort you claimed',
      'one tier above',
      'one effort step',
      'Never jump straight to the most capable worker',
      'the reason in the claim `rationale`',
      'profile proposal',
      'Orchestrator (fallback)',
      'Register every tool the host really has',
      '`network` and `browser`',
      "the run's catalog is fixed at start",
      "The sprint's combined work lives on a sprint integration branch in a separate worktree",
      'sprint integration branch',
      'separate worktree',
      'Keep the coordinating checkout on the epic branch',
      '`branch_changed`',
      '`git -C <worktree>`',
      'Never put a destructive git command after a `cd`',
      'Merge each accepted ticket',
      '`record_row_check`',
      '`row_check_failed`',
      '`get_project`',
      "from that ticket's accepted result",
      'each item the acceptance criteria cover',
      'one squashed commit',
      'increment { branch, commit }',
      'Never accept an acceptance node whose increment failed',
      'named no increment',
      'Claim the acceptance node before you submit the sprint report',
      '`pause_run`',
      '`resume_run`',
      "The retro turns a sprint's leftovers and discoveries into the next sprint's plan",
      '`get_sprint_report`',
      '`redraft_next_sprint`',
      'Size every new ticket',
      "the `covers` criteria of the next sprint's acceptance node",
      '`validate_plan`',
      'the retro and the redraft are ready to approve in one step',
      'Approve retro & redraft',
      'Never edit a sprint the run has passed',
      'Do not add tickets to a running plan yourself, except in the redraft loop',
      'a required ticket that is not accepted',
      'can never be accepted',
      'rolls the adoption back',
      'Adoption is allowed at a checkpoint with no open attempts',
      'Run the acceptance node over what remains',
      'submit a new report revision',
      '`plan_current`',
      'A lost claim response',
      '`claimToken: null`',
      'no replay, not even yours, can recover it',
      'no `claimToken`, and a reason such as "claim response lost"',
      'claim it again with a new `idempotencyKey`; the old key keeps replaying the lost claim',
      'fails with `already_claimed` while its lease is live, `needs_reconciliation` once it has expired, and `run_not_active` while the run is paused',
      'When the project is a folder of Git repositories',
      "create it at that repository's `startCommit`: `git -C <path> branch <name> <startCommit>`",
      "Never switch the branch of a child repository's own checkout",
      'has no branch guard',
      'one set per touched repository',
      "a worktree of its packet's `repository.path`",
      "Squash each touched repository's sprint work onto its epic branch",
      '`increments`, one `{ repo, branch, commit }` per touched repository',
      'Give every ticket added in a retro redraft its `repo`',
      '`claim_kanban_card`',
      '`submit_kanban_card`',
      'Never approve a card'
    ]
  ],
  [
    'worker',
    [
      'one ticket',
      'Stay in scope',
      '`heartbeat_attempt`',
      '`submit_attempt`',
      '`fail_attempt`',
      'commits',
      'changedFiles',
      'checks',
      'Never edit the plan',
      'worktree',
      'sprint integration branch',
      '`git -C <worktree>`',
      'Run only targeted checks',
      'tests for the files you touched',
      'typecheck when you changed types',
      'Never run the full sweep',
      "the sprint's acceptance node",
      '## Discoveries',
      'structured notes',
      'a title and a reason',
      'the reporter can lift',
      'Discoveries:',
      '### Folders of repositories',
      'Work only in a worktree of `repository.path`',
      'run Git as `git -C <worktree>`',
      'report each check as `<repo>: <check>`',
      '`heartbeat_kanban_card`'
    ]
  ],
  [
    'reviewer',
    [
      'independently',
      '`accept_attempt`',
      '`reject_attempt`',
      'actionable',
      'every acceptance criterion',
      "against its own criteria and the worker's targeted evidence",
      'Do not run the full sweep',
      'no per-ticket merge commit on the epic branch',
      'increment',
      'Never accept an acceptance node whose increment failed',
      'in that repository, not in the folder',
      'one increment verdict per touched repository',
      'one set of Definition of Done checks per touched repository'
    ]
  ],
  [
    'sprint-reporter',
    [
      '`accepted`',
      '`failed`',
      '`blocked`',
      '`changes`',
      '`checks`',
      '`risks`',
      '`followUps`',
      '`exitCriteria`',
      '`epicOutcome`',
      '`get_checkpoint`',
      '`advance_sprint`',
      'cannot approve',
      "each repository's increment commit",
      '`<repo>: <check>` names',
      '`report_submitted`, `no_active_leases`, `required_accepted`, `acceptance_accepted`, `increment_merged`, `definition_of_done`, `retro`, `exit_criteria`, `epic_outcome` (final sprint), `plan_current`, and `approval`, in that order',
      'Definition of Done',
      'increment',
      '### The retro',
      '`get_sprint_report`',
      '`tierFacts`',
      '`delivered`',
      '`wentWell`',
      '`wentPoorly`',
      '`tierFit`',
      '`discoveries`',
      '`leftovers`',
      '`actions`',
      'what to look at',
      'Tier-fit verdicts come from the computed facts',
      '`right_sized`',
      '`oversized`',
      '`undersized`',
      '`rejectionCount`',
      '`escalated`',
      'fallback',
      'a title and a reason',
      'the acceptance node never moves',
      '`plan_current`',
      'submit a new report revision',
      'An epic completes when its final checkpoint advances, or when a verified Linear transfer completes it'
    ]
  ],
  [
    'linear-transfer',
    [
      '`get_capabilities`',
      'has not authorized the transfer',
      'press Transfer to Linear in the app',
      '`claude mcp add --transport http linear-server https://mcp.linear.app/mcp`, then `/mcp` to sign in',
      '`codex mcp add linear --url https://mcp.linear.app/mcp`',
      'Cursor',
      'complete it in the browser',
      'ask the person which team to use',
      '## 4. Labels before issues',
      'Reuse a label of the same name',
      'then the milestones in `position` order, then the issues strictly in `position` order, one at a time',
      "search Linear for the item's `marker`",
      'Call `record_transfer_item` right after each creation',
      'Record the project with its `url`',
      'a project recorded without a URL fails verification',
      "list the blocked issue's existing relations, so none is added twice",
      'Set the sort order when a tool allows it',
      '`submit_transfer_readback`',
      '`final: true` on the last part only',
      'triage, backlog, unstarted, started, completed or canceled',
      'None of the others may be completed or canceled',
      'An accepted final part ends the read-back',
      'the stored parts are still cleared',
      'over the per-part size changes nothing, final or not',
      'Never delete anything',
      'read the whole project back again from the start',
      'Never complete the epic any other way',
      '`get_transfer`',
      'call `start_transfer` again with a fresh `idempotencyKey` before you send any read-back part',
      'It discards an unfinished read-back',
      'Continue from `next`'
    ]
  ]
]

describe('skill content requirements', () => {
  it.each(REQUIRED)('%s keeps its required rules', (name, phrases) => {
    const body = name === 'orchestrator' ? [skill(name).body, ...orchestratorFactBodies()].join('\n') : skill(name).body
    const missing = phrases.filter((phrase) => !body.includes(phrase))
    expect(missing).toEqual([])
  })
})

/** Phrases the architecture doc must keep about the retro and the redraft loop. */
const ARCHITECTURE_PHRASES = [
  '### The retro and the redraft loop',
  '`redraft_next_sprint`',
  '`plan_current`',
  'computed `tierFacts`',
  'the one place the orchestrator changes a plan that a run is executing',
  '`approveWithRedraft`',
  'agents can never approve',
  'Approve retro & redraft',
  'rolls all four back',
  '**The acceptance-node limitation.**',
  '`pause_run`',
  'A report goes stale after an adoption'
]

describe('architecture doc', () => {
  it('documents the retro and the redraft loop', () => {
    const text = architecture.replace(/\r\n/g, '\n')
    const missing = ARCHITECTURE_PHRASES.filter((phrase) => !text.includes(phrase))
    expect(missing).toEqual([])
  })
})

const worker = skill('worker').body
const reviewer = skill('reviewer').body
const orchestrator = [skill('orchestrator').body, ...orchestratorFactBodies()].join('\n')
const planner = skill('planner').body
const reporter = skill('sprint-reporter').body
/** The measurement, grade and corrective-work rules of the orchestrator: its `orchestrator.space-*` knowledge facts. */
const ORCHESTRATOR_MEASUREMENT = orchestratorFactBodies('orchestrator.space-').join('\n')

/** DM-192 c1: who records usage, checks evidence, reviews grades and creates corrective drafts, each guide's phrases. */
const ROLE_RULES: [string, string, string[]][] = [
  [
    'the worker records only its own attempt, with its claim token, never estimated',
    markdownSection(worker, 'Measurement'),
    [
      'Usage is recorded by the session that did the work, never estimated',
      '`record_attempt_metrics`, passing your claim token; you may report only your own live attempt',
      'never send 0 or a guess for unknown',
      "When your host's session files are read for the run (the orchestrator does that), report nothing yourself"
    ]
  ],
  [
    'the orchestrator records run usage after each row, relays it or marks it unavailable',
    ORCHESTRATOR_MEASUREMENT,
    ['After each row', '`dm usage` command reads', '`record_attempt_metrics`', '`record_run_metrics` for overhead', 'or mark the usage unavailable', 'Never report 0 or a guess']
  ],
  ['the reviewer records only its own review overhead', markdownSection(reviewer, 'Evidence and grades'), ['`record_run_metrics` (overhead kind review)']],
  [
    "the person's measures stay with the person",
    worker + reporter + orchestrator,
    [
      "Never record a person's rating, rescue time or review time",
      "Satisfaction ratings, rescue time and planned review time are a person's",
      'Ratings, rescue time and planned review time belong to a person in the desktop app'
    ]
  ],
  [
    "the reviewer's per-criterion results are the only verification",
    markdownSection(reviewer, 'Evidence and grades'),
    ['Always pass `criteria` to `accept_attempt`', "The grade reads your per-criterion results, never the worker's", 'never mark a criterion met to avoid that']
  ],
  ["the worker's evidence is a claim", markdownSection(worker, 'Measurement'), ['Your evidence is a claim, not verification']],
  ['the orchestrator verifies only through a review decision', orchestrator, ['Verification comes only from a review decision']],
  ['the reviewer reads grades and never regrades', reviewer, ['never regrade, average letters or fill a missing value']],
  [
    'the orchestrator relays grades, and a grade never bypasses a gate',
    orchestrator,
    ['relay them as returned: never regrade', 'A grade is never a reason to accept, reject, skip a check or bypass a checkpoint']
  ],
  [
    'the sprint reporter quotes the frozen scorecard and writes no grade',
    markdownSection(reporter, 'The scorecard and experiments across revisions'),
    ['`get_report_scorecard`', 'never write a grade, score or letter of your own', '`reassess_report_scorecard`']
  ],
  ['the worker states no grade', worker, ['Never state a grade or a score in your report']],
  [
    'the planner previews and creates DRAFT work, and nothing saves, adopts, starts or approves it',
    markdownSection(planner, 'Corrective work from a retro'),
    [
      '`preview_corrections`',
      '`create_corrections`',
      'writes DRAFT work',
      'Nothing here saves, adopts, starts or approves',
      'A low grade never authorizes work by itself',
      'routed by the person in the desktop app'
    ]
  ],
  [
    'the planner states Fireguard by default for corrective work as the one exception',
    planner,
    ['Never add one by default. The one exception is corrective work created from a retro experiment', 'adds a Fireguard ticket per repository by default']
  ],
  [
    "the planner keeps a person's estimate as the person's",
    planner,
    [
      "Only a person in the desktop app labels a budget as a person's estimate",
      'You may not introduce that label or change the amounts of a budget that carries it',
      'you may replace it with a budget of another basis or clear it'
    ]
  ],
  [
    'the orchestrator writes drafts only, and the person saves, adopts, runs and routes cross-repository work',
    ORCHESTRATOR_MEASUREMENT,
    [
      'turn selected experiments into DRAFT work',
      'the person saves, adopts and runs it with the normal controls',
      'created and routed only by the person in the desktop app',
      '`record_experiment_event`'
    ]
  ],
  [
    'the orchestrator and the sprint reporter restate each kept experiment on resubmission',
    orchestrator + reporter,
    [
      'restate each experiment you keep by its `id` with its original `{ reportId, assessmentId }`',
      'restate it with its `id` and its original source as `{ reportId, assessmentId }`',
      'one resubmitted by its subject gets a new id and leaves its events behind'
    ]
  ],
  ['the worker never accepts', worker, ['never accept or reject work, including your own']],
  ['the reviewer never accepts its own work', reviewer, ['Never accept your own work']],
  ['the orchestrator never accepts its own work and never approves', orchestrator, ['Never accept your own work or a ticket you did yourself', 'You cannot approve checkpoints']],
  ['the sprint reporter cannot approve', reporter, ['You cannot approve a checkpoint']],
  ['the planner cannot approve', planner, ['You cannot approve checkpoints']],
  [
    'the orchestrator records an escaped defect a person tells it of',
    orchestrator,
    ['by you or by a person who tells you of it (the desktop has no control for recording one yet)']
  ],
  [
    'the docs give the MCP route for escaped defects, the desktop command having no control yet',
    spaceGrading + mcpSetup + correctiveWork,
    [
      'no desktop control calls it yet',
      'No desktop control calls `recordEscapedDefects` yet',
      'no desktop control calls that command yet; escaped defects are recorded over MCP with `record_attempt_metrics`',
      'No desktop control yet (the `recordEscapedDefects` command exists for a future one)'
    ]
  ]
]

describe('role guides on measurement, grades and corrective work', () => {
  it.each(ROLE_RULES)('%s', (_rule, text, phrases) => {
    expect(missingPhrases(text, phrases)).toEqual([])
  })
})

const FIREGUARD_EXCEPTION = 'The one exception is corrective work created from a retro experiment'

/** Every guide and delivery-standards copy that tells agents never to add Fireguard by default. */
const FIREGUARD_RULE_SOURCES: [string, string][] = [
  ['skills/planner.md', planner],
  ['skills/graph-planner.md', skill('graph-planner').body],
  ['.cursor/skills/delivery-standards/SKILL.md', cursorStandards],
  ['.claude/skills/delivery-standards/SKILL.md', claudeStandards],
  ['.agents/skills/delivery-standards/SKILL.md', agentsStandards]
]

describe('the Fireguard default rule', () => {
  it.each(FIREGUARD_RULE_SOURCES)('%s states the corrective-work exception on every "never by default" line', (_path, text) => {
    const rules = text.split('\n').filter((line) => /Never add (one|either) by default/.test(line))
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.filter((line) => !line.includes(FIREGUARD_EXCEPTION))).toEqual([])
  })
})

describe('splitSkillSource', () => {
  it('splits the description line from the trimmed body and ends the body with a newline', () => {
    expect(splitSkillSource('Does a thing.\n\n# Title\n\nText.\n\n')).toEqual({
      description: 'Does a thing.',
      body: '# Title\n\nText.\n'
    })
  })

  it('accepts Windows line endings and normalizes them', () => {
    expect(splitSkillSource('Does a thing.\r\n\r\n# Title\r\nText.\r\n')).toEqual({
      description: 'Does a thing.',
      body: '# Title\nText.\n'
    })
  })

  it('ignores leading blank lines and trailing spaces on the description', () => {
    expect(splitSkillSource('\n\nDoes a thing.   \n# T\n').description).toBe('Does a thing.')
  })

  it('rejects a file without a body', () => {
    expect(() => splitSkillSource('Only a description.')).toThrow(/description line followed by a body/)
    expect(() => splitSkillSource('Only a description.\n\n  \n')).toThrow(/description line followed by a body/)
  })

  it('rejects a file that starts with a heading instead of a description', () => {
    expect(() => splitSkillSource('# Title\n\nText.\n')).toThrow(/start with a one-line description/)
  })
})

describe('skillBody', () => {
  it('is the body the MCP prompt of that skill serves', () => {
    for (const item of SKILLS) {
      expect(skillBody(item.name)).toBe(item.body)
    }
  })

  it('refuses a name that is not a shipped skill, so a typo cannot ship an empty guide', () => {
    expect(() => skillBody('orchestrater')).toThrow(/no shipped skill named orchestrater/i)
  })
})
