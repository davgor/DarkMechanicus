import type { ComponentType } from 'react'
import { NotificationSettings } from './NotificationSettings'
import './settings.css'

/** One section of the Settings screen: its heading and the form that edits it. */
interface SettingsSection {
  id: string
  title: string
  Component: ComponentType
}

/** The sections, in screen order; each one reads and writes its settings through validated IPC. */
const sections: readonly SettingsSection[] = [
  { id: 'notifications', title: 'Notifications & approvals', Component: NotificationSettings }
]

/** The app-wide Settings screen, opened from the sidebar footer. */
export function SettingsView(): JSX.Element {
  return (
    <section className="settings" aria-labelledby="settings-title">
      <h1 id="settings-title" className="settings-title">
        Settings
      </h1>
      {sections.map(({ id, title, Component }) => (
        <section key={id} className="settings-section" aria-labelledby={`settings-${id}`}>
          <h2 id={`settings-${id}`} className="settings-heading">
            {title}
          </h2>
          <Component />
        </section>
      ))}
    </section>
  )
}
