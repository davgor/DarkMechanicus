/**
 * The preview's stand-in for `node:crypto`, which Vite cannot serve to a page. The renderer test fixtures reach
 * `core/canonical.ts` (the sample Linear transfer packet hashes its body); the preview never shows that hash, so a
 * deterministic FNV-1a digest is enough. Not SHA-256, and never part of the app.
 */
export function createHash(_algorithm: string): { update(text: string): { digest(encoding: 'hex'): string } } {
  return {
    update(text) {
      let hash = 0x811c9dc5
      for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
      return { digest: () => (hash >>> 0).toString(16).padStart(8, '0').repeat(8) }
    }
  }
}
