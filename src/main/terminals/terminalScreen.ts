/**
 * A chat terminal's screen as main keeps it: an `@xterm/headless` terminal the PTY's output is written to, the
 * same size as the PTY, and its `@xterm/addon-serialize` snapshot, so an attach (a switch of chats, a reload, a
 * second window) paints the current screen (`docs/design/chat-shells.md`, question 1, "Several chats").
 *
 * xterm parses what is written later, in batches, and calls each write's callback once that write is on the
 * screen, in the order written. So `write`'s `onScreen` and `snapshot`'s callback run in one sequence: a
 * snapshot holds exactly the writes whose `onScreen` ran before it, and none of the writes after.
 *
 * xterm refuses a write while 50 MB wait to be parsed (a CLI printing faster than the screen parses). Such output
 * is dropped (its `onScreen` never runs), and a snapshot asked for then is taken at once, of what is on the screen,
 * so nothing waits on a callback that will not come.
 */
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'

/** How many lines above the screen are kept for the snapshot. */
const SCROLLBACK_LINES = 5_000

export interface TerminalScreen {
  /** Writes the PTY's output; `onScreen` runs once it is on the screen. */
  write(data: string, onScreen: () => void): void
  resize(cols: number, rows: number): void
  /** Calls `take` with the snapshot once everything written so far is on the screen. */
  snapshot(take: (snapshot: string) => void): void
  dispose(): void
}

export function createTerminalScreen(cols: number, rows: number): TerminalScreen {
  // The serializer reads `terminal.buffer`, which the headless build lists as proposed API.
  const terminal = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true })
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer)
  return {
    write: (data, onScreen) => {
      try {
        terminal.write(data, onScreen)
      } catch {
        // Over xterm's backlog: dropped, see above.
      }
    },
    resize: (newCols, newRows) => {
      terminal.resize(newCols, newRows)
    },
    snapshot: (take) => {
      try {
        terminal.write('', () => {
          take(serializer.serialize())
        })
      } catch {
        take(serializer.serialize())
      }
    },
    dispose: () => {
      terminal.dispose()
    }
  }
}
