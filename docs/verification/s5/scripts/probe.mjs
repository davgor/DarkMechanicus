import { page, sleep } from './cdp.mjs'
import fs from 'node:fs'
const c = await page()
await c.send('Runtime.evaluate',{expression:`(()=>{const d=document.createElement('div');d.id='probe';d.style.cssText='position:fixed;left:10px;top:10px;width:300px;height:60px;z-index:99999;background:linear-gradient(90deg,#ea4134 0 20%,#100d0c 20% 40%,#ece6da 40% 60%,#ea4134 60% 80%,#6aa7ff 80%)';document.body.appendChild(d);return 1})()`})
await sleep(400)
const r=await c.send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync('probe.png',Buffer.from(r.result.data,'base64'))
await c.send('Runtime.evaluate',{expression:`document.getElementById('probe').remove()`})
c.close(); process.exit(0)
