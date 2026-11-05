import { page, evalIn, sleep } from './cdp.mjs'
const c = await page()
const [text, wait] = process.argv.slice(2)
console.log(await evalIn(c, `(()=>{const q=${JSON.stringify(text)};const els=[...document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],li,label')];const e=els.find(x=>(x.getAttribute('aria-label')||x.textContent||'').trim().toLowerCase().startsWith(q.toLowerCase()));if(!e)return 'none: '+els.map(x=>(x.getAttribute('aria-label')||x.textContent||'').trim().slice(0,30)).join(' | ');e.click();return 'clicked '+(e.getAttribute('aria-label')||e.textContent).trim().slice(0,40)})()`))
await sleep(Number(wait??1500))
console.log(await evalIn(c, `document.body.innerText.slice(0,900)`))
c.close(); process.exit(0)
