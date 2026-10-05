import { describe, expect, it } from 'vitest'
import { createEventLog } from './eventLog'

describe('createEventLog', () => {
  it('resolves at once for items that were already heard', async () => {
    const log = createEventLog<string>()
    log.push('a')

    await log.reached(1)

    expect(log.items).toEqual(['a'])
  })

  it('wakes a waiter on the item that reaches its count, not before', async () => {
    const log = createEventLog<string>()
    let woke = false
    const waiting = log.reached(2).then(() => {
      woke = true
    })

    log.push('a')
    await Promise.resolve()
    expect(woke).toBe(false)
    log.push('b')
    await waiting

    expect(woke).toBe(true)
  })

  it('wakes every waiter whose count is reached and keeps the others waiting', async () => {
    const log = createEventLog<number>()
    const reached: number[] = []
    const first = log.reached(1).then(() => reached.push(1))
    const third = log.reached(3).then(() => reached.push(3))

    log.push(1)
    await first
    expect(reached).toEqual([1])
    log.push(2)
    log.push(3)
    await third

    expect(reached).toEqual([1, 3])
  })
})
