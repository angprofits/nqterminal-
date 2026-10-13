// Replay a recorded session through the signal engine: node replay.js ticks/t-YYYY-MM-DD.jsonl
process.env.FORCE_SESSION=process.env.FORCE_SESSION||'REGULAR';process.env.RECORD='0';
const fs=require('fs'),S=require('./server.js');let T=0;Date.now=()=>T;
const lines=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(x=>JSON.parse(x));
S.reset();let last='';
for(const l of lines){T=l.t;for(const s in l.q){const[p,prev,reg,vol]=l.q[s];S.Q[s]={price:p,prev,reg,hi:p,lo:p,vol,provT:T,recvT:T,lat:0};const h=S.H[s]=S.H[s]||[];h.push([T,p]);while(h.length&&T-h[0][0]>330000)h.shift();}
 S.analyze();const m=S.state.analysis.mega;if(m&&m.state!==last){console.log(new Date(T).toISOString(),m.state,'score',m.score,'breakout',m.brk.stage);last=m.state;}}
console.log('alerts raised:',S.state.alerts.length);S.state.alerts.slice().reverse().forEach(a=>console.log(new Date(a.t).toISOString(),a.type));
