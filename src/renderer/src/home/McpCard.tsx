import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { StorageStatusView } from '../../../shared/domain/views'
import { plural } from '../app/plural'
import { useToasts } from '../app/toasts'
import { Button } from '../components/Button'
import { McpSnippet } from '../components/McpSnippet'
import { mcpFooterLine } from '../sidebar/footerStatus'

interface McpCardProps {
  folder: TrackedFolderView
  status: StorageStatusView | null
}

/** Installs the shipped skills into the folder; reports what was written. */
function SkillInstaller({ folder }: { folder: TrackedFolderView }): JSX.Element {
  const toasts = useToasts()
  const [busy, setBusy] = useState(false)
  const [written, setWritten] = useState<string[] | null>(null)

  const install = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.dm.installSkills(folder.path)
      setWritten(result.written)
      toasts.push('success', `Installed ${plural(result.written.length, 'skill file')}.`)
    } catch (error) {
      toasts.reportError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="skills">
      <h3 className="card-subtitle">Agent skills</h3>
      <p className="note">
        Writes the Dark Mechanicus skills into this repository so agent hosts can plan and run epics. Files are only
        written; nothing is executed.
      </p>
      <Button icon="download" busy={busy} onClick={() => void install()}>
        Install agent skills
      </Button>
      {written === null ? null : (
        <ul className="written-files mono">
          {written.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** How agents reach this folder: live sessions, the MCP config to paste, and skill installation. */
export function McpCard({ folder, status }: McpCardProps): JSX.Element {
  const connection = mcpFooterLine(status)
  return (
    <section className="card" aria-label="MCP connection">
      <h2 className="card-title">MCP connection</h2>
      <p className={`connection tone-${connection.tone}`}>{connection.text}</p>
      <McpSnippet folderPath={folder.path} heading="MCP SERVER CONFIG" />
      <p className="note">The MCP server runs headless, so agents can plan with this window closed.</p>
      <SkillInstaller folder={folder} />
    </section>
  )
}
