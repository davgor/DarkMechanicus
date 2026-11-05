import { describe, expect, it } from 'vitest'
import { modifiedEnter, type KeyModes } from './terminalKeys'

const NONE: KeyModes = { win32: false, modifyOtherKeys: false }
const key = (init: Partial<Parameters<typeof modifiedEnter>[0]>): Parameters<typeof modifiedEnter>[0] => ({
  type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...init
})

describe('modifiedEnter', () => {
  it('leaves everything to xterm while the CLI has asked for no keyboard mode', () => {
    expect(modifiedEnter(key({ shiftKey: true }), NONE)).toBeNull()
  })

  it('sends Shift+Enter and Ctrl+Enter as console key records in win32 input mode, press then release', () => {
    expect(modifiedEnter(key({ shiftKey: true }), { ...NONE, win32: true })).toBe('\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_')
    expect(modifiedEnter(key({ ctrlKey: true }), { ...NONE, win32: true })).toBe('\x1b[13;28;13;1;8;1_\x1b[13;28;13;0;8;1_')
  })

  it('sends modifyOtherKeys sequences with the modifier parameter', () => {
    expect(modifiedEnter(key({ shiftKey: true }), { ...NONE, modifyOtherKeys: true })).toBe('\x1b[27;2;13~')
    expect(modifiedEnter(key({ ctrlKey: true, shiftKey: true }), { ...NONE, modifyOtherKeys: true })).toBe('\x1b[27;6;13~')
  })

  it('adds Alt to the modifier of either mode, and every modifier together', () => {
    const win32 = { ...NONE, win32: true }
    const other = { ...NONE, modifyOtherKeys: true }
    expect(modifiedEnter(key({ shiftKey: true, altKey: true }), other)).toBe('\x1b[27;4;13~')
    expect(modifiedEnter(key({ ctrlKey: true, altKey: true }), other)).toBe('\x1b[27;7;13~')
    expect(modifiedEnter(key({ shiftKey: true, ctrlKey: true, altKey: true }), other)).toBe('\x1b[27;8;13~')
    expect(modifiedEnter(key({ shiftKey: true, altKey: true }), win32)).toBe('\x1b[13;28;13;1;18;1_\x1b[13;28;13;0;18;1_')
    expect(modifiedEnter(key({ shiftKey: true, ctrlKey: true, altKey: true }), win32)).toBe('\x1b[13;28;13;1;26;1_\x1b[13;28;13;0;26;1_')
  })

  it('prefers the win32 records when the CLI has switched both modes on', () => {
    expect(modifiedEnter(key({ shiftKey: true }), { win32: true, modifyOtherKeys: true })).toBe('\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_')
  })

  it('ignores a plain Enter, other keys, Cmd, Alt alone and key releases', () => {
    const modes: KeyModes = { win32: true, modifyOtherKeys: true }
    for (const event of [key({}), key({ key: 'a', shiftKey: true }), key({ shiftKey: true, metaKey: true }), key({ altKey: true }), key({ shiftKey: true, type: 'keyup' })]) {
      expect(modifiedEnter(event, modes)).toBeNull()
    }
  })
})
