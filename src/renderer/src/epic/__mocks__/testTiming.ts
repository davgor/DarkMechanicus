import { configure } from '@testing-library/react'
import { vi } from 'vitest'

/**
 * Component tests render React Flow and whole screens in jsdom. On a busy machine (parallel
 * suites, repeated flakiness runs) a render can take far longer than usual, so give async
 * queries and tests generous headroom; they still finish as soon as the UI is ready.
 */
export function allowSlowRendering(): void {
  configure({ asyncUtilTimeout: 5_000 })
  vi.setConfig({ testTimeout: 30_000 })
}
