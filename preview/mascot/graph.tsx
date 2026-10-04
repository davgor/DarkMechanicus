import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/styles.css'
import { PlanGraph } from '../../src/renderer/src/graph/PlanGraph'
import { buildGraphModel } from '../../src/renderer/src/graph/graphModel'
import { bundle, savedPlan, sprint, ticket } from '../../src/renderer/src/epic/__mocks__/fixtures'
import './preview.css'

const initial = buildGraphModel({
  plan: savedPlan({ bundle: bundle({
    tickets: [ticket('DM-1', 'Build the machine'), ticket('DM-2', 'Check the machine')],
    sprints: [sprint(1, 'Build and check', ['tk_1', 'tk_2'])], edges: []
  }) }),
  mode: 'saved', run: null, statuses: new Map(), outcome: null, rejected: null, draftNumber: 1
})
const firstX = initial.nodes.find((node) => node.id === 'tk_1')?.x ?? 0

function Preview(): JSX.Element {
  const [model, setModel] = useState(initial)
  const [selected, setSelected] = useState<string | null>(null)
  const [shifted, setShifted] = useState(false)
  const [lastDrop, setLastDrop] = useState('none')
  const moveFirst = () => {
    setModel((current) => ({ ...current, nodes: current.nodes.map((node) =>
      node.id === 'tk_1' ? { ...node, x: firstX + (shifted ? 0 : 50) } : node
    ) }))
    setShifted((value) => !value)
  }
  return <main className="preview">
    <h1>Live PlanGraph mascot</h1>
    <p>Real single-sprint PlanGraph and sprite overlay. Pan the canvas, use the zoom controls, drag a ticket, select one, and pause or resume the mascot. This fixture writes no ticket records.</p>
    <button className="preview-fixture-button" onClick={moveFirst}>Move first ticket from model</button>
    <span className="preview-fixture-state">Selected: {selected ?? 'none'} · Last drop: {lastDrop}</span>
    <div className="preview-graph">
      <PlanGraph
        model={model} editable legend="draft" draftNumber={1} selectedTicketId={selected}
        onSelectTicket={setSelected}
        onConnect={() => undefined}
        onDropTicket={(id, top) => setLastDrop(`${id} at ${Math.round(top)}`)}
        onRemoveDependency={() => undefined}
        onAddTicket={() => undefined}
        onAddAcceptance={() => undefined}
      />
    </div>
  </main>
}

createRoot(document.getElementById('root')!).render(<Preview />)
