import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SKILLS, type SkillDefinition } from './skills'

const PROMPT_PREFIX = 'darkmechanicus-'

/** MCP prompt name for a shipped skill, for example `darkmechanicus-planner`. */
export function promptName(skillName: string): string {
  return `${PROMPT_PREFIX}${skillName}`
}

/** Exposes each skill as an MCP prompt that returns its Markdown body as one user message. */
export function registerPrompts(server: McpServer, skills: readonly SkillDefinition[] = SKILLS): void {
  for (const skill of skills) {
    server.registerPrompt(
      promptName(skill.name),
      { title: skill.title, description: skill.description },
      () => ({
        description: skill.description,
        messages: [{ role: 'user', content: { type: 'text', text: skill.body } }]
      })
    )
  }
}
