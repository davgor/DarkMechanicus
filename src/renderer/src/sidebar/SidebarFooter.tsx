import { useState } from 'react'
import type { ReactNode } from 'react'
import type { StorageStatusView } from '../../../shared/domain/views'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Menu } from '../components/Menu'
import { useGithub } from '../github/GithubAccount'
import { branchWarning, mcpFooterLine, storageFooterLine } from './footerStatus'

interface SidebarFooterProps {
  status: StorageStatusView | null
  /** True when the selected folder is initialized, i.e. there is something to flush. */
  folderReady: boolean
  busy: { flush: boolean; reconcile: boolean }
  onFlush(): void
  onReconcile(): void
  children?: ReactNode
}

const GITHUB_APPLICATIONS_URL = 'https://github.com/settings/applications'

/** The GitHub account: Sign in to GitHub while signed out, `@login` with an account menu while signed in. */
function GithubLine(): JSX.Element | null {
  const { account, loaded, openSignIn, signOut } = useGithub()
  const [menuOpen, setMenuOpen] = useState(false)
  if (!loaded) {
    return null
  }
  return (
    <div className="footer-line">
      <Icon name="github" size={15} />
      {account === null ? (
        <Button size="sm" onClick={openSignIn}>
          Sign in to GitHub
        </Button>
      ) : (
        <>
          <span className="footer-text footer-grow" title={account.name ?? account.login}>{`@${account.login}`}</span>
          <Menu
            label="GitHub account"
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={[
              { id: 'sign-out', label: 'Sign out', onSelect: signOut },
              { id: 'manage', label: 'Manage access on GitHub', onSelect: () => void window.dm.openExternal(GITHUB_APPLICATIONS_URL) }
            ]}
          />
        </>
      )}
    </div>
  )
}

/** MCP connection, export/commit state with Flush, and the branch-changed warning with Reconcile. */
export function SidebarFooter(props: SidebarFooterProps): JSX.Element {
  const mcp = mcpFooterLine(props.status)
  const storage = storageFooterLine(props.status)
  const warning = branchWarning(props.status)
  return (
    <footer className="sidebar-footer">
      <div className="footer-line">
        <Icon name="plug" size={15} />
        <span className="footer-key">MCP</span>
        <span className={`footer-text tone-${mcp.tone}`}>{mcp.text}</span>
      </div>
      <div className="footer-line">
        <Icon name="export" size={15} />
        <span className={`footer-text footer-grow tone-${storage.tone}`} title={storage.title}>
          {storage.text}
        </span>
        {props.folderReady ? (
          <Button size="sm" busy={props.busy.flush} onClick={props.onFlush}>
            Flush
          </Button>
        ) : null}
      </div>
      <GithubLine />
      {warning === null ? null : (
        <div className="footer-warning">
          <div className="footer-warning-text">
            <Icon name="warning" size={15} />
            <span>{warning}</span>
          </div>
          <Button size="sm" busy={props.busy.reconcile} onClick={props.onReconcile}>
            Reconcile
          </Button>
        </div>
      )}
      {props.children}
    </footer>
  )
}
