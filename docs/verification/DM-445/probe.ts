import { appendFileSync } from 'node:fs'
export default function (pi: any) {
  pi.on('session_start', (ev: any, ctx: any) => {
    const entries = ctx.sessionManager.getEntries()
    appendFileSync(process.env.PROBE_OUT!, JSON.stringify({ ev, hasUI: ctx.hasUI, n: entries.length, types: entries.map((e: any) => e.type + (e.message ? ':' + e.message.role : '')) }) + '\n')
  })
}
