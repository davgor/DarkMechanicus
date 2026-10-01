// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useExpansion } from './useExpansion'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(cleanup)

describe('useExpansion defaults', () => {
  it('opens folders and active buckets, collapses completed', () => {
    const { result } = renderHook(useExpansion)
    expect(result.current.isFolderExpanded('/a')).toBe(true)
    expect(result.current.isBucketExpanded('/a', 'in_progress')).toBe(true)
    expect(result.current.isBucketExpanded('/a', 'backlog')).toBe(true)
    expect(result.current.isBucketExpanded('/a', 'completed')).toBe(false)
  })
})

describe('useExpansion toggling', () => {
  it('toggles a folder without touching others', () => {
    const { result } = renderHook(useExpansion)
    act(() => result.current.toggleFolder('/a'))
    expect(result.current.isFolderExpanded('/a')).toBe(false)
    expect(result.current.isFolderExpanded('/b')).toBe(true)
    act(() => result.current.toggleFolder('/a'))
    expect(result.current.isFolderExpanded('/a')).toBe(true)
  })

  it('toggles a bucket per folder', () => {
    const { result } = renderHook(useExpansion)
    act(() => result.current.toggleBucket('/a', 'completed'))
    expect(result.current.isBucketExpanded('/a', 'completed')).toBe(true)
    expect(result.current.isBucketExpanded('/b', 'completed')).toBe(false)
    act(() => result.current.toggleBucket('/a', 'backlog'))
    expect(result.current.isBucketExpanded('/a', 'backlog')).toBe(false)
  })

  it('persists across reloads', () => {
    const first = renderHook(useExpansion)
    act(() => first.result.current.toggleFolder('/a'))
    act(() => first.result.current.toggleBucket('/a', 'completed'))
    first.unmount()
    const { result } = renderHook(useExpansion)
    expect(result.current.isFolderExpanded('/a')).toBe(false)
    expect(result.current.isBucketExpanded('/a', 'completed')).toBe(true)
  })
})

describe('useExpansion reveal', () => {
  it('expands the folder and the bucket', () => {
    const { result } = renderHook(useExpansion)
    act(() => result.current.toggleFolder('/a'))
    act(() => result.current.reveal('/a', 'completed'))
    expect(result.current.isFolderExpanded('/a')).toBe(true)
    expect(result.current.isBucketExpanded('/a', 'completed')).toBe(true)
  })

  it('expands only the folder without a bucket', () => {
    const { result } = renderHook(useExpansion)
    act(() => result.current.toggleFolder('/a'))
    act(() => result.current.reveal('/a', null))
    expect(result.current.isFolderExpanded('/a')).toBe(true)
    expect(result.current.isBucketExpanded('/a', 'completed')).toBe(false)
  })
})
