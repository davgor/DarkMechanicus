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
      <p className="app-lede">A dark factory desktop shell for coding projects.</p>
      <section className="app-settings" aria-label="Updates">
        <h2>Updates</h2>
        <CheckForUpdatesButton />
      </section>
      <UpdateBanner />
    </main>
  )
}
