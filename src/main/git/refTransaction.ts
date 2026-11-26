/**
 * DM-949: a held `git update-ref --stdin` transaction.
 *
 * `openRefTransaction` starts git, sends `start`, the commands and `prepare`, and resolves once git answers
 * `prepare: ok`. From then on every ref the commands name (and, for an `update HEAD`, both the symbolic HEAD and the
 * branch it names) is locked by its `.lock` file and every expected old value has been verified, so no other Git
 * process can move those refs or switch that HEAD. The transaction stays held until `commit` or `abort`, each of
 * which resolves only once git has actually exited. The transaction has no deadline of its own: the caller ends it
 * after the work it guards has exited. If this process dies, git reads end-of-input and aborts, releasing every lock
 * without changing anything.
 */
import type { GitConversation, GitRunner } from './runner'

interface RefTransactionRequest {
  /** The Git folder (`--absolute-git-dir`) whose HEAD the commands mean. */
  gitDir: string
  message: string
  /** `--no-deref`: `HEAD` names the symbolic ref itself (for `symref-verify`), not the branch it points to. */
  noDeref: boolean
  commands: readonly string[]
}

type Settled = { ok: true } | { ok: false; error: unknown }

interface HeldRefTransaction {
  commit(): Promise<void>
  /** Aborts, changing nothing, and resolves once git has exited. A no-op after `commit` or `abort`. */
  abort(): Promise<void>
}

/** The running `update-ref --stdin`: its stdin, its stdout so far, when it prepared, settled and exited. */
interface Running {
  io: GitConversation | null
  out(): string
  prepared: Promise<boolean>
  settled: Promise<Settled>
  exited: Promise<void>
}

function start(runner: GitRunner, request: RefTransactionRequest): Running {
  let out = ''
  let answer: (prepared: boolean) => void = () => undefined
  const prepared = new Promise<boolean>((resolve) => (answer = resolve))
  let markExited: () => void = () => undefined
  const exited = new Promise<void>((resolve) => (markExited = resolve))
  const running: Running = { io: null, out: () => out, prepared, settled: Promise.resolve({ ok: true }), exited }
  running.settled = runner
    .run({
      cwd: request.gitDir,
      args: ['update-ref', '-m', request.message, ...(request.noDeref ? ['--no-deref'] : []), '--stdin'],
      kind: 'write',
      timeoutMs: null,
      onStdout: (text) => {
        out += text
        if (/^prepare: ok$/m.test(out)) answer(true)
      },
      converse: (io) => {
        running.io = io
        io.write(['start', ...request.commands, 'prepare', ''].join('\n'))
      },
      onExit: () => {
        answer(false)
        markExited()
      }
    })
    .then(
      (): Settled => ({ ok: true }),
      (error: unknown): Settled => ({ ok: false, error })
    )
  return running
}

/** Resolves once the transaction is prepared and held; rejects (after git has exited) when git refused to prepare it. */
export async function openRefTransaction(runner: GitRunner, request: RefTransactionRequest): Promise<HeldRefTransaction> {
  const running = start(runner, request)
  const { settled, exited } = running
  const io = running.io
  if (!(await running.prepared) || io === null) {
    io?.end()
    const outcome = await settled
    await exited
    throw outcome.ok ? new Error(`git update-ref did not prepare the transaction: ${running.out().trim()}`) : outcome.error
  }
  let ended: Promise<Settled> | null = null
  const finish = (command: 'commit' | 'abort'): Promise<Settled> => {
    if (ended === null) {
      io.end(`${command}\n`)
      ended = settled.then(async (outcome) => {
        await exited
        return outcome
      })
    }
    return ended
  }
  return {
    async commit() {
      const outcome = await finish('commit')
      if (!outcome.ok) throw outcome.error
      if (!/^commit: ok$/m.test(running.out())) throw new Error(`git update-ref did not confirm the commit: ${running.out().trim()}`)
    },
    async abort() {
      await finish('abort')
    }
  }
}
