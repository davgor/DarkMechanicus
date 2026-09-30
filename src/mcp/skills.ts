import graphPlannerSource from '../../skills/graph-planner.md?raw'
import orchestratorSource from '../../skills/orchestrator.md?raw'
import plannerSource from '../../skills/planner.md?raw'
import reviewerSource from '../../skills/reviewer.md?raw'
import sprintReporterSource from '../../skills/sprint-reporter.md?raw'
import workerSource from '../../skills/worker.md?raw'

/**
 * A shipped, provider-neutral agent skill. `name` is the stable identifier (MCP prompts are named
 * `darkmechanicus-<name>`; installed skill folders use the same prefix). `description` is one line;
 * `body` is Markdown that starts with the skill's `# <title>` heading and does not repeat the description.
 */
export interface SkillDefinition {
  name: string
  title: string
  description: string
  body: string
}

/**
 * Skill files start with a one-line description, a blank line, and then the Markdown body.
 * The body is returned trimmed and ends with a single newline. CRLF checkouts are normalized.
 */
export function splitSkillSource(source: string): { description: string; body: string } {
  const text = source.replace(/\r\n/g, '\n').trim()
  const newline = text.indexOf('\n')
  if (newline === -1) {
    throw new Error('A skill file needs a one-line description line followed by a body.')
  }
  const description = text.slice(0, newline).trim()
  const body = text.slice(newline + 1).trim()
  if (description.startsWith('#')) {
    throw new Error('A skill file must start with a one-line description, not a heading.')
  }
  return { description, body: `${body}\n` }
}

function defineSkill(name: string, title: string, source: string): SkillDefinition {
  return { name, title, ...splitSkillSource(source) }
}

export const SKILLS: SkillDefinition[] = [
  defineSkill('planner', 'Planner', plannerSource),
  defineSkill('graph-planner', 'Graph planner', graphPlannerSource),
  defineSkill('orchestrator', 'Orchestrator', orchestratorSource),
  defineSkill('worker', 'Worker', workerSource),
  defineSkill('reviewer', 'Reviewer', reviewerSource),
  defineSkill('sprint-reporter', 'Sprint reporter', sprintReporterSource)
]
