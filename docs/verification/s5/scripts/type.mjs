// node type.mjs <port> "<text>" [enter]  -- types into the focused terminal over CDP
const [, , port, text, enter] = process.argv
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
let id = 0; const pending = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d) }
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await new Promise((r) => (ws.onopen = r))
await send('Runtime.evaluate', { expression: 'document.querySelector(".xterm-helper-textarea")?.focus()' })
if (text) await send('Input.insertText', { text })
if (enter === '1') { for (const type of ['rawKeyDown','keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type==='rawKeyDown'?'\r':undefined }) }
ws.close(); process.exit(0)
