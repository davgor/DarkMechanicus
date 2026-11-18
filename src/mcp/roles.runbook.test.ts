/**
 * DM-192 c5: the "Tools per role" table of docs/runbooks/mcp-setup.md equals what a session of each role lists, so it
 * is never hand-counted, and the runbook's scorecard and corrective-work tools are served to the roles it names.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import mcpSetup from '../../docs/runbooks/mcp-setup.md?raw'
import type { SessionRole } from '../shared/domain/views'
import { markdownSection } from '../test/markdownSections'
import { withRig } from '../test/mcpHarness'
import { createStubApi } from '../test/stubApi'
import { promptName } from './prompts'
import { createMcpServer } from './server'
import { SKILLS } from './skills'

const INFO = { name: 'darkmechanicus', version: '1.2.3' }
const ROLES: readonly SessionRole[] = ['planner', 'orchestrator', 'worker', 'reviewer']
const LAUNCHES = ROLES.flatMap((role) => [false, true].map((allowSave) => ({ role, allowSave })))
const launchKey = (role: SessionRole, allowSave: boolean): string => `${role}${allowSave ? ' --allow-save' : ''}`

/** The twelve scorecard and metrics reads the runbook says every role lists. */
const SCORE_TOOLS = [
  'get_ticket_grade',
  'get_sprint_grade',
  'get_run_grade',
  'get_epic_grade',
  'get_report_scorecard',
  'reassess_report_scorecard',
  'get_space_signals',
  'get_ticket_performance',
  'get_escaped_defects',
  'get_run_efficiency',
  'get_run_timing',
  'get_metrics_summary'
]

interface TableRow {
  cells: string[]
  /** The tool names the row's first cell gives in backticks. */
  tools: string[]
}

/** The rows of the first table in `markdown` whose header starts with `header`, header and divider excluded. */
function tableRows(markdown: string, header: string): TableRow[] {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.startsWith(header))
  const body = lines.slice(start + 2)
  const end = body.findIndex((line) => !line.startsWith('|'))
  return body.slice(0, end < 0 ? undefined : end).map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    return { cells, tools: [...(cells[0] ?? '').matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1] ?? '') }
  })
}

const TOOLS_SECTION = markdownSection(mcpSetup, 'Tools per role')
const TOOL_ROWS = tableRows(TOOLS_SECTION, '| Tools | planner |')

/** The tools the table grants a role: rows marked `yes` in its column, and `with --allow-save` rows when it is set. */
function documentedTools(role: SessionRole, allowSave: boolean): string[] {
  const column = ROLES.indexOf(role) + 1
  return TOOL_ROWS.filter((row) => {
    const cell = row.cells[column] ?? ''
    return cell === 'yes' || (allowSave && cell.includes('--allow-save'))
  })
    .flatMap((row) => row.tools)
    .sort()
}

const listed = new Map<string, string[]>()

beforeAll(async () => {
  for (const { role, allowSave } of LAUNCHES) {
    const build = (api: Parameters<typeof createMcpServer>[0]) => createMcpServer(api, INFO, { role, allowSave })
    const names = await withRig(build, createStubApi(), async (rig) => (await rig.client.listTools()).tools.map((tool) => tool.name))
    listed.set(launchKey(role, allowSave), names.sort())
  }
})

const live = (role: SessionRole, allowSave = false): string[] => listed.get(launchKey(role, allowSave)) ?? []

describe('the Tools per role table of mcp-setup.md', () => {
  it.each(LAUNCHES)('grants a $role session (allowSave $allowSave) exactly the tools it lists', ({ role, allowSave }) => {
    expect(live(role, allowSave).length).toBeGreaterThan(0)
    expect(documentedTools(role, allowSave)).toEqual(live(role, allowSave))
  })

  it('counts each role in its Total row as the sessions list them', () => {
    const total = TOOL_ROWS.find((row) => row.cells[0] === '**Total**')
    expect(total?.cells.slice(1)).toEqual([
      `${live('planner').length} (${live('planner', true).length} with \`--allow-save\`)`,
      `${live('orchestrator').length} (${live('orchestrator', true).length} with \`--allow-save\`)`,
      String(live('worker').length),
      String(live('reviewer').length)
    ])
  })

  it('states in the Read-only row the number of tools it names', () => {
    const readOnly = TOOL_ROWS.find((row) => row.cells[0]?.startsWith('Read-only ('))
    expect(Number(/^Read-only \((\d+)\)/.exec(readOnly?.cells[0] ?? '')?.[1])).toBe(readOnly?.tools.length)
  })
})

describe('the scorecard and corrective-work tools of mcp-setup.md', () => {
  it('gives every scorecard and metrics read an inputs row, and every role lists each', () => {
    const rows = tableRows(markdownSection(TOOLS_SECTION, 'Scorecards and project metrics'), '| Tool | Inputs |')
    expect(rows.flatMap((row) => row.tools.slice(0, 1))).toEqual(SCORE_TOOLS)
    for (const role of ROLES) {
      expect(SCORE_TOOLS.filter((name) => !live(role).includes(name)), role).toEqual([])
    }
  })

  it('serves each corrective-work tool to exactly the roles its row names', () => {
    const rows = tableRows(markdownSection(TOOLS_SECTION, 'Retro findings, experiments and corrective work'), '| Tool | Roles |')
    expect(rows.map((row) => row.tools[0])).toEqual(['get_retro_findings', 'get_experiment', 'preview_corrections', 'create_corrections', 'record_experiment_event'])
    for (const row of rows) {
      const named = (row.cells[1] ?? '').split('(')[0] ?? ''
      const documented = named.startsWith('every role') ? ROLES : ROLES.filter((role) => named.includes(role))
      expect(ROLES.filter((role) => live(role).includes(row.tools[0] ?? '')), row.tools[0]).toEqual(documented)
    }
  })

  it('points at the Metrics link below the MCP line', () => {
    expect(TOOLS_SECTION).toContain("The desktop's **Metrics** link, directly below the MCP line in the sidebar footer")
  })
})

describe('the prompts mcp-setup.md names', () => {
  it('names every served role guide prompt', () => {
    const names = SKILLS.map((skill) => promptName(skill.name))
    expect(names).toHaveLength(8)
    expect(names.filter((name) => !mcpSetup.includes(`\`${name}\``))).toEqual([])
  })
})
