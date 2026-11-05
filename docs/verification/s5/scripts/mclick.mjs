import { page, sleep } from './cdp.mjs'
const c = await page(); const [x,y]=process.argv.slice(2).map(Number)
for (const type of ['mouseMoved','mousePressed','mouseReleased']) await c.send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1})
await sleep(500); c.close(); process.exit(0)
