import { requestCheckForUpdates } from './checkForUpdates'

interface CheckForUpdatesButtonProps {
  disabled?: boolean
  label?: string
}

export function CheckForUpdatesButton(props: CheckForUpdatesButtonProps): JSX.Element {
  const label = props.label ?? 'Check for updates'
  return (
    <button
      type="button"
      className="settings-check-updates"
      disabled={props.disabled}
      onClick={() => {
        void requestCheckForUpdates(() => window.autoUpdate.checkForUpdates())
      }}
    >
      {label}
    </button>
  )
}
