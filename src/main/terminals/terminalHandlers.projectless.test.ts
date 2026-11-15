import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachRunning, handlersRig, type HandlersRig } from './__mocks__/terminalHandlersRig'

let rig: HandlersRig

beforeEach(() => {
  rig = handlersRig()
})

afterEach(() => {
  rig.cleanup()
})

describe('terminals:attach for a project-less chat', () => {
  it('attaches a project-less chat named by a null folder, and a folder chat by its folder', async () => {
    const summoned = rig.rig.newProjectless()
    const inRepo = rig.rig.newChat()

    expect((await attachRunning(rig, summoned)).answer.state).toBe('running')
    expect((await attachRunning(rig, inRepo)).answer.state).toBe('running')
  })

  it('never reaches a project-less chat through a folder, nor a folder chat through a null folder', async () => {
    const summoned = rig.rig.newProjectless()
    const inRepo = rig.rig.newChat()

    expect(await rig.attach({ folder: rig.rig.repo, chatId: summoned.id })).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(await rig.attach({ folder: null, chatId: inRepo.id })).toMatchObject({ ok: false, error: { code: 'not_found', message: expect.stringContaining('project-less') } })
  })
})
