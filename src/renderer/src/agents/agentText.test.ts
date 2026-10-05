import { describe, expect, it } from 'vitest'
import { agentName, AGENT_BLURBS, connectedViaText, phaseText, signInLabel } from './agentText'

describe('agentName', () => {
  it('uses the display names the main process knows each agent by', () => {
    expect(agentName('claude')).toBe('Claude Code')
    expect(agentName('codex')).toBe('Codex')
    expect(agentName('cursor')).toBe('Cursor')
  })
})

describe('AGENT_BLURBS', () => {
  it('gives each agent one line to tell it apart', () => {
    for (const kind of ['claude', 'codex', 'cursor'] as const) {
      expect(AGENT_BLURBS[kind]).not.toBe('')
      expect(AGENT_BLURBS[kind]).not.toContain('\n')
    }
  })
})

describe('signInLabel', () => {
  it('says so while the state is still being checked', () => {
    expect(signInLabel(undefined)).toEqual({ text: 'Checking sign-in…', tone: 'muted' })
  })

  it('names each state in words, with a tone besides', () => {
    expect(signInLabel({ state: 'signed_in', reason: 'ok' })).toEqual({ text: 'Signed in', tone: 'ok' })
    expect(signInLabel({ state: 'signed_out', reason: 'no' })).toEqual({ text: 'Signed out', tone: 'warn' })
    expect(signInLabel({ state: 'unknown', reason: 'huh' })).toEqual({ text: 'Sign-in unknown', tone: 'muted' })
  })
})

describe('connectedViaText', () => {
  it('says how the agent was connected', () => {
    expect(connectedViaText('found')).toBe('Found on this computer')
    expect(connectedViaText('downloaded')).toBe('Downloaded by Dark Mechanicus')
  })
})

describe('phaseText', () => {
  it('asks for the confirmation first', () => {
    expect(phaseText({ phase: 'confirming', percent: null })).toBe('Waiting for your confirmation…')
  })

  it('shows the download percentage when it is known', () => {
    expect(phaseText({ phase: 'downloading', percent: 42 })).toBe('Downloading the installer… 42%')
    expect(phaseText({ phase: 'downloading', percent: null })).toBe('Downloading the installer…')
  })

  it('names every other step', () => {
    expect(phaseText({ phase: 'verifying', percent: null })).toBe('Verifying the download…')
    expect(phaseText({ phase: 'installing', percent: null })).toBe('Running the installer…')
    expect(phaseText({ phase: 'checking', percent: null })).toBe('Checking the installed program…')
    expect(phaseText({ phase: 'done', percent: null })).toBe('Finishing up…')
    expect(phaseText({ phase: 'cancelled', percent: null })).toBe('Cancelled.')
    expect(phaseText({ phase: 'failed', percent: null })).toBe('Stopped.')
  })
})
