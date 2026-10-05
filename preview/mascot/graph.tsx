import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/styles.css'
import { PlanGraph } from '../../src/renderer/src/graph/PlanGraph'
import { buildGraphModel, type GraphModel } from '../../src/renderer/src/graph/graphModel'
import { bundle, edge, execution, runView, savedPlan, sprint, ticket } from '../../src/renderer/src/epic/__mocks__/fixtures'
import './preview.css'

const plan = savedPlan({ bundle: bundle({
  tickets: [
    ticket('DM-1', 'Forge the upper actuator'),
    ticket('DM-2', 'Fit the relay assembly'),
    ticket('DM-3', 'Wire the lower sensor'),
    ticket('DM-4', 'Prepare the foundation')
  ],
  sprints: [sprint(1, 'Build the machine', ['tk_1', 'tk_2', 'tk_3', 'tk_4'])],
  edges: [edge(1, 2), edge(2, 3), edge(3, 4)]
}) })

function previewModel(topComplete: boolean): GraphModel {
  const model = buildGraphModel({
    plan, mode: 'saved',
    run: runView({ activeSprintId: 'sp_1', activeSprintOrdinal: 1,
      tickets: [
        execution('DM-1', 'sp_1', topComplete ? 'accepted' : 'running'),
        execution('DM-2', 'sp_1', 'ready'),
        execution('DM-3', 'sp_1', 'ready'),
        execution('DM-4', 'sp_1', 'running')
      ], rows: [] }),
    statuses: new Map(), outcome: null, rejected: null, draftNumber: 1
  })
  // The dependency rows are real graph layout. A small stagger keeps every card reachable and
  // makes platform-to-platform motion easy to see at preview size.
  return { ...model, nodes: model.nodes.map((node) => node.kind === 'ticket'
    ? { ...node, x: node.x + (node.id === 'tk_2' || node.id === 'tk_4' ? 80 : 0) }
    : node) }
}

function Preview(): JSX.Element {
  const [topComplete, setTopComplete] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [lastDrop, setLastDrop] = useState('none')
  const model = useMemo(() => previewModel(topComplete), [topComplete])
  return <main className="preview">
    <h1>Live PlanGraph mascot</h1>
    <p>Four linked tickets form a climbable stack. The mascot seeks the highest running ticket and drills there; the lower ticket also runs. Watch him use the intermediate tickets, pause to grip, and occasionally slip. Drag the canvas left-right-left by at least 24 pixels per leg to knock him down. A lower ticket catches him; a shake from the lowest ticket reaches the floor. Gentle panning, zoom and Fit View leave him alone.</p>
    <button className="preview-fixture-button" onClick={() => setTopComplete((value) => !value)}>
      {topComplete ? 'Reopen upper task' : 'Complete upper task'}
    </button>
    <span className="preview-fixture-state">Upper task: {topComplete ? 'accepted' : 'running'} · Selected: {selected ?? 'none'} · Last drop: {lastDrop}</span>
    <div className="preview-graph">
      <PlanGraph
        model={model} editable legend="execution" draftNumber={1} selectedTicketId={selected}
        onSelectTicket={setSelected}
        onConnect={() => undefined}
        onDropTicket={(id, top) => setLastDrop(`${id} at ${Math.round(top)}`)}
        onRemoveDependency={() => undefined}
        onAddTicket={() => undefined}
        onAddAcceptance={() => undefined}
        onOpenActivity={() => undefined}
      />
    </div>
  </main>
}

createRoot(document.getElementById('root')!).render(<Preview />)
