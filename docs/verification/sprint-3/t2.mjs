import { spawn } from 'node:child_process'
import { connect, sleep, shot } from './cdp.mjs'
const B = '\\'
const S = process.cwd()
const t0 = Date.now()
const env = { ...process.env, DISABLE_AUTO_UPDATE: '1', DARKMECHANICUS_HOME: S+B+'dmhome' }
delete env.ELECTRON_RUN_AS_NODE; delete env.PI_CODING_AGENT_DIR
const child = spawn(S+B+'buildA'+B+'DarkMechanicus.exe', ['--user-data-dir='+S+B+'ud1','--remote-debugging-port=9461','--inspect=9462'], { env, stdio: 'ignore' })
console.log('pid', child.pid)
let c
for (;;) { try { const t=(await (await fetch('http://127.0.0.1:9461/json')).json()).find(x=>x.type==='page'); c=await connect(t.webSocketDebuggerUrl); break } catch { await sleep(100) } }
console.log('page up', Date.now()-t0)
const ev = async (e) => (await c.send('Runtime.evaluate',{expression:e,returnByValue:true})).result?.result?.value
let last=''
for (let i=0;i<400;i++){ const s=String(await ev("(()=>{const t=document.body.innerText;const i=t.indexOf('Skitarii');return i<0?'no card':t.slice(i,i+40).split(String.fromCharCode(10)).join(' | ')})()")); if(s!==last){console.log(Date.now()-t0,'ms',JSON.stringify(s));last=s} if(s.includes('Signed in')) break; await sleep(50)}
console.log('signed-in seen at', Date.now()-t0,'ms after launch')
await shot(c,'c1-01-skitarii-card-signed-in.png')
c.close(); process.exit(0)
