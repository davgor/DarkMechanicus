import { describe, expect, it } from 'vitest'
import { SKILLS_VERSION } from '../core/version'
import { SKILLS, splitSkillSource } from './skills'

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

  it('uses a semantic skills version', () => {
    expect(SKILLS_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
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
      'NEW epic'
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
      'Explain the graph'
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
      'rationale'
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
      'Never edit the plan'
    ]
  ],
  ['reviewer', ['independently', '`accept_attempt`', '`reject_attempt`', 'actionable', 'every acceptance criterion']],
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
      'cannot approve'
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
