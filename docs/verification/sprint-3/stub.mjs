import { connect } from './cdp.mjs'
const port = process.argv[2]
const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())[0]
const c = await connect(t.webSocketDebuggerUrl)
const r = await c.send('Runtime.evaluate', { expression: `(()=>{const {dialog}=process.mainModule.require('electron');globalThis.__dlg=[];dialog.showOpenDialog=async(...a)=>{const o=a[a.length-1];globalThis.__dlg.push(JSON.stringify(o));const p=o.properties||[];return {canceled:false,filePaths:[p.includes('openFile')?'C:/Users/davgo/AppData/Local/omp/omp.exe':(globalThis.__folder||'')]}};dialog.showMessageBox=async(...a)=>{globalThis.__dlg.push('MSG '+JSON.stringify(a[a.length-1]));return {response:0,checkboxChecked:true}};return 'stubbed'})()`, returnByValue: true })
console.log(JSON.stringify(r.result)); c.close(); process.exit(0)
