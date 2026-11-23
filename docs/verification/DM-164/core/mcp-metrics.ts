// DM-164 c17/c18 on the end-to-end two-repository fixture (src/test/spaceLoop.ts through the real commands):
// c18: a reader-role MCP session (as `darkmechanicus-mcp --role reader` serves it) lists only read-only tools, is refused a
//      write, and its ticket, epic, sprint-report and summary reads equal the desktop `dm:command` reads byte for byte;
// c17: get_metrics_summary's totals and grade distribution reconcile with each epic's get_epic_grade; a real legacy
//      folder (a clone of this repository at the sprint start commit, records made before scorecards) shows every epic
//      ungraded.
// Run from the worktree: node --import ./docs/verification/DM-193/raw-hooks.mjs --import tsx docs/verification/DM-164/core/mcp-metrics.ts <root>
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { callTool, withServer } from '../../../../src/test/mcpHarness'
import { complete, correctLocal, report1, requestDm, sprint1, sprint2, sprint3, workDm } from '../../../../src/test/spaceLoop'
import { twoRepoMachine } from '../../../../src/test/twoRepoMachine'
import type { MetricsSummaryView } from '../../../../src/shared/domain/views'

const repo = resolve(import.meta.dirname, '..', '..', '..', '..')
const SPRINT_START = 'fd857e3d37c8ccc9d9ff21086dc203ac8fa5c685'
const rootArg = process.argv[2]
if (rootArg === undefined) throw new Error('usage: mcp-metrics.ts <root>')
const root = resolve(rootArg)
mkdirSync(root, { recursive: true })
let failures = 0
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
}
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

async function main(): Promise<void> {
  const m = twoRepoMachine({ root })
  try {
    const s = await sprint1(m)
    const r = await report1(m, s)
    const c = await correctLocal(m, s, r)
    const req = await requestDm(m, r)
    const w = await workDm(m, req)
    await complete(m.dm, w.ledger.runId, w.reports[1].id)
    const rep2 = await sprint2(m, s, c)
    const rep3 = await sprint3(m, s, c)
    await complete(m.project, s.ledger.runId, rep3.id)
    const { runId } = s.ledger

    await withServer(m.mcp(m.project, 'reader'), async (rig) => {
      // c18: what the reader session is offered.
      const { tools } = await rig.client.listTools()
      const writable = tools.filter((tool) => tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true)
      check('c18 reader tools/list offers no write', tools.length > 0 && writable.length === 0, `${tools.length} tools, all readOnlyHint, none destructive; writable: ${JSON.stringify(writable.map((t) => t.name))}`)
      const names = new Set(tools.map((tool) => tool.name))
      const writes = ['record_attempt_metrics', 'record_run_metrics', 'submit_attempt', 'create_ticket', 'update_plan_draft', 'create_corrections', 'record_escaped_defects']
      check('c18 named write tools absent', writes.every((name) => !names.has(name)), `none of ${writes.join(', ')} listed`)
      const refused = await callTool(rig, 'record_run_metrics', { runId, observations: [] })
      check('c18 a write call is refused', refused.isError === true, JSON.stringify(refused.payload).slice(0, 200))

      const cutoff = m.project.clock.nowIso()
      const reads: [string, string, string, Record<string, unknown>][] = [
        ...Object.entries(s.tickets).map(([name, ticketId]): [string, string, string, Record<string, unknown>] => [`ticket ${name}`, 'get_ticket_grade', 'getTicketGrade', { runId, ticketId, cutoff }]),
        ['epic', 'get_epic_grade', 'getEpicGrade', { epicId: s.epicId, cutoff }],
        ...[r.report.id, rep2.id, rep3.id].map((reportId, i): [string, string, string, Record<string, unknown>] => [`sprint report ${i + 1}`, 'get_report_scorecard', 'getReportScorecard', { reportId }]),
        ['summary', 'get_metrics_summary', 'getMetricsSummary', { until: cutoff }]
      ]
      for (const [label, tool, command, args] of reads) {
        const desktop = await m.bridge.command(m.project.path, command as never, args as never)
        const mcp = await callTool(rig, tool, args)
        const same = desktop.ok && !mcp.isError && isDeepStrictEqual(mcp.payload, plain(desktop))
        const shown = (grade: { letter: string | null; displayScore: string | null; status: string } | undefined) => (grade ? `${grade.letter} ${grade.displayScore} ${grade.status}` : '')
        const data = (mcp.payload as { data: Record<string, never> }).data
        const value =
          tool === 'get_ticket_grade'
            ? shown(data.grade)
            : tool === 'get_epic_grade'
              ? shown(data.grade)
              : tool === 'get_report_scorecard'
                ? shown((data as { scorecard?: { snapshot?: { sprint?: { result?: never } } } }).scorecard?.snapshot?.sprint?.result)
                : `${(data as { epics: unknown[] }).epics.length} epic rows`
        check(`c18 ${label} ${tool} = desktop ${command}`, same, value)
      }

      // c17: the summary against each epic's own grade, and totals/distribution from the rows.
      const summary = (await callTool(rig, 'get_metrics_summary', { until: cutoff })).payload as { data: MetricsSummaryView }
      const view = summary.data
      for (const row of view.epics) {
        const epic = (await callTool(rig, 'get_epic_grade', { epicId: row.epicId, cutoff })).payload as { data: { grade: { letter: string | null; score: number | null; status: string; displayScore: string | null } } }
        const g = epic.data.grade
        check(
          `c17 epic row ${row.title}`,
          row.grade.letter === g.letter && row.grade.score === g.score && row.grade.gradeStatus === g.status,
          `summary ${row.grade.letter} ${row.grade.displayScore} ${row.grade.gradeStatus} = get_epic_grade ${g.letter} ${g.displayScore} ${g.status}; tokens ${row.tokens.total.value} (${row.tokens.total.state}), active ${row.time.activeMs.value} ms`
        )
      }
      const counts = { final: 0, provisional: 0, ungraded: 0 }
      for (const row of view.epics) counts[row.grade.gradeStatus] += 1
      check('c17 distribution by grade status', isDeepStrictEqual(view.distribution.byGradeStatus, counts), `${JSON.stringify(view.distribution.byGradeStatus)} = rows ${JSON.stringify(counts)}; byStatus ${JSON.stringify(view.distribution.byStatus)}`)
      const measured = view.epics.filter((row) => view.totals.measuredEpicIds.includes(row.epicId))
      const sum = (pick: (row: (typeof measured)[number]) => number | null) => measured.reduce((a, row) => a + (pick(row) ?? 0), 0)
      check(
        'c17 totals reconcile with measured epic rows',
        view.totals.tokens.total.value === sum((row) => row.tokens.total.value) && view.totals.time.activeMs.value === sum((row) => row.time.activeMs.value),
        `tokens ${view.totals.tokens.total.value} = Σ rows ${sum((row) => row.tokens.total.value)}; active ${view.totals.time.activeMs.value} ms = Σ rows ${sum((row) => row.time.activeMs.value)}; measured epics ${measured.length} of ${view.epics.length}`
      )
      check('c17 totals equal the ledger (160,000 tokens, 157 min)', view.totals.tokens.total.value === 160_000 && view.totals.time.activeMs.value === 157 * 60_000, `${view.totals.tokens.total.value} tokens, ${view.totals.time.activeMs.value} ms`)
    })

    // c17: a real legacy folder: this repository at the sprint start commit, its .darkmechanicus records made before scorecards.
    const legacy = join(root, 'legacy')
    execFileSync('git', ['clone', '-q', '--no-checkout', repo, legacy])
    execFileSync('git', ['-C', legacy, 'checkout', '-q', '-b', 'legacy-at-sprint-start', SPRINT_START])
    const session = m.openAt(legacy, 'desktop')
    const reconciled = await session.reconcileRepository()
    console.log(`     legacy reconcile: imported ${reconciled.imported.length} record ids, rejected ${JSON.stringify(reconciled.rejected)}`)
    const summary = await session.getMetricsSummary({})
    // Every epic of the legacy folder, with its P component and its full caps (never truncated).
    for (const row of summary.epics) {
      const { grade } = await session.getEpicGrade({ epicId: row.epicId })
      const p = grade.components.find((c) => c.component === 'P')
      console.log(
        `     legacy epic ${row.epicId} [${row.status}] summary ${row.grade.gradeStatus} ${row.grade.letter ?? '-'} ${row.grade.displayScore ?? '-'} reasons ${row.grade.statusReasons.join(',') || 'none'}; get_epic_grade ${grade.status} ${grade.letter ?? '-'}; P ${p?.state} ${p?.score ?? p?.missingReason}`
      )
      if (p !== undefined && p.state !== 'missing') console.log(`       P: ${p.explanation.normalization}`)
      if (grade.caps.length > 0) console.log(`       caps ${JSON.stringify(grade.caps)}`)
      if (p?.diagnostics !== undefined && Object.keys(p.diagnostics).length > 0) console.log(`       P diagnostics ${JSON.stringify(p.diagnostics)}`)
    }
    const statuses = summary.epics.map((row) => row.grade.gradeStatus)
    check(
      'c17 legacy folder: every epic ungraded',
      summary.epics.length > 0 && statuses.every((status) => status === 'ungraded') && summary.epics.every((row) => row.grade.letter === null && row.grade.score === null),
      `${summary.epics.length} epics at ${SPRINT_START.slice(0, 7)}, distribution ${JSON.stringify(summary.distribution.byGradeStatus)}; tokens total ${summary.totals.tokens.total.value} (${summary.totals.tokens.total.state}, ${summary.totals.tokens.total.reason})`
    )
  } finally {
    await m.cleanup()
  }
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
