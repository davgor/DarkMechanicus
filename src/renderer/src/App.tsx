import { AppVersionLabel } from './autoUpdate/AppVersionLabel'
import { CheckForUpdatesButton } from './autoUpdate/CheckForUpdatesButton'
import { UpdateBanner, useAppUpdate } from './autoUpdate/UpdateBanner'

export function App(): JSX.Element {
  const update = useAppUpdate()

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>DarkMechanicus</h1>
        <AppVersionLabel version={update.currentVersion} />
      </header>
      <p className="app-lede">A local workspace for tickets, agents, and their dependencies.</p>
      <section className="workspace-preview" aria-label="Development workspace placeholders">
        <article className="workspace-card">
          <span className="workspace-status">Placeholder · tickets</span>
          <h2>Plan the work</h2>
          <p>Start with ticket IDs, descriptions, acceptance criteria, and status.</p>
          <div className="ticket-stages" aria-label="Planned ticket statuses">
            <span>Backlog</span><span>In progress</span><span>Done</span>
          </div>
        </article>
        <article className="workspace-card">
          <span className="workspace-status">Placeholder · agent graph</span>
          <h2>Connect the work</h2>
          <p>Map tickets to agents and make dependencies visible. React Flow is installed.</p>
          <p className="graph-preview">Ticket → Agent → Result</p>
        </article>
        <article className="workspace-card">
          <span className="workspace-status">Placeholder · MCP</span>
          <h2>Expose the tools</h2>
          <p>The MCP SDK and Zod are installed. No server is running or connected yet.</p>
          <p className="workspace-note">Next: list tickets, read a ticket, update status.</p>
        </article>
      </section>
      <section className="app-settings" aria-label="Updates">
        <h2>Updates</h2>
        <CheckForUpdatesButton />
      </section>
      <UpdateBanner />
    </main>
  )
}
