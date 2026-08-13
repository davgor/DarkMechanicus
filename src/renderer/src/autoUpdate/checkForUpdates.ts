export function requestCheckForUpdates(
  checkForUpdates: () => Promise<void>
): Promise<void> {
  return checkForUpdates()
}
