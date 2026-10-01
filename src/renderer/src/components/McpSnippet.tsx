import { useMcpConfig } from '../app/useMcpConfig'
import { useToasts } from '../app/toasts'
import { Button } from './Button'

interface McpSnippetProps {
  folderPath: string
  /** Eyebrow label shown above the code block, beside the Copy button. */
  heading: string
}

/** The `mcpServers` block for a folder with a Copy button. */
export function McpSnippet({ folderPath, heading }: McpSnippetProps): JSX.Element {
  const toasts = useToasts()
  const state = useMcpConfig(folderPath, toasts.reportError)
  const copy = async (): Promise<void> => {
    if (state.status !== 'ready') return
    try {
      await window.dm.copyText(state.value.json)
      toasts.push('success', 'MCP configuration copied.')
    } catch (error) {
      toasts.reportError(error)
    }
  }
  return (
    <div className="snippet">
      <div className="snippet-head">
        <span className="eyebrow">{heading}</span>
        <Button size="sm" icon="copy" disabled={state.status !== 'ready'} onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      {state.status === 'error' ? (
        <p className="snippet-error">Could not load the MCP configuration.</p>
      ) : (
        <pre className="code-block" tabIndex={0} aria-label="MCP server configuration">
          <code>{state.status === 'ready' ? state.value.json : 'Loading…'}</code>
        </pre>
      )}
      {state.status === 'ready' && state.value.note ? (
        <p className="snippet-note">{state.value.note}</p>
      ) : null}
    </div>
  )
}
