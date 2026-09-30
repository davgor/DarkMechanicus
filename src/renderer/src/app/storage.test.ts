import { describe, expect, it } from 'vitest'
import type { KeyValueStore } from './storage'
import { readStored, writeStored } from './storage'

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class BlockedStore implements KeyValueStore {
  getItem(): string | null {
    throw new Error('storage blocked')
  }

  setItem(): void {
    throw new Error('quota exceeded')
  }
}

const isCount = (value: unknown): value is number => typeof value === 'number'

describe('readStored', () => {
  it('returns the fallback when nothing is stored', () => {
    expect(readStored('k', 7, isCount, new MemoryStore())).toBe(7)
  })

  it('returns a stored value that passes validation', () => {
    const store = new MemoryStore()
    store.setItem('k', '42')
    expect(readStored('k', 7, isCount, store)).toBe(42)
  })

  it('falls back when the stored value is not valid JSON', () => {
    const store = new MemoryStore()
    store.setItem('k', '{oops')
    expect(readStored('k', 7, isCount, store)).toBe(7)
  })

  it('falls back when the stored value has the wrong shape', () => {
    const store = new MemoryStore()
    store.setItem('k', '"text"')
    expect(readStored('k', 7, isCount, store)).toBe(7)
  })

  it('falls back when storage is unavailable or throws', () => {
    expect(readStored('k', 7, isCount, null)).toBe(7)
    expect(readStored('k', 7, isCount, new BlockedStore())).toBe(7)
  })
})

describe('writeStored', () => {
  it('stores the JSON encoding of a value', () => {
    const store = new MemoryStore()
    writeStored('k', { a: [1, 2] }, store)
    expect(store.getItem('k')).toBe('{"a":[1,2]}')
  })

  it('overwrites earlier values', () => {
    const store = new MemoryStore()
    writeStored('k', 1, store)
    writeStored('k', 2, store)
    expect(store.getItem('k')).toBe('2')
  })

  it('never throws when storage is unavailable or full', () => {
    expect(() => writeStored('k', 1, null)).not.toThrow()
    expect(() => writeStored('k', 1, new BlockedStore())).not.toThrow()
  })
})
