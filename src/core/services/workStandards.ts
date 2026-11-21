import { z } from 'zod'
import type { Criterion, EpicContent, PlanBundle, SprintDef, TicketContent } from '../../shared/domain/bundle'
import type { Db } from '../db/database'

// The saved plan and submitted evidence are immutable. These per-item requirements travel
// with mutable epic/card state and remain independently visible to an already-leased worker.
const line = z.string().trim().min(1).max(4000)
const testCase = z.strictObject({ startingCondition: line, action: line, expectedResult: line, verificationMethod: line })
export const appliedStandard = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(['epic', 'sprint', 'ticket', 'kanban']),
  revision: z.number().int().positive(),
  disposition: z.enum(['updated', 'compliant', 'follow_up']),
  reason: line,
  workflow: z.enum(['default','custom']).optional(),
  prompt: z.string().min(1).max(65536).optional(),
  source: z.literal('creation').optional(),
  requirements: z.string().min(1).max(32000).optional(),
  tests: z.array(line).max(100).optional(),
  acceptanceCriteria: z.array(line).max(100).optional(),
  testCases: z.array(testCase).max(100).optional(),
  deploymentVerification: line.optional()
})
export type AppliedStandard = z.infer<typeof appliedStandard>
const packedRule = appliedStandard.omit({ prompt: true }).extend({ promptIndex: z.number().int().nonnegative().optional() })
// A project can retain many tickets' workflow decisions under the same 64 KiB prompt.
// Store the text once per containing record. Portable file size limits also bound its arrays.
export const appliedStandards = z.strictObject({
  prompts: z.array(z.string().min(1).max(65536)),
  rules: z.array(packedRule)
}).refine(v => v.rules.every(r => r.promptIndex === undefined || r.promptIndex < v.prompts.length),
  'Every applied prompt must exist in this record.')

export function encodeStandards(rules: AppliedStandard[]): z.infer<typeof appliedStandards> {
  const indices = new Map<string, number>()
  const entries = rules.map(({ prompt, ...rule }) => {
    if (prompt === undefined) return rule
    const index = indices.get(prompt) ?? indices.size
    indices.set(prompt, index)
    return { ...rule, promptIndex: index }
  })
  return appliedStandards.parse({ prompts: [...indices.keys()], rules: entries })
}

export function readStandards(json?: string | null): AppliedStandard[] {
  if (!json) return []
  const data: unknown = JSON.parse(json)
  if (Array.isArray(data)) return z.array(appliedStandard).parse(data)
  const { rules, prompts } = appliedStandards.parse(data)
  return rules.map(({ promptIndex, ...rule }) =>
    promptIndex === undefined ? rule : { ...rule, prompt: prompts[promptIndex] })
}

export function workStandards(db: Db, kind: 'epic' | 'kanban', id: string): AppliedStandard[] {
  const sql = kind === 'epic'
    ? 'SELECT standards_json FROM epics WHERE id = ?'
    : 'SELECT standards_json FROM kanban_cards WHERE id = ?'
  return readStandards(db.get<{standards_json: string | null}>(sql, id)?.standards_json)
}

function requirementsText(rule: AppliedStandard): string {
  const tests = [...(rule.tests ?? []), ...(rule.testCases ?? []).map(t =>
    [t.startingCondition, t.action, t.expectedResult, t.verificationMethod].join(' — '))]
  return [rule.requirements, tests.length ? '## Tests\n' + tests.map(t => '- ' + t).join('\n') : undefined]
    .filter(Boolean).join('\n\n')
}

function withText(original: string, rule: AppliedStandard): string {
  const text = requirementsText(rule)
  return text ? [original, text].filter(Boolean).join('\n\n') : original
}

function criteria<T extends Criterion>(existing: T[], rule: AppliedStandard): (T | Criterion)[] {
  const result: Criterion[] = [...existing]
  for (const [index, text] of (rule.acceptanceCriteria ?? []).entries()) {
    if (!result.some(c => c.text === text)) {
      let number = index + 1
      while (result.some(c => c.id === 'd' + number)) number++
      const id = 'd' + number
      result.push({ id, text })
    }
  }
  return result
}

export function effectiveTicket<T extends Pick<TicketContent, 'body' | 'acceptanceCriteria'>>(item: T, rule?: AppliedStandard): T {
  return rule ? { ...item, body: withText(item.body, rule), acceptanceCriteria: criteria(item.acceptanceCriteria, rule),
    ...(rule.testCases ? { testCases: rule.testCases } : {}) } : item
}

export function effectiveEpic(item: EpicContent, rule?: AppliedStandard): EpicContent {
  return rule ? { ...item, intent: withText(item.intent, rule), successCriteria: criteria(item.successCriteria, rule) } : item
}

export function effectiveSprint(item: SprintDef, rule?: AppliedStandard): SprintDef {
  return rule ? { ...item, goal: withText(item.goal, rule), exitCriteria: criteria(item.exitCriteria, rule),
    ...(rule.deploymentVerification ? { deploymentVerification: rule.deploymentVerification } : {}) } : item
}

export function effectivePlan(db: Db, epicId: string, bundle: PlanBundle): PlanBundle {
  const rules = workStandards(db, 'epic', epicId).filter(r => r.requirements || r.tests?.length || r.acceptanceCriteria?.length || r.testCases?.length || r.deploymentVerification)
  if (!rules.length) return bundle
  const byId = new Map(rules.map(rule => [rule.kind + '/' + rule.id, rule]))
  return { ...bundle, epic: effectiveEpic(bundle.epic, byId.get('epic/' + epicId)),
    tickets: bundle.tickets.map(t => effectiveTicket(t, byId.get('ticket/' + t.id))),
    sprints: bundle.sprints.map(s => effectiveSprint(s, byId.get('sprint/' + s.id))) }
}
