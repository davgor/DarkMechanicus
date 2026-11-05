// usage: node cap.js <outprefix> <ms> <cols> <rows> <cwd> -- omp args...   env CAP_SEND='[[ms,"text"],...]'
const pty = require('node-pty'); const fs=require('fs');
const {Terminal}=require('@xterm/headless');
const [out, ms, cols, rows, cwd, , ...args] = process.argv.slice(2);
const env = {...process.env}; env.TERM=process.env.CAP_TERM||'xterm-256color'; env.COLORTERM=process.env.CAP_COLORTERM||'truecolor';
for (const k of (process.env.CAP_UNSET||'').split(',').filter(Boolean)) delete env[k];
const p = pty.spawn('C:/Users/davgo/AppData/Local/omp/omp.exe', args, {name:'xterm-256color', cols:+cols, rows:+rows, cwd, env});
const t0=Date.now(); const chunks=[]; let code=null;
const term=new Terminal({cols:+cols,rows:+rows,allowProposedApi:true,scrollback:1000});
const answers=[]; term.onData(d=>{answers.push(d); p.write(d)});
p.onData(d=>{chunks.push([Date.now()-t0,d]); term.write(d)});
p.onExit(e=>{code=e});
for (const [t,s] of JSON.parse(process.env.CAP_SEND||'[]')) setTimeout(()=>p.write(s),t);
setTimeout(()=>{
  fs.writeFileSync(out+'.raw', chunks.map(c=>c[1]).join(''));
  fs.writeFileSync(out+'.chunks.json', JSON.stringify(chunks.map(c=>[c[0],c[1].length])));
  const b=term.buffer.active; let lines=[]; for(let i=0;i<b.length;i++){lines.push(b.getLine(i).translateToString(true))}
  fs.writeFileSync(out+'.screen.txt', lines.join('\n').replace(/\n+$/,'')+'\n');
  console.log('bytes', chunks.reduce((a,c)=>a+c[1].length,0), 'chunks', chunks.length, 'exit', JSON.stringify(code), 'xtermReplies', JSON.stringify(answers).slice(0,300));
  try{p.kill()}catch{}; setTimeout(()=>process.exit(0),500)}, +ms);
