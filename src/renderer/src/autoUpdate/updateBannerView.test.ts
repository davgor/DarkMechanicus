import { describe, expect, it } from 'vitest'
import type { AutoUpdateState } from '../../../shared/autoUpdate/types'
import {
  formatUpdateBannerText,
  shouldHideUpdateBanner,
  shouldShowRestartButton
} from './updateBannerView'

describe('shouldHideUpdateBanner', () => {
  it('hides idle, checking, and error; shows progress phases', () => {
    expect({
      idle: shouldHideUpdateBanner('idle'),
      checking: shouldHideUpdateBanner('checking'),
      error: shouldHideUpdateBanner('error'),
      available: shouldHideUpdateBanner('available'),
      downloading: shouldHideUpdateBanner('downloading'),
      downloaded: shouldHideUpdateBanner('downloaded')
    }).toEqual({
      idle: true,
      checking: true,
      error: true,
      available: false,
      downloading: false,
      downloaded: false
    })
  })
})

describe('shouldShowRestartButton', () => {
  it('shows restart only after download completes', () => {
    expect(shouldShowRestartButton('downloaded')).toBe(true)
    expect(shouldShowRestartButton('downloading')).toBe(false)
    expect(shouldShowRestartButton('available')).toBe(false)
    expect(shouldShowRestartButton('idle')).toBe(false)
  })
})

describe('formatUpdateBannerText', () => {
  it('prefers an explicit message when present', () => {
    const update: AutoUpdateState = {
      phase: 'downloading',
      currentVersion: '1.0.0',
      message: 'Custom progress'
    }
    expect(formatUpdateBannerText(update)).toBe('Custom progress')
  })

  it('formats downloading progress without a message', () => {
    const update: AutoUpdateState = {
      phase: 'downloading',
      currentVersion: '1.0.0',
      downloadPercent: 42
    }
    expect(formatUpdateBannerText(update)).toBe('Downloading update… 42%')
  })

  it('defaults missing download percent to 0', () => {
    const update: AutoUpdateState = {
      phase: 'downloading',
      currentVersion: '1.0.0'
    }
    expect(formatUpdateBannerText(update)).toBe('Downloading update… 0%')
  })

  it('formats available-version copy for non-download phases', () => {
    const update: AutoUpdateState = {
      phase: 'available',
      currentVersion: '1.0.0',
      availableVersion: '2.0.0'
    }
    expect(formatUpdateBannerText(update)).toBe('Update 2.0.0 available')
  })

  it('tolerates a missing available version', () => {
    const update: AutoUpdateState = {
      phase: 'available',
      currentVersion: '1.0.0'
    }
    expect(formatUpdateBannerText(update)).toBe('Update  available')
  })
})
