import { page, sleep } from './cdp.mjs'
const c = await page()
await c.send('Runtime.evaluate',{expression:'document.querySelector(".xterm-helper-textarea")?.focus()'})
for (const type of ['rawKeyDown','keyUp']) await c.send('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8})
c.close(); process.exit(0)
