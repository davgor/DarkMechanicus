/** Shared desktop/host wire limits; larger repair bodies never enlarge naming or credential authority. */
export const DESKTOP_CONTROL_LIMITS = {
  requestBytes: 32_768, namingRequestBytes: 4096, responseBytes: 8192, credentialBytes: 4096
} as const
const encoder = new TextEncoder()
export function serializedCredentialWithinBound(token: string): boolean {
  return encoder.encode(JSON.stringify(token)).byteLength <= DESKTOP_CONTROL_LIMITS.credentialBytes
}
