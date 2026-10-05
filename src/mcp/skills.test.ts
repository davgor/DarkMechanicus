import { describe, expect, it } from 'vitest'
import architecture from '../../docs/architecture.md?raw'
import { SKILLS_VERSION } from '../core/version'
import { SKILLS, skillBody, splitSkillSource } from './skills'

const EXPECTED = [
  ['planner', 'Planner'],
  ['graph-planner', 'Graph planner'],
  ['orchestrator', 'Orchestrator'],
  ['worker', 'Worker'],
  ['reviewer', 'Reviewer'],
  ['sprint-reporter', 'Sprint reporter']
]

const VENDOR_WORDS = /claude|anthropic|openai|gpt|gemini|llama|mistral|copilot|codex|sonnet|opus|haiku/i

function skill(name: string) {
  const found = SKILLS.find((candidate) => candidate.name === name)
  if (found === undefined) {
    throw new Error(`missing skill ${name}`)
  }
  return found
}

describe('SKILLS', () => {
  it('ships the six skills in a stable order with their titles', () => {
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

  it('keeps bodies provider neutral', () => {
    for (const item of SKILLS) {
      expect(VENDOR_WORDS.test(item.body)).toBe(false)
      expect(VENDOR_WORDS.test(item.description)).toBe(false)
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
})

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
      'several modules, or one real design choice',
      'should usually be split',
      'Call out micro tasks',
      '`reasoning.effort`',
      'Leave `quality` unset unless the person asked',
      'Precise ticket bodies',
      '## 7. Replan while a run is executing',
      'Edit only future sprints',
      'Never edit a sprint the run has passed',
      'A run does not redo a sprint it has passed',
      '`get_run`',
      'redraft'
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
      'row'
    ]
  ],
  [
    'orchestrator',
    [
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
      "against its own criteria and the worker's targeted evidence",
      'Do not run the full sweep',
      'no per-ticket merge commit on the epic branch',
      '## 3. Integration and the acceptance round',
      'sprint integration branch',
      'separate worktree',
      'Keep the coordinating checkout on the epic branch',
      '`branch_changed`',
      '`git -C <worktree>`',
      'Never put a destructive git command after a `cd`',
      'Merge each accepted ticket',
      'When a row is fully accepted',
      "typecheck plus the tests that touch that row's files",
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
      '### The retro and the redraft',
      '`get_sprint_report`',
      '`redraft_next_sprint`',
      'Size every new ticket',
      "the `covers` criteria of the next sprint's acceptance node",
      '`validate_plan`',
      'the retro and the redraft are ready to approve in one step',
      'Approve retro & redraft',
      'Never edit a sprint the run has passed',
      'Do not add tickets to a running plan yourself, except in the redraft loop',
      '### When the sprint has a required leftover',
      'can never be accepted',
      'rolls the adoption back',
      'Adoption is allowed at a checkpoint with no open attempts',
      'Run the acceptance node over what remains',
      'submit a new report revision',
      '`plan_current`'
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
      'a screenshot only when a criterion needs one',
      'Never run the full sweep',
      "the sprint's acceptance node",
      '## Discoveries',
      'structured notes',
      'a title and a reason',
      'the reporter can lift',
      'Discoveries:'
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
      'Never accept an acceptance node whose increment failed'
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
      'submit a new report revision'
    ]
  ]
]

describe('skill content requirements', () => {
  it.each(REQUIRED)('%s keeps its required rules', (name, phrases) => {
    const body = skill(name).body
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
