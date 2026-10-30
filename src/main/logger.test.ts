import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
vi.mock('electron-log/main', () => ({
  default: { initialize: vi.fn(), transports: { file: {} }, error: vi.fn() }
}))

import { resolveLogFilePath } from './logger'

const defaults = { defaultDir: '/home/logs/dark-mechanicus', fileName: 'main.log' }
const defaultPath = join('/home/logs/dark-mechanicus', 'main.log')
const isolatedPath = join('/tmp/iso', 'logs', 'main.log')

function resolveWith(argv: string[]): string {
  return resolveLogFilePath({ ...defaults, argv, getUserDataPath: () => '/tmp/iso' })
}

describe('resolveLogFilePath', () => {
  it('writes under <userData>/logs with an explicit --user-data-dir=X', () => {
    expect(resolveWith(['electron', '.', '--user-data-dir=/tmp/iso'])).toBe(isolatedPath)
  })

  it('writes under <userData>/logs with --user-data-dir X', () => {
    expect(resolveWith(['electron', '.', '--user-data-dir', '/tmp/iso'])).toBe(isolatedPath)
  })

  it('keeps the default location without the switch', () => {
    const getUserDataPath = vi.fn(() => '/should/not/use')
    const path = resolveLogFilePath({ ...defaults, argv: ['electron', '.'], getUserDataPath })
    expect(path).toBe(defaultPath)
    expect(getUserDataPath).not.toHaveBeenCalled()
  })

  it('keeps the default for an empty value or a look-alike switch', () => {
    expect(resolveWith(['--user-data-dir='])).toBe(defaultPath)
    expect(resolveWith(['--user-data-dir'])).toBe(defaultPath)
    expect(resolveWith(['--user-data-directory=/x'])).toBe(defaultPath)
  })
})
