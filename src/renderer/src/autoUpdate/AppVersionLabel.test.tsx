import { describe, expect, it } from 'vitest'
import { AppVersionLabel, formatAppVersionLabel } from './AppVersionLabel'

describe('formatAppVersionLabel', () => {
  it('prefixes a semver with v', () => {
    expect(formatAppVersionLabel('0.9.0')).toBe('v0.9.0')
  })

  it('does not double-prefix when version already starts with v', () => {
    expect(formatAppVersionLabel('v1.2.3')).toBe('v1.2.3')
  })
})

describe('AppVersionLabel', () => {
  it('renders the formatted version with an accessible label', () => {
    const node = AppVersionLabel({ version: '0.9.0' })
    expect(node.props.className).toBe('app-version-label')
    expect(node.props['aria-label']).toBe('Application version 0.9.0')
    expect(node.props.children).toBe('v0.9.0')
  })
})
