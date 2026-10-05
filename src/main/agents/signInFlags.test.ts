import { describe, expect, it } from 'vitest'
import type { AgentAuthStatus } from '../../shared/desktop/api'
import { createSignInFlags } from './signInFlags'

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' }
const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'Claude Code reports it is not signed in.' }
const UNKNOWN: AgentAuthStatus = { state: 'unknown', reason: 'Claude Code did not answer in time.' }

describe('sign-in flags', () => {
  it('leaves every status as the CLI said it while nothing is flagged', () => {
    const flags = createSignInFlags()

    for (const status of [SIGNED_IN, SIGNED_OUT, UNKNOWN]) {
      expect(flags.reconcile('claude', status)).toEqual({ status, cleared: false })
    }
    expect(flags.message('claude')).toBeNull()
  })

  it('keeps the CLI words of the agent that was flagged, and no other agent', () => {
    const flags = createSignInFlags()

    flags.markSignedOut('claude', 'Not logged in')

    expect(flags.message('claude')).toBe('Not logged in')
    expect(flags.message('codex')).toBeNull()
    expect(flags.reconcile('codex', SIGNED_IN)).toEqual({ status: SIGNED_IN, cleared: false })
  })

  it('shows signed_out until a sign-in was started and the CLI says signed in', () => {
    const flags = createSignInFlags()
    flags.markSignedOut('claude', 'Not logged in')

    expect(flags.reconcile('claude', SIGNED_IN)).toEqual({ status: { state: 'signed_out', reason: 'Claude Code asked to sign in again.' }, cleared: false })
    flags.signInStarted('claude')
    expect(flags.reconcile('claude', UNKNOWN).status.state).toBe('signed_out')
    expect(flags.reconcile('claude', SIGNED_OUT)).toEqual({ status: SIGNED_OUT, cleared: false })
    expect(flags.reconcile('claude', SIGNED_IN)).toEqual({ status: SIGNED_IN, cleared: true })
    expect(flags.message('claude')).toBeNull()
    expect(flags.reconcile('claude', SIGNED_IN)).toEqual({ status: SIGNED_IN, cleared: false })
  })

  it('needs a new sign-in, and takes the new words, when the agent is found signed out again', () => {
    const flags = createSignInFlags()
    flags.markSignedOut('claude', 'Not logged in')
    flags.signInStarted('claude')

    flags.markSignedOut('claude', 'OAuth token has expired')

    expect(flags.message('claude')).toBe('OAuth token has expired')
    expect(flags.reconcile('claude', SIGNED_IN).cleared).toBe(false)
  })

  it('ignores a sign-in started for an agent that is not flagged', () => {
    const flags = createSignInFlags()

    flags.signInStarted('claude')
    flags.markSignedOut('claude', 'Not logged in')

    expect(flags.reconcile('claude', SIGNED_IN).cleared).toBe(false)
  })
})
