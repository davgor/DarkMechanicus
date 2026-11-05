import { connect } from './cdp.mjs'
const v = await (await fetch(`http://127.0.0.1:${process.argv[2]}/json/version`)).json()
const c = await connect(v.webSocketDebuggerUrl)
c.send('Browser.close'); setTimeout(() => process.exit(0), 1500)
