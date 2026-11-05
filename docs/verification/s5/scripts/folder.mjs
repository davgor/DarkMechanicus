import { connect } from './cdp.mjs'
const port = process.argv[2], dir = process.argv[3]
const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())[0]
const c = await connect(t.webSocketDebuggerUrl)
const r = await c.send('Runtime.evaluate', { expression: `globalThis.__folder=${JSON.stringify(dir)}`, returnByValue: true })
console.log(JSON.stringify(r.result)); c.close(); process.exit(0)
