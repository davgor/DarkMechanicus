/**
 * Named capability profiles are stored as `.darkmechanicus/profiles/<name>.json`, so a profile name
 * must be a file name that is safe on Windows, macOS, and Linux alike: a lowercase slug of 1-64
 * characters that is never a Windows device name (`con.json` cannot exist on Windows).
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/

export const PROFILE_NAME_RULE =
  'Use 1-64 lowercase letters, digits, or hyphens, starting and ending with a letter or digit; device names such as con or nul are not allowed.'

export function isProfileName(name: string): boolean {
  return SLUG_PATTERN.test(name) && !DEVICE_NAME_PATTERN.test(name)
}
