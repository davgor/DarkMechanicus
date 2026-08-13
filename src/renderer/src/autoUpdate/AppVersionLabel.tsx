export function formatAppVersionLabel(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}

interface AppVersionLabelProps {
  version: string
}

export function AppVersionLabel(props: AppVersionLabelProps): JSX.Element {
  return (
    <span className="app-version-label" aria-label={`Application version ${props.version}`}>
      {formatAppVersionLabel(props.version)}
    </span>
  )
}
