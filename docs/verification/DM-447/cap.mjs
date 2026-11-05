import fs from 'node:fs'
const [port, out] = [process.argv[2], process.argv[3]]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let t
for (let i = 0; i < 60; i++) { try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page'); if (t) break } catch {} await sleep(500) }
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map()
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
await sleep(4000)
await send('Runtime.evaluate', { expression: `(()=>{const d=document.createElement('div');d.id='probe447';d.style.cssText='position:fixed;left:40px;top:40px;width:300px;height:200px;background:#ea4134;z-index:2147483647';document.body.appendChild(d)})()` })
await sleep(800)
const r = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(out, Buffer.from(r.result.data, 'base64'))
const m = await send('Page.getLayoutMetrics'); console.log('dpr/css', JSON.stringify(m.result.cssVisualViewport))
await send('Browser.close')
