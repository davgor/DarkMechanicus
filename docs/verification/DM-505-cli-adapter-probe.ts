// DM-505 acceptance probe (c4), loaded by the INSTALLED omp with `-e` and no model. It imports the accepted client
// (`dmClient.ts`) from the resource root under test, then drives the real built `dm` CLI through the private
// descriptor main would write: literal stdin JSON with spaces, quotes, shell metacharacters and Unicode, a correlated
// reply and acknowledgement (the agents.md native-tool example), abort and cancelAll of a live child, and the refusal
// paths. Tokens arrive only in the environment; the report records booleans about them, never their values.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const BODY = 'Literal "quoted" it\'s & | ; $(whoami) `id` %PATH% ^! <b>x</b> ü 漢 🚀\nline two\ttab \\ back'

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default async function probe(pi: { on: (event: string, handler: (...args: unknown[]) => void) => void }): Promise<void> {
  const env = process.env
  const root = env['SMOKE_EXTENSION_ROOT'] as string
  const alphaToken = env['DM_SESSION_TOKEN'] ?? ''
  const betaToken = env['SMOKE_BETA_TOKEN'] ?? ''
  const secrets = [alphaToken, betaToken, 'dmg_SENTINEL_dm505_secret']
  const report: Record<string, unknown> = { bun: process.versions['bun'], ompExecPath: process.execPath, platform: process.platform, root }
  pi.on('session_shutdown', () => {})
  const spawns: Record<string, unknown>[] = []
  const pids: (number | undefined)[] = []
  const has = (text: string) => secrets.some((secret) => secret !== '' && text.includes(secret))
  try {
    const dm = await import(pathToFileURL(join(root, 'dmClient.ts')).href)
    const base = dm.nodeDmClientDeps()
    const recording = (label: string, overrides: Record<string, unknown> = {}, onSpawn?: () => void) => ({
      ...base,
      ...overrides,
      spawn: (command: string, args: readonly string[], options: { shell?: boolean; windowsHide?: boolean; cwd?: string; env?: Record<string, string> }) => {
        const child = spawn(command, args as string[], options as never)
        pids.push(child.pid)
        spawns.push({
          label,
          command,
          commandAbsolute: isAbsolute(command),
          args: [...args],
          shell: options.shell,
          windowsHide: options.windowsHide,
          cwd: options.cwd,
          envNames: Object.keys(options.env ?? {}).sort(),
          tokenInArgs: args.some((arg) => has(arg)),
          tokenInEnvAsGrant: options.env?.['DM_SESSION_TOKEN'] !== undefined,
          pid: child.pid
        })
        onSpawn?.()
        return child
      }
    })
    const descriptorPath = env['DM_SKITARII_CLIENT_DESCRIPTOR'] as string
    const descriptorText = readFileSync(descriptorPath, 'utf8')
    report['descriptor'] = { path: descriptorPath, holdsSecret: has(descriptorText), parsed: JSON.parse(descriptorText) }

    const alpha = dm.createDmClient(recording('alpha'))
    const beta = dm.createDmClient(recording('beta', { env: { ...env, DM_SESSION_TOKEN: betaToken } }))
    report['identity'] = await alpha.call('identity', {})
    report['peers'] = await alpha.call('peers', { limit: 10 })
    const peers = report['peers'] as { ok: boolean; data?: { peers: { endpointId: string }[] } }
    const betaId = (await beta.call('identity', {})) as { ok: boolean; data?: { endpointId: string } }
    report['betaIdentity'] = betaId
    const suffix = env['SMOKE_SUFFIX'] ?? ''
    const sent = (await alpha.call('send', { to: betaId.data?.endpointId, clientMessageId: `adapter-1${suffix}`, body: BODY })) as { ok: boolean; data?: { messageId: string } }
    report['send'] = sent
    report['sendRetry'] = await alpha.call('send', { to: betaId.data?.endpointId, clientMessageId: `adapter-1${suffix}`, body: BODY })
    const inbox = (await beta.call('read', { unacknowledgedOnly: true })) as { ok: boolean; data?: { messages: { id: string; body: string; from: { endpointId: string } }[] } }
    const got = inbox.data?.messages.find((m) => m.id === sent.data?.messageId)
    report['readBack'] = { ok: inbox.ok, found: got !== undefined, bodyExact: got?.body === BODY, from: got?.from }
    const alphaId = (report['identity'] as { data?: { endpointId: string } }).data?.endpointId
    // docs/runbooks/agents.md: dm_message_send {"to":"me_alpha","clientMessageId":"reply-1","body":"Done.","inReplyTo":"mm_1"}, then dm_inbox_ack {"messageIds":["mm_1"]}.
    report['docReply'] = await beta.call('send', { to: alphaId, clientMessageId: `reply-1${suffix}`, body: 'Done.', inReplyTo: sent.data?.messageId })
    report['docAck'] = await beta.call('ack', { messageIds: [sent.data?.messageId] })
    report['alphaStatus'] = await alpha.call('status', {})
    report['alphaWake'] = await alpha.call('takeWake', {})
    report['peersSawBeta'] = peers.data?.peers.some((p) => p.endpointId === betaId.data?.endpointId) ?? false

    // Abort a live child shortly after it is spawned (the CLI takes ~250 ms to start, so it is still running).
    const controller = new AbortController()
    const aborting = dm.createDmClient(recording('abort', {}, () => setTimeout(() => controller.abort(), 30)))
    const abortStarted = Date.now()
    report['aborted'] = await aborting.call('status', {}, controller.signal)
    report['abortMs'] = Date.now() - abortStarted
    // cancelAll while a child runs.
    let cancelling: { cancelAll: () => Promise<void> } | null = null
    let cancelOnce = true
    cancelling = dm.createDmClient(
      recording('cancelAll', {}, () => {
        if (!cancelOnce) return
        cancelOnce = false
        setTimeout(() => void cancelling?.cancelAll(), 30)
      })
    )
    report['cancelled'] = await (cancelling as unknown as { call: (c: string, i: unknown) => Promise<unknown> }).call('peers', {})
    report['usableAfterCancelAll'] = await (cancelling as unknown as { call: (c: string, i: unknown) => Promise<unknown> }).call('identity', {})

    // Refusals: a stale token value, an unlisted command, no grant, a missing descriptor. None may echo a secret.
    report['badToken'] = await dm.createDmClient(recording('badToken', { env: { ...env, DM_SESSION_TOKEN: 'dmg_SENTINEL_dm505_secret' } })).call('identity', {})
    report['notAllowed'] = await alpha.call('backup', {})
    const noGrantEnv = { ...env }
    delete noGrantEnv['DM_SESSION_TOKEN']
    report['noGrant'] = await dm.createDmClient(recording('noGrant', { env: noGrantEnv })).call('identity', {})
    report['missingDescriptor'] = await dm
      .createDmClient(recording('missing', { env: { ...env, DM_SKITARII_CLIENT_DESCRIPTOR: descriptorPath.replace(/[^\\/]+\.json$/, '00000000-dead-beef-0000-000000000000.json') } }))
      .call('identity', {})
    const errors = ['badToken', 'notAllowed', 'noGrant', 'missingDescriptor', 'aborted', 'cancelled'].map((key) => JSON.stringify(report[key]))
    report['secretInErrors'] = errors.some((text) => has(text))
    report['secretInArgs'] = spawns.some((s) => s['tokenInArgs'] === true)
    await wait(1500)
    report['pids'] = pids
    report['pidsAliveAfter'] = pids.map(alive)
    report['spawns'] = spawns
  } catch (error) {
    report['error'] = String((error as Error)?.stack ?? error)
  }
  let text = JSON.stringify(report, null, 2)
  for (const secret of secrets) if (secret !== '') text = text.split(secret).join('[secret]')
  writeFileSync(env['SMOKE_OUT'] as string, text)
}
