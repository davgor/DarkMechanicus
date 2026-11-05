/**
 * Keeps the computer from sleeping while any chat terminal runs (`docs/design/chat-shells.md`, "No idle stop"): an
 * agent's job can run for days, and a computer that goes to sleep pauses every agent on it. Each running PTY holds it
 * (`terminalSessions.ts`). The first hold asks for a `prevent-app-suspension` block (Electron's `powerSaveBlocker`:
 * the system stays awake, the display may still turn off), and the last release gives it back. A release made twice
 * counts once.
 */

/** The part of Electron's `powerSaveBlocker` used here. */
export interface PowerBlocker {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): boolean
}

interface KeepAwake {
  /** Keeps the computer awake until the returned function is called. */
  hold(): () => void
}

export function createKeepAwake(blocker: PowerBlocker): KeepAwake {
  let holds = 0
  let block: number | null = null
  return {
    hold() {
      holds += 1
      block ??= blocker.start('prevent-app-suspension')
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        holds -= 1
        if (holds === 0 && block !== null) {
          blocker.stop(block)
          block = null
        }
      }
    }
  }
}
