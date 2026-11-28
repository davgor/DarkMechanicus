import type { BrowserState } from '../../../../shared/browser/browserApi'

const base: BrowserState = {
  folder: null, chatId: 'fixture-chat', enabled: true, owner: 'none', ownerLabel: null, tab: null, signIn: null, pendingOrigin: null
}
const docs = { url: 'http://127.0.0.1:4173/docs/getting-started', title: 'Getting started · Fixture docs', loading: false }

/**
 * The Browser panel's named fixture states, for `FakeBrowser.current` (or `emit`) in tests and the capture preview.
 * `FakeBrowser.state` answers with the asking chat's folder and id, so a state fits any chat.
 */
export const browserScenarios = {
  /** No tab yet, and the person has not let agents use the browser. */
  'browser-empty': { ...base, enabled: false },
  /** An Acolyte drives the agent tab. */
  'browser-agent': { ...base, owner: 'agent', ownerLabel: 'Acolyte:DM-442', tab: docs },
  /** The person took control of the agent tab. */
  'browser-person': { ...base, owner: 'person', ownerLabel: 'You', tab: docs },
  /** The person stopped the agent; the tab stays until they hand it back. */
  'browser-stopped': { ...base, owner: 'stopped', tab: docs },
  /** The person's private tab is open over the agent tab. */
  'browser-private': { ...base, tab: docs, signIn: { url: 'https://example.com/login', title: 'Sign in · Example' } }
} as const satisfies Record<string, BrowserState>

export type BrowserScenarioName = keyof typeof browserScenarios
