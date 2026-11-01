import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withFolder } from './launchSpec'

const FOLDER = resolve('/work/repo')

describe('withFolder', () => {
  it('replaces every argument that is exactly {folder}, and nothing else', () => {
    expect(withFolder(['--cwd', '{folder}', 'x', '{folder}'], FOLDER)).toEqual(['--cwd', FOLDER, 'x', FOLDER])
  })

  it('refuses {folder} inside a longer argument', () => {
    expect(() => withFolder(['--root={folder}'], FOLDER)).toThrow('{folder} must be an argument of its own')
    expect(() => withFolder(['{folder}/sub'], FOLDER)).toThrow('{folder}')
  })
})
