import fs from 'node:fs'
export async function connect(url) {
  const ws = new WebSocket(url); let id = 0; const pend = new Map()
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  return { send, close: () => ws.close() }
}
export async function page() {
  const t = (await (await fetch(`http://127.0.0.1:${process.env.CDP}/json`)).json()).find((x) => x.type === 'page')
  return connect(t.webSocketDebuggerUrl)
}
export async function evalIn(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  return r.result?.result?.value ?? r.result
}
export async function shot(c, file) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
