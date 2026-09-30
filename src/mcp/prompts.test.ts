import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { withRig } from '../test/mcpHarness'
import { createStubApi } from '../test/stubApi'
import { promptName, registerPrompts } from './prompts'
import { SKILLS, type SkillDefinition } from './skills'

function promptServer(skills?: readonly SkillDefinition[]) {
  return () => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    registerPrompts(server, skills)
    return server
  }
}

const FAKE_SKILLS: SkillDefinition[] = [
  { name: 'alpha', title: 'Alpha', description: 'Alpha does A.', body: '# Alpha\n\nDo A.\n' },
  { name: 'beta', title: 'Beta', description: 'Beta does B.', body: '# Beta\n\nDo B.\n' }
]

describe('promptName', () => {
  it('prefixes skill names with darkmechanicus-', () => {
    expect(promptName('planner')).toBe('darkmechanicus-planner')
    expect(promptName('graph-planner')).toBe('darkmechanicus-graph-planner')
  })
})

describe('registerPrompts with the shipped skills', () => {
  it('lists the six skills as prompts with their titles and descriptions', async () => {
    await withRig(promptServer(), createStubApi(), async (rig) => {
      const { prompts } = await rig.client.listPrompts()
      expect(prompts.map((prompt) => prompt.name)).toEqual([
        'darkmechanicus-planner',
        'darkmechanicus-graph-planner',
        'darkmechanicus-orchestrator',
        'darkmechanicus-worker',
        'darkmechanicus-reviewer',
        'darkmechanicus-sprint-reporter'
      ])
      expect(prompts.map((prompt) => prompt.title)).toEqual(SKILLS.map((skill) => skill.title))
      expect(prompts.map((prompt) => prompt.description)).toEqual(SKILLS.map((skill) => skill.description))
    })
  })

  it('returns each skill body as a single user message', async () => {
    await withRig(promptServer(), createStubApi(), async (rig) => {
      for (const skill of SKILLS) {
        const result = await rig.client.getPrompt({ name: promptName(skill.name) })
        expect(result.description).toBe(skill.description)
        expect(result.messages).toEqual([{ role: 'user', content: { type: 'text', text: skill.body } }])
      }
    })
  })

  it('rejects an unknown prompt', async () => {
    await withRig(promptServer(), createStubApi(), async (rig) => {
      await expect(rig.client.getPrompt({ name: 'darkmechanicus-nope' })).rejects.toThrow(/not found/)
    })
  })
})

describe('registerPrompts with injected skills', () => {
  it('registers exactly the given skills', async () => {
    await withRig(promptServer(FAKE_SKILLS), createStubApi(), async (rig) => {
      const { prompts } = await rig.client.listPrompts()
      expect(prompts.map((prompt) => prompt.name)).toEqual(['darkmechanicus-alpha', 'darkmechanicus-beta'])
      const beta = await rig.client.getPrompt({ name: 'darkmechanicus-beta' })
      expect(beta.messages[0]?.content).toEqual({ type: 'text', text: '# Beta\n\nDo B.\n' })
    })
  })

  it('takes no prompt arguments', async () => {
    await withRig(promptServer(FAKE_SKILLS), createStubApi(), async (rig) => {
      const { prompts } = await rig.client.listPrompts()
      expect(prompts.every((prompt) => prompt.arguments === undefined)).toBe(true)
    })
  })
})
