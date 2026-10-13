// NQ Market Intelligence Terminal - run: node server.js  (Node 18+), open http://localhost:8787
const http=require('http'),fs=require('fs'),path=require('path');
const NAMES={SPCX:'SpaceX',NVDA:'NVIDIA',PLTR:'Palantir',INTC:'Intel',JPM:'JPMorgan Chase',GOOGL:'Alphabet A',GOOG:'Alphabet C',AMD:'AMD',MU:'Micron',AMZN:'Amazon',MSFT:'Microsoft',META:'Meta',TSLA:'Tesla'};const SYMS={...NAMES};
try{const w=JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR||__dirname,'watch.json'),'utf8'));if(Array.isArray(w)&&w.length>=3){for(const k in SYMS)delete SYMS[k];for(const x of w)if(/^[A-Z][A-Z0-9.\-]{0,9}$/.test(x))SYMS[x]=NAMES[x]||x;}}catch{}
const CFG={pollMs:5000,staleMs:30000,flat:0.0002,consRange:0.0015,minSyncPct:0.7,minMove:0.001,cooldownMs:300000};
const WIN={'10s':10,'30s':30,'1m':60,'3m':180,'5m':300};
const Q={},H={},feed={yahoo:{ok:false,last:0,err:'not polled yet',lat:null},news:{ok:false,last:0,err:'not polled yet'},official:{ok:false,last:0,err:'not polled yet'}};
let news=[],alerts=[],lastAlert={},clients=new Set();
const UA={'User-Agent':'Mozilla/5.0 NQTerminal/1.0'};

async function pollSym(s){
  const t0=Date.now();
  const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1m&range=1d&includePrePost=true`,{headers:UA,signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error('HTTP '+r.status);
  const res=(await r.json()).chart.result[0],m=res.meta,now=Date.now();const cls=res.indicators.quote[0].close||[],ts=res.timestamp||[];let li=-1;cls.forEach((x,i)=>{if(x!=null)li=i;});const last=li>=0?cls[li]:m.regularMarketPrice,lastT=li>=0&&ts[li]?ts[li]*1000:m.regularMarketTime*1000;
  const w=Q[s]&&Q[s].wsT&&now-Q[s].wsT<10000?Q[s]:null;Q[s]={wsT:w?w.wsT:0,price:w?w.price:last,reg:m.regularMarketPrice,prev:m.chartPreviousClose,hi:m.regularMarketDayHigh,lo:m.regularMarketDayLow,vol:m.regularMarketVolume,provT:w?w.provT:lastT,recvT:w?w.recvT:now,lat:w?w.lat:now-t0};
  H[s]=H[s]||[];if(!w)H[s].push([now,last]);
  while(H[s].length&&now-H[s][0][0]>330000)H[s].shift();
}
let polling=false,tickN=0,fails=0,holdUntil=0;async function pollQuotes(){if(polling||Date.now()<holdUntil||(wsOn&&(++tickN%6)))return;polling=true;try{await pollQuotesRaw();record();fails=feed.yahoo.ok?0:fails+1;if(fails)holdUntil=Date.now()+Math.min(60000,5000*2**fails);}finally{polling=false;}}
async function pollQuotesRaw(){
  const res=await Promise.allSettled([...Object.keys(SYMS),'NQ=F',...Object.keys(MACRO)].map(pollSym));
  const bad=res.filter(x=>x.status==='rejected');
  feed.yahoo={ok:bad.length<res.length,last:Date.now(),err:bad.length?`${bad.length}/${res.length} failed: ${bad[0].reason.message}`:null,lat:Math.round(Object.values(Q).reduce((a,q)=>a+q.lat,0)/(Object.keys(Q).length||1))};
  analyze();push();
}
const EARLY=new Set(['2026-11-27','2026-12-24','2027-11-26']);
const HOL=new Set(['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25','2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24']);
function nyMinutes(){if(process.env.FORCE_SESSION)return process.env.FORCE_SESSION;
  const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour12:false,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date());const g=k=>p.find(x=>x.type===k).value;
  const mins=(+g('hour')%24)*60+ +g('minute'),wk=g('weekday');
  if(wk==='Sat'||wk==='Sun')return'CLOSED (weekend)';if(HOL.has(`${g('year')}-${g('month')}-${g('day')}`))return'CLOSED (holiday)';
  if(mins>=240&&mins<570)return'PREMARKET';const cl=EARLY.has(`${g('year')}-${g('month')}-${g('day')}`)?780:960;if(mins>=570&&mins<cl)return'REGULAR';if(mins>=cl&&mins<1200)return'AFTER-HOURS';return'CLOSED';}
function ret(s,sec){const h=H[s];if(!h||h.length<2)return null;const now=Date.now(),tgt=now-sec*1000;let ref=null;for(const[t,p]of h){if(t<=tgt)ref=p;else break;}if(ref==null||now-h[0][0]<sec*1000*0.8)return null;return h[h.length-1][1]/ref-1;}
function rng(s,fromSec,toSec){const now=Date.now(),v=(H[s]||[]).filter(([t])=>now-t<=fromSec*1000&&now-t>=toSec*1000).map(x=>x[1]);if(v.length<5)return null;const hi=Math.max(...v),lo=Math.min(...v);return{hi,lo,r:(hi-lo)/lo};}
let analysis={};
function analyze(){
  const now=Date.now(),rows={},sess=nyMinutes(),closed=sess.startsWith('CLOSED');let fresh=0;
  for(const s in SYMS){const q=Q[s];if(!q){rows[s]={status:'unavailable'};continue;}
    const age=now-q.recvT,provAge=now-q.provT,stale=age>CFG.staleMs;
    const returns={};for(const k in WIN)returns[k]=ret(s,WIN[k]);
    const base=rng(s,300,60),cur=H[s].filter(x=>now-x[0]<=60000).map(x=>x[1]);
    let cons=null,state=closed?'Market closed':'Insufficient data';
    if(base&&!closed){cons=base.r;const p=q.price;
      if(base.r<=CFG.consRange){state=p>base.hi?'Breakout up':p<base.lo?'Breakdown':'Consolidating';}else state=p>base.hi*1.0005?'Above range':p<base.lo*0.9995?'Below range':'In range';}
    rows[s]={price:q.price,reg:q.reg,extPct:q.price/q.reg-1,chg:q.price-q.prev,pct:q.price/q.prev-1,prev:q.prev,hi:q.hi,lo:q.lo,vol:q.vol,returns,state,rangePct:cons,age,provAge,lat:q.lat,
      status:closed?'closed':stale?'stale':(provAge>200000&&sess==='REGULAR'?'delayed?':'live'),src:q.wsT&&now-q.wsT<10000?'Finnhub trades (WS, coverage not verified consolidated)':'Yahoo Finance (unofficial)'};
    if(!stale)fresh++;}
  const sync={};
  for(const k in WIN){let up=0,dn=0,fl=0,na=0;for(const s in rows){const r=rows[s].returns?.[k];if(rows[s].status==='stale'||rows[s].status==='unavailable'||r==null){na++;continue;}if(r>CFG.flat)up++;else if(r<-CFG.flat)dn++;else fl++;}
    const n=up+dn+fl;sync[k]={up,dn,flat:fl,na,agree:n?Math.max(up,dn)/n:0,dir:up>dn?'UP':dn>up?'DOWN':'MIXED',n};}
  const nq=Q['NQ=F'];analysis={rows,sync,fresh,session:sess,t:now,nq:nq?{price:nq.price,pct:nq.price/nq.prev-1,age:now-nq.recvT}:null,spcx:spcxRow(now,closed),macro:(feedWatch(now),jFill(now),rollGuard(now),bars(now),macroRows(now))};stamp();evalMega();
  signal();
}
function signal(){
  if((analysis.session||'').startsWith('CLOSED'))return;
  const a=analysis,s1=a.sync['1m'],s3=a.sync['3m'],now=Date.now();
  if(!s1||s1.n<NEED()){addAlert('INSUFFICIENT DATA',{score:0,met:[],missing:[`Need >=${NEED()} fresh symbols with 1m history (have ${s1?.n||0})`],invalid:'—'},'info');return;}
  const rows=Object.values(a.rows).filter(r=>r.state);
  const nCons=rows.filter(r=>['Consolidating','Breakout up','Breakdown'].includes(r.state)).length/rows.length;
  const dir=s1.dir,avg1=mean(Object.values(a.rows).map(r=>r.returns?.['1m']).filter(x=>x!=null));
  const brk=rows.filter(r=>r.state===(dir==='UP'?'Breakout up':'Breakdown')).length/rows.length;
  const c=[['Directional agreement >= '+CFG.minSyncPct*100+'% (1m)',s1.agree>=CFG.minSyncPct,`${(s1.agree*100).toFixed(0)}% ${dir}`,25],
   ['Mean 1m move >= '+CFG.minMove*100+'%',Math.abs(avg1)>=CFG.minMove,(avg1*100).toFixed(3)+'%',20],
   ['3m agrees with 1m direction',s3.dir===dir&&s3.agree>=0.6,`${(s3.agree*100).toFixed(0)}% ${s3.dir}`,15],
   ['Prior group consolidation (>=40% of stocks)',nCons>=0.4,(nCons*100).toFixed(0)+'%',20],
   ['Range break in signal direction (>=30%)',brk>=0.3,(brk*100).toFixed(0)+'%',20]];
  const score=c.reduce((x,[,ok,,w])=>x+(ok?w:0),0);
  const met=c.filter(x=>x[1]).map(x=>`${x[0]}: ${x[2]}`),missing=c.filter(x=>!x[1]).map(x=>`${x[0]}: ${x[2]}`);
  missing.push('Volume confirmation: unavailable (cumulative delayed-source volume only)');
  const lead=Object.entries(a.rows).filter(([,r])=>r.returns?.['1m']!=null).sort((x,y)=>Math.abs(y[1].returns['1m'])-Math.abs(x[1].returns['1m'])).slice(0,3).map(x=>x[0]);
  const hasNews=news.some(n=>now-n.t<1800000&&n.tickers.length);
  let type=null;
  if(score>=80&&s1.agree>=CFG.minSyncPct)type=dir==='UP'?'POTENTIAL STRONG BUY SETUP':'POTENTIAL STRONG SELL SETUP';
  else if(score>=40&&s1.agree>=CFG.minSyncPct&&Math.abs(avg1)>=CFG.minMove)type=dir==='UP'?'SYNCHRONIZED MOVE UP':'SYNCHRONIZED MOVE DOWN';
  else if(nCons>=0.6)type='GROUP CONSOLIDATION DETECTED';
  if(type)addAlert(type,{score,met,missing,lead,news:hasNews,invalid:dir==='UP'?'1m agreement falls below 50% or price re-enters prior range':'1m agreement falls below 50% or price re-enters prior range',data:`${a.fresh}/19 fresh; Yahoo poll ~${feed.yahoo.lat}ms; coverage/volume not consolidated-tape verified`},type.includes('BUY')||type.includes('UP')?'up':type.includes('SELL')||type.includes('DOWN')?'down':'info');
}
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function addAlert(type,d,tone,cd){const now=Date.now();if(lastAlert[type]&&now-lastAlert[type]<(cd??CFG.cooldownMs))return;lastAlert[type]=now;alerts.unshift({id:now,t:now,type,tone,...d});alerts=alerts.slice(0,100);jAdd(alerts[0]);notify(alerts[0]);}

// ---- News (Google News RSS; secondary reporting, not original posts) ----
const FEEDS=[['SpaceX','SpaceX OR Starship OR Starlink OR SPCX'],['Statements','Trump said OR "Truth Social" OR Powell said OR Bessent said'],['CEOs','"Jensen Huang" OR "Lisa Su" OR "Tim Cook" OR "Satya Nadella" OR Zuckerberg says'],['Watchlist','NVIDIA OR AMD OR Micron OR Broadcom OR Intel stock'],['Tech/Mega-cap','Apple OR Microsoft OR Amazon OR Meta OR Alphabet OR Tesla stock'],['Trump','Trump tariffs OR China OR semiconductor OR "Federal Reserve"'],['Fed/Macro','Federal Reserve OR CPI OR jobs report OR Treasury yields'],['Semis/AI','semiconductor export OR AI chips OR data center'],['Geopolitics','sanctions OR Taiwan OR Middle East markets']];
const KEY=/nvidia|nvda|amd|micron|broadcom|intel|apple|microsoft|amazon|meta\b|alphabet|google|tesla|walmart|cisco|palantir|applied materials|lam research|costco|palo alto/i;
const ALIAS={JPM:/JPMorgan|JP Morgan|Jamie Dimon/,SPCX:/SpaceX|Starship/,NVDA:/NVIDIA|Nvidia/,AAPL:/\bApple\b/,MSFT:/Microsoft/,MU:/Micron/,AMD:/Advanced Micro Devices/,AMZN:/Amazon/,META:/\bMeta\b|Facebook/,GOOGL:/Alphabet|Google/,GOOG:/Alphabet|Google/,TSLA:/Tesla/,AVGO:/Broadcom/,INTC:/\bIntel\b/,WMT:/Walmart/,CSCO:/Cisco/,PLTR:/Palantir/,AMAT:/Applied Materials/,LRCX:/Lam Research/,COST:/Costco/,PANW:/Palo Alto/};
function tickersIn(t,ci){const o=[];for(const s in SYMS){const a=ALIAS[s]||/$^/;if(new RegExp('\\b'+s+'\\b').test(t)||(ci?new RegExp(a.source,'i'):a).test(t))o.push(s);}
  if(/\bsemiconductors?\b|\bchips?\b|export controls?/i.test(t))for(const s of['NVDA','AMD','INTC','MU','AVGO','AMAT','LRCX'])if(SYMS[s]&&!o.includes(s))o.push(s);return[...new Set(o)];}
function cat(t){return/\bTrump\b|White House|Bessent|tariff/i.test(t)?'Trump/Policy':/\bFed\b|Federal Reserve|Powell|\bCPI\b|inflation|Treasury yield|jobs report|payrolls?/i.test(t)?'Fed/Macro':/earnings|guidance/i.test(t)?'Earnings':/upgrade|downgrade|price target/i.test(t)?'Analyst':(/\bsemiconductors?\b|\bchips?\b/i.test(t)||/\bAI\b/.test(t))?'Semis/AI':'General';}
const dec=s=>s.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
async function pollNews(){
  let ok=0,err=null;
  for(const[lab,q]of FEEDS){try{
    const r=await fetch('https://news.google.com/rss/search?q='+encodeURIComponent(q+' when:1d')+'&hl=en-US&gl=US&ceid=US:en',{headers:UA,signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('HTTP '+r.status);const x=await r.text();ok++;
    for(const it of x.split('<item>').slice(1,16)){const g=k=>(it.match(new RegExp(`<${k}[^>]*>([\\s\\S]*?)</${k}>`))||[])[1];
      const title=dec(g('title')||'').trim(),link=dec(g('link')||''),src=dec(g('source')||'Google News'),pub=Date.parse(g('pubDate'));
      const key=title.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,60);
      if(!title||news.some(n=>n.key===key))continue;
      news.push({key,title,link,src,t:pub||Date.now(),det:Date.now(),tickers:tickersIn(title),cat:cat(title),feed:lab,secondary:true,speaker:(title.match(SPK)||[])[0]||null});}
  }catch(e){err=e.message;}}
  news.sort((a,b)=>b.t-a.t);news=news.slice(0,300);
  feed.news={ok:ok>0,last:Date.now(),err:ok<FEEDS.length?`${FEEDS.length-ok} feeds failed: ${err}`:null};push();
}
const SPK=/Trump|White House|Powell|Bessent|Lutnick|Greer|Jensen Huang|Lisa Su|Satya Nadella|Tim Cook|Zuckerberg|Andy Jassy|Elon Musk|Sundar Pichai|Lagarde|Waller|Bowman/i;
const SX=/SpaceX|Starship|Starlink|Falcon ?9|\bSPCX\b/i;
function stamp(){const now=Date.now();for(const n of news){
  if(n.base===undefined){n.old=now-n.t>900000;n.base=(n.old||!n.tickers.length)?null:Object.fromEntries(n.tickers.filter(t=>Q[t]).map(t=>[t,Q[t].price]));}
  if(n.sx===undefined)n.sx=SX.test(n.title);
  if(n.sx&&!n.old&&!n.sxA){n.sxA=true;addAlert('SPACEX NEWS',{score:null,met:[n.title+' ('+n.src+')'],missing:[],invalid:'n/a (news item; '+(n.secondary?'secondary report':'official source')+')',data:'Published '+new Date(n.t).toISOString()},'info',0);}
  if(n.base&&now-n.det<1800000){const r=Object.entries(n.base).map(([t,b])=>Q[t]?Q[t].price/b-1:null).filter(x=>x!=null);
    if(r.length){const m=mean(r);n.react={mean:m,agree:r.filter(x=>Math.sign(x)===Math.sign(m)).length/r.length,min:Math.round((now-n.det)/60000)};}}}}
async function pollOfficial(){
  const L=[['White House','https://www.whitehouse.gov/feed/','Trump/Policy',false],['Federal Reserve','https://www.federalreserve.gov/feeds/press_all.xml','Fed/Macro',false],['SEC 8-K','https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=100&output=atom','SEC Filing',true]];
  let ok=0,err=null;
  for(const[src,url,c0,needT]of L){try{
    const r=await fetch(url,{headers:{'User-Agent':'NQTerminal '+(process.env.SEC_CONTACT||'personal-use contact@localhost')},signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error(src+' HTTP '+r.status);const x=await r.text();ok++;
    for(const it of x.split(/<item>|<entry>/).slice(1,40)){
      const g=k=>(it.match(new RegExp(`<${k}[^>]*>([\\s\\S]*?)</${k}>`))||[])[1];
      const title=dec(g('title')||'').trim(),link=dec(g('link')||(it.match(/<link[^>]*href="([^"]+)"/)||[])[1]||''),pub=Date.parse(g('pubDate')||g('updated')),tk=tickersIn(title,needT);
      const key=(src+title).toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,70);
      if(!title||(needT&&!tk.length)||news.some(n=>n.key===key))continue;
      news.push({key,title,link,src,t:pub||Date.now(),det:Date.now(),tickers:tk,cat:c0,feed:'Official',secondary:false,speaker:(title.match(SPK)||[])[0]||null});}
  }catch(e){err=e.message;}}
  news.sort((a,b)=>b.t-a.t);news=news.slice(0,300);
  feed.official={ok:ok>0,last:Date.now(),err:ok<L.length?`${L.length-ok} of ${L.length} failed: ${err}`:null};push();
}
// ---- JOURNAL, RECORDING, CALENDAR, TIME-OF-DAY, NOTIFICATIONS, LEAD-LAG, WEIGHTS, SAFETY ----
const DATA=process.env.DATA_DIR||__dirname,startT=Date.now();let okAt=startT,journal=[],jSaveT=0;
try{journal=JSON.parse(fs.readFileSync(path.join(DATA,'journal.json'),'utf8'));}catch{}
const jSave=()=>{try{fs.writeFileSync(path.join(DATA,'journal.json'),JSON.stringify(journal.slice(0,500)))}catch{}};
function jAdd(a){const nq=Q['NQ=F'];if(!a||!nq||/SPACEX|FEED DOWN|INSUFFICIENT/.test(a.type))return;journal.unshift({id:a.id,t:a.t,type:a.type,tone:a.tone,nq0:nq.price,r:{}});journal=journal.slice(0,500);}
function jFill(now){const nq=Q['NQ=F'];if(!nq||now-nq.recvT>CFG.staleMs)return;let ch=false;for(const j of journal.slice(0,200))for(const[m,ms]of[[1,60000],[5,300000],[15,900000]])if(j.r[m]==null&&now-j.t>=ms&&now-j.t<ms+120000){j.r[m]=nq.price/j.nq0-1;ch=true;}if(ch&&now-jSaveT>30000){jSaveT=now;jSave();}}
function jStats(){const g={};for(const j of journal){const x=g[j.type]=g[j.type]||{type:j.type,n:0,s5:[],hit:[]};x.n++;const sg=j.tone==='up'?1:j.tone==='down'?-1:0;if(j.r[5]!=null){x.s5.push(sg?sg*j.r[5]:j.r[5]);if(sg)x.hit.push(Math.sign(j.r[5])===sg?1:0);}}return Object.values(g).map(x=>({type:x.type,n:x.n,avg5:x.s5.length?mean(x.s5):null,hit:x.hit.length?mean(x.hit):null}));}
function notify(a){const t=process.env.NTFY_TOPIC;if(!t||!a||(a.tone==='info'&&!/CONFIRMED|ALIGNMENT|SPACEX|FEED DOWN/.test(a.type)))return;fetch('https://ntfy.sh/'+encodeURIComponent(t),{method:'POST',body:(a.met&&a.met[0])||a.type,headers:{Title:a.type}}).catch(()=>{});}
function record(){if(process.env.RECORD==='0')return;try{const q={};for(const k in Q)q[k]=[Q[k].price,Q[k].prev,Q[k].reg,Q[k].vol];const dir=path.join(DATA,'ticks');fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(path.join(dir,'t-'+new Date().toISOString().slice(0,10)+'.jsonl'),JSON.stringify({t:Date.now(),q})+'\n');if(Math.random()<0.01){const fl=fs.readdirSync(dir).sort();while(fl.length>5)fs.unlinkSync(path.join(dir,fl.shift()));}}catch{}}
function feedWatch(now){if(feed.yahoo.ok&&feed.yahoo.last)okAt=now;else if(now-okAt>180000&&!(analysis.session||'').startsWith('CLOSED'))addAlert('DATA FEED DOWN',{score:null,met:['Yahoo quotes failing for '+Math.round((now-okAt)/60000)+' min: '+(feed.yahoo.err||'')],missing:[],invalid:'n/a',data:''},'info',900000);}
const RL=new Map(),ipOf=q=>String(q.headers['x-forwarded-for']||q.socket.remoteAddress||'').split(',')[0].trim();
function limited(ip,max){const m=Math.floor(Date.now()/60000),e=RL.get(ip);if(!e||e.m!==m){RL.set(ip,{m,c:1});if(RL.size>5000)RL.clear();return false;}return ++e.c>max;}
function body(q,fn){let b='';q.on('data',c=>{b+=c;if(b.length>4000)q.destroy();});q.on('end',()=>{let j=null;try{j=JSON.parse(b||'{}');}catch{}fn(j);});}
function etUtc(y,mo,d,h,mi){let g=Date.UTC(y,mo-1,d,h+5,mi);const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit'}).formatToParts(new Date(g));let diff=h-(+p.find(x=>x.type==='hour').value%24);if(diff>12)diff-=24;if(diff<-12)diff+=24;return g+diff*3600000;}
const nthFri=(y,mo,n)=>1+(5-new Date(Date.UTC(y,mo-1,1)).getUTCDay()+7)%7+7*(n-1);
const FOMC=['2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16','2026-10-28','2026-12-09'];
const parseEv=x=>{const m=String(x).match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)\s*\|\s*(.{1,80})$/);return m?{s:String(x),t:etUtc(+m[1],+m[2],+m[3],+m[4],+m[5]),label:m[6].trim()}:null;};
const CUSTOM=[];let fileEv=[];try{fileEv=JSON.parse(fs.readFileSync(path.join(DATA,'events.json'),'utf8'));}catch{}
for(const x of[...(process.env.CAL_EVENTS||'').split(';'),...fileEv]){const e=x&&parseEv(String(x).trim());if(e)CUSTOM.push(e);}
const saveEv=()=>{try{fs.writeFileSync(path.join(DATA,'events.json'),JSON.stringify(CUSTOM.map(c=>c.s)))}catch{}};
let evC={k:-1,v:[]};
function events(now){const k=Math.floor(now/3600000);if(evC.k!==k){const o=[],d0=new Date(now);for(let i=0;i<4;i++){const y=d0.getUTCFullYear()+Math.floor((d0.getUTCMonth()+i)/12),mo=(d0.getUTCMonth()+i)%12+1;
  o.push({t:etUtc(y,mo,nthFri(y,mo,3),16,0),label:mo%3===0?'Quarterly options expiry + Nasdaq-100 rebalance + NQ expiry (verify roll date)':'Monthly options expiry'});o.push({t:etUtc(y,mo,nthFri(y,mo,1),8,30),label:'Jobs report (usually 1st Friday; verify)'});}
  for(const d of FOMC){const[y,m,dd]=d.split('-').map(Number);o.push({t:etUtc(y,m,dd,14,0),label:'FOMC decision (published schedule; verify)'});}evC={k,v:o};}
  return[...evC.v,...CUSTOM.map(c=>({t:c.t,label:c.label,custom:c}))].sort((a,b)=>a.t-b.t);}
const calendar=now=>events(now).filter(e=>e.t>now-3600000&&e.t<now+14*864e5).slice(0,14).map(e=>({t:e.t,label:e.label,soon:Math.abs(e.t-now)<3600000,idx:e.custom?CUSTOM.indexOf(e.custom):null}));
const eventWindow=now=>{const e=events(now).find(e=>!/^EARN:/i.test(e.label)&&now>=e.t-900000&&now<=e.t+1800000);return e?{label:e.label,add:5}:{label:null,add:0};};
const earnOut=(s,now)=>CUSTOM.some(c=>{const m=c.label.match(/^EARN:\s*([A-Z.]+)/i);return m&&m[1].toUpperCase()===s&&now>=c.t-3600000&&now<=c.t+72000000;});
function tod(){const f=process.env.FORCE_TOD,p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'}).formatToParts(new Date()),m=(+p.find(x=>x.type==='hour').value%24)*60+ +p.find(x=>x.type==='minute').value,sess=analysis.session||'';
  const lab=f||(sess==='PREMARKET'||sess==='AFTER-HOURS'?'EXTENDED HOURS':m>=570&&m<580?'OPEN (first 10 min)':m>=690&&m<780?'MIDDAY LULL':m>=930&&m<960?'CLOSE (last 30 min)':'NORMAL');return{lab,add:{'EXTENDED HOURS':10,'OPEN (first 10 min)':10,'MIDDAY LULL':5}[lab]||0};}
function pear(x,y){const n=x.length;if(n<8)return{r:null,n};const mx=mean(x),my=mean(y);let a=0,b=0,c=0;for(let i=0;i<n;i++){a+=(x[i]-mx)*(y[i]-my);b+=(x[i]-mx)**2;c+=(y[i]-my)**2;}return{r:b&&c?a/Math.sqrt(b*c):null,n};}
function lagc(s,L,W,now){const mn=Math.floor(now/60000),A=BM[s],B=BM['NQ=F'];if(!A||!B)return{r:null,n:0};const x=[],y=[];for(let m=mn-W+1;m<=mn-Math.max(L,0);m++)if(A[m]&&A[m-1]&&B[m+L]&&B[m+L-1]){x.push(A[m]/A[m-1]-1);y.push(B[m+L]/B[m+L-1]-1);}return pear(x,y);}
function leadLag(s,now){let best=null,r0=null;for(let L=-3;L<=3;L++){const c=lagc(s,L,60,now);if(L===0)r0=c.r;if(c.r!=null&&(!best||Math.abs(c.r)>Math.abs(best.r)))best={lag:L,r:c.r,n:c.n};}
  return best&&best.n>=30&&Math.abs(best.r)>=0.25&&best.lag!==0&&Math.abs(best.r)>Math.abs(r0||0)+0.05?{sym:s,...best,r0}:{sym:s,lag:null,r:best?best.r:null,n:best?best.n:0,r0};}
const leadLagAll=now=>MEGA.syms.map(s=>leadLag(s,now));
function applyW(w,src){let n=0;for(const[k,v]of Object.entries(w))if(/^[A-Z][A-Z0-9.\-]{0,9}$/.test(k)&&+v>0&&+v<40){MEGA.weights[k]=+v;n++;}if(n)MEGA.weightsSource=`${src} (${n} weights, updated ${new Date().toISOString().slice(0,16)}Z)`;return n;}
async function refreshWeights(){const u=process.env.WEIGHTS_URL;if(!u)return;try{const r=await fetch(u,{signal:AbortSignal.timeout(10000)});const t=await r.text();let w={};try{w=JSON.parse(t);}catch{for(const l of t.split(/\r?\n/)){const[k,v]=l.split(/[,:;\t]/);if(k&&+v>0)w[k.trim().toUpperCase()]=+v;}}applyW(w,'WEIGHTS_URL');}catch(e){console.error('weights refresh failed',e.message);}}
// ---- MACRO (gold, oil, yields, dollar, VIX, semis) + correlation vs NQ ----
const MACRO={'GC=F':'Gold futures','CL=F':'WTI crude futures','^TNX':'US 10Y yield','DX-Y.NYB':'US dollar index','^VIX':'VIX','SMH':'Semiconductor ETF'};
const NEED=()=>Math.min(10,Math.ceil(Object.keys(SYMS).length*0.6));
function saveConf(){try{fs.writeFileSync(path.join(process.env.DATA_DIR||__dirname,'watch.json'),JSON.stringify(Object.keys(SYMS)))}catch{}}
const BM={};let rollT=0;
function bars(now){const mn=Math.floor(now/60000);for(const s of[...Object.keys(SYMS),'NQ=F',...Object.keys(MACRO)]){const q=Q[s];if(!q||now-q.recvT>CFG.staleMs)continue;const b=BM[s]=BM[s]||{};b[mn]=q.price;for(const k in b)if(k<mn-130)delete b[k];}}
function rollGuard(now){const h=H['NQ=F'];if(h&&h.length>=2&&Math.abs(h[h.length-1][1]/h[h.length-2][1]-1)>0.006){rollT=now;H['NQ=F']=[h[h.length-1]];delete BM['NQ=F'];}}
function corr(a,b,W,now){const mn=Math.floor(now/60000),A=BM[a],B=BM[b];if(!A||!B)return{r:null,n:0};const x=[],y=[];for(let m=mn-W+1;m<=mn;m++)if(A[m]&&A[m-1]&&B[m]&&B[m-1]){x.push(A[m]/A[m-1]-1);y.push(B[m]/B[m-1]-1);}
  const n=x.length;if(n<8)return{r:null,n};const mx=mean(x),my=mean(y);let sxy=0,sx=0,sy=0;for(let i=0;i<n;i++){sxy+=(x[i]-mx)*(y[i]-my);sx+=(x[i]-mx)**2;sy+=(y[i]-my)**2;}return{r:sx&&sy?sxy/Math.sqrt(sx*sy):null,n};}
function macroRows(now){return Object.fromEntries(Object.entries(MACRO).map(([s,name])=>{const q=Q[s];return[s,q?{name,price:q.price,pct:q.price/q.prev-1,age:now-q.recvT,c:{15:corr('NQ=F',s,15,now),30:corr('NQ=F',s,30,now),60:corr('NQ=F',s,60,now)}}:{name,unavailable:true}]}));}
// ---- MEGA-CAP ENGINE (alignment + consolidation/breakout + NQ contribution) ----
const EW=(()=>{const o={};for(const p of(process.env.MEGA_WEIGHTS||'').split(',')){const[k,v]=p.split(':');if(k&&+v>0)o[k.trim().toUpperCase()]=+v}return o})();
const MEGA={syms:(process.env.MEGA_SYMBOLS||'NVDA,GOOGL,MU,MSFT,AMZN').split(',').map(x=>x.trim().toUpperCase()).filter(x=>SYMS[x]),
 weights:{NVDA:7.7,GOOGL:6.4,MU:5.2,MSFT:4.9,AMZN:4.2,META:2.8,AVGO:3.0,TSLA:3.0,AMD:3.7,...EW},names:{GOOGL:'Alphabet (A+C)'},
 weightsSource:Object.keys(EW).length?'MEGA_WEIGHTS env (supplied by you)':'approximate averages of mid-2026 Nasdaq-100 fund holdings (Xtrackers/iShares/Invesco); NOT live - set MEGA_WEIGHTS to refresh',
 spcxWeight:+process.env.SPCX_WEIGHT||1.2,minRet:0.0004,minMove:0.0005,agreeMin:0.6,devScore:45,enterScore:70,exitScore:55,strongScore:85,holdMs:15000,consRange:0.0015,brkBuf:0.0003,rangeMs:900000,minFresh:3,nqMin:0.0002};
const M0=()=>({state:'DATA INSUFFICIENT',dir:0,score:0,peak:0,level:null,weak:false,pending:null,pendSince:0,nqDiv:false,dominant:null,brk:{stage:'NONE',dir:0,since:0,cap:0,prev:'NONE',ranges:{}}});
let M=M0(),megaHist=[];
const lvl=x=>x>=MEGA.strongScore?'strong':x>=MEGA.enterScore?'moderate':'weak';
function mHist(kind,to,score,ev){megaHist.unshift({t:Date.now(),kind,to,score,ev});megaHist=megaHist.slice(0,100);}
function spcxRow(now,closed){const q=Q.SPCX;if(!q)return null;const age=now-q.recvT,pct=q.price/q.prev-1;return{price:q.price,prev:q.prev,pct,ext:q.price/q.reg-1,r1:ret('SPCX',60),r3:ret('SPCX',180),age,status:closed?'closed':age>CFG.staleMs?'stale':'live',weight:MEGA.spcxWeight,contrib:MEGA.spcxWeight/100*pct};}
function setBrk(stage,x){const B=M.brk,prev=B.stage;B.prev=prev;B.stage=stage;B.since=Date.now();if(stage==='NONE'){B.ranges={};B.dir=0;return}
  const names=Object.keys(B.ranges);mHist('breakout',stage,null,B.dir?`${names.join(', ')} ${B.dir>0?'above':'below'} frozen range`:`${names.join(', ')} compressed`);
  const n=x?(B.dir>0?x.u:x.d):0,tot=x?x.n:0;
  if(stage==='BREAKOUT CONFIRMED')addAlert('MEGA-CAP BREAKOUT CONFIRMED',{score:null,met:[`${n} of ${tot} compressed mega-caps broke ${B.dir>0?'above':'below'} their frozen range`,'NQ=F moved the same way','Held >= '+MEGA.holdMs/1000+'s'],missing:['Volume confirmation unavailable'],lead:names,invalid:'Price re-enters the frozen range (-> BREAKOUT FAILING)',data:'Price history from poll/trade ticks; not tick-accurate'},B.dir>0?'up':'down',60000);
  if(stage==='BREAKOUT FAILING'&&prev==='BREAKOUT CONFIRMED')addAlert('MEGA-CAP BREAKOUT FAILING',{score:null,met:['A previously confirmed breakout lost most of its participants / re-entered the range'],missing:[],lead:names,invalid:'n/a',data:''},'info',60000);}
function evalBrk(F,nqDir){const B=M.brk,now=Date.now(),px=s=>Q[s].price;
  if(B.stage!=='NONE'&&now-B.cap>MEGA.rangeMs){setBrk('NONE');}
  const bro=()=>{let u=0,d=0;const ks=Object.keys(B.ranges).filter(s=>F.includes(s));for(const s of ks){const r=B.ranges[s],p=px(s);if(p>r.hi*(1+MEGA.brkBuf))u++;else if(p<r.lo*(1-MEGA.brkBuf))d++;}return{u,d,n:ks.length}};
  if(B.stage==='NONE'||B.stage==='CONSOLIDATION DETECTED'){
    if(B.stage!=='NONE'){const x=bro();if(x.u>=2||x.d>=2){B.dir=x.u>=x.d?1:-1;setBrk('BREAKOUT DEVELOPING',x);return}}
    const C=F.filter(s=>{const b=rng(s,300,60);return b&&b.r<=MEGA.consRange});
    if(C.length>=MEGA.minFresh&&C.length/F.length>=MEGA.agreeMin){B.ranges=Object.fromEntries(C.map(s=>{const b=rng(s,300,60);return[s,{hi:b.hi,lo:b.lo}]}));if(B.stage==='NONE'){B.cap=now;setBrk('CONSOLIDATION DETECTED')}}
    else if(B.stage==='CONSOLIDATION DETECTED'&&C.length<MEGA.minFresh)setBrk('NONE');
    return;}
  const x=bro(),same=B.dir>0?x.u:x.d,need=Math.max(MEGA.minFresh,Math.ceil(x.n*MEGA.agreeMin));
  if(B.stage==='BREAKOUT DEVELOPING'){if(same<2)setBrk('BREAKOUT FAILING',x);else if(same>=need&&now-B.since>=MEGA.holdMs&&nqDir===B.dir)setBrk('BREAKOUT CONFIRMED',x);}
  else if(B.stage==='BREAKOUT CONFIRMED'){if(same<Math.ceil(x.n*0.4))setBrk('BREAKOUT FAILING',x);}
  else if(B.stage==='BREAKOUT FAILING'){if(same>=need)setBrk('BREAKOUT DEVELOPING',x);else if(now-B.since>60000)setBrk('NONE');}}
function doSwitch(raw){const from=M.state;M.state=raw.state;M.dir=raw.dir;M.peak=raw.score;M.weak=false;M.pending=null;M.level=lvl(raw.score);
  const ok=raw.lines.filter(l=>l[0]==='ok').map(l=>l[1]),miss=raw.lines.filter(l=>l[0]==='miss').map(l=>l[1]);
  mHist('alignment',raw.state,raw.score,ok.slice(0,3).join('; '));
  if(raw.state==='BULLISH ALIGNMENT'||raw.state==='BEARISH ALIGNMENT')addAlert('MEGA-CAP '+raw.state,{score:raw.score,met:ok,missing:miss,lead:raw.lead,invalid:'Score falls below '+MEGA.exitScore+', agreement breaks, or NQ=F contradicts',data:'Quotes: Yahoo poll / Finnhub trades; volume unavailable'},raw.dir>0?'up':'down',60000);
  else if(/ALIGNMENT$/.test(from)&&raw.state!=='DATA INSUFFICIENT')addAlert('MEGA-CAP ALIGNMENT LOST',{score:raw.score,met:ok,missing:miss,lead:raw.lead,invalid:'n/a',data:''},'info',60000);}
function evalMega(){
  const a=analysis,now=Date.now(),sess=a.session||'',closed=sess.startsWith('CLOSED'),R=s=>a.rows[s]||{};
  const nq=Q['NQ=F'],nqOk=!!nq&&now-nq.recvT<CFG.staleMs&&now-rollT>300000,n1=nqOk?ret('NQ=F',60):null,n3=nqOk?ret('NQ=F',180):null,nqp=nq?nq.price/nq.prev-1:null;
  const F=MEGA.syms.filter(s=>!earnOut(s,now)&&R(s).status==='live'&&R(s).returns&&R(s).returns['1m']!=null&&R(s).returns['3m']!=null);
  const rowsOut=MEGA.syms.map(s=>{const r=R(s),w=MEGA.weights[s]??null,pct=r.pct??null;return{sym:s,name:MEGA.names[s]||SYMS[s],weight:w,price:r.price??null,pct,r1:r.returns?.['1m']??null,r3:r.returns?.['3m']??null,r5:r.returns?.['5m']??null,status:r.status||'unavailable',contrib:w!=null&&pct!=null?w/100*pct:null,rel:pct!=null&&nqp!=null?pct-nqp:null,confirms:pct!=null&&nqp!=null&&Math.abs(nqp)>1e-5?Math.sign(pct)===Math.sign(nqp):null,fresh:F.includes(s),earn:earnOut(s,now)}});
  const nqDir=n1!=null&&Math.abs(n1)>=MEGA.nqMin?Math.sign(n1):0;let raw={state:'DATA INSUFFICIENT',dir:0,score:0,lines:[],lead:[]},nqX=false;
  if(closed){raw.lines.push(['miss','Equity market closed ('+sess+'): no alignment calculation']);if(M.brk.stage!=='NONE')setBrk('NONE');}
  else if(F.length<MEGA.minFresh)raw.lines.push(['miss',`Only ${F.length} of ${MEGA.syms.length} mega-caps have live data with 1m+3m history (need ${MEGA.minFresh})`]);
  else{
    evalBrk(F,nqDir);
    const rr=s=>R(s).returns,dirOf=s=>rr(s)['1m']>=MEGA.minRet&&rr(s)['3m']>0?1:rr(s)['1m']<=-MEGA.minRet&&rr(s)['3m']<0?-1:0;
    const up=F.filter(s=>dirOf(s)>0),dn=F.filter(s=>dirOf(s)<0),dir=up.length>=dn.length?1:-1,ag=dir>0?up:dn,others=F.filter(s=>!ag.includes(s));
    const W=s=>MEGA.weights[s]||1,wag=ag.reduce((x,s)=>x+W(s),0)/F.reduce((x,s)=>x+W(s),0),avg=mean(F.map(s=>rr(s)['1m'])),avg3=mean(F.map(s=>rr(s)['3m']));
    const acc=F.filter(s=>Math.sign(rr(s)['1m'])===dir&&Math.abs(rr(s)['1m'])*3>=Math.abs(rr(s)['3m'])).length/F.length;
    const nqC=n1!=null&&nqDir===dir;nqX=n1!=null&&nqDir===-dir;const bk=M.brk.dir===dir&&(M.brk.stage==='BREAKOUT DEVELOPING'||M.brk.stage==='BREAKOUT CONFIRMED');const pc=v=>(v*100).toFixed(3)+'%';
    const C=[[`${ag.length} of ${F.length} tracked mega-caps moving ${dir>0?'up':'down'} (1m and 3m agree)`,ag.length/F.length>=MEGA.agreeMin&&ag.length>=3,30],
      [`Weight-adjusted agreement ${(wag*100).toFixed(0)}% (needs 65%)`,wag>=0.65,15],[`Average 1m move ${pc(avg)} (needs >= ${pc(MEGA.minMove)} in direction)`,Math.sign(avg)===dir&&Math.abs(avg)>=MEGA.minMove,15],
      [`Average 3m move ${pc(avg3)} same direction`,Math.sign(avg3)===dir,10],[`Momentum accelerating in ${(acc*100).toFixed(0)}% of stocks (1m pace >= 3m pace)`,acc>=0.5,10],
      [n1==null?(now-rollT<300000?'NQ=F confirmation paused: price jump suggests a futures contract roll':'NQ=F confirmation unavailable (no fresh NQ data)'):`NQ=F 1m ${pc(n1)}: ${nqC?'confirms the group':nqX?'CONTRADICTS the group':'flat / not confirming'}`,nqC,15],
      [`Breakout in same direction: ${M.brk.stage}`,bk,5]];
    let score=C.reduce((x,c)=>x+(c[1]?c[0]&&c[2]:0),0);if(nqX)score=Math.min(score,60);
    raw.lines=C.map(c=>[c[1]?'ok':'miss',c[0]]);
    raw.lead=[...ag].sort((x,y)=>Math.abs(rr(y)['1m'])-Math.abs(rr(x)['1m'])).slice(0,2);
    if(raw.lead.length)raw.lines.push(['info','Leading: '+raw.lead.map(s=>`${s} ${pc(rr(s)['1m'])}`).join(', ')]);
    if(others.length)raw.lines.push(['info','Lagging / diverging: '+others.map(s=>`${s} ${pc(rr(s)['1m'])}`).join(', ')]);
    raw.lines.push(['miss','Volume confirmation: unavailable (free feeds give cumulative volume only)']);
    const TD=tod(),EV=eventWindow(now),ENT=MEGA.enterScore+TD.add+EV.add;raw.ctx={tod:TD.lab,event:EV.label,enter:ENT};raw.lines.push(['info',`Context: ${TD.lab}${EV.label?' | inside event window: '+EV.label:''}${ENT>MEGA.enterScore?' | confirmation threshold raised to '+ENT:''}`]);
    let st=score>=ENT&&ag.length>=3?(dir>0?'BULLISH ALIGNMENT':'BEARISH ALIGNMENT'):score>=MEGA.devScore&&ag.length>=2?'ALIGNMENT DEVELOPING':'MIXED / NO ALIGNMENT';
    if((M.state==='BULLISH ALIGNMENT'||M.state==='BEARISH ALIGNMENT')&&M.dir===dir&&score>=MEGA.exitScore&&!nqX&&ag.length>=2)st=M.state;
    raw.state=st;raw.dir=dir;raw.score=score;
    const c5=rowsOut.filter(r=>r.fresh&&r.r5!=null&&r.weight!=null).map(r=>[r.sym,r.weight/100*r.r5]),tot=c5.reduce((x,c)=>x+Math.abs(c[1]),0);
    if(tot>1e-6){const top=c5.sort((x,y)=>Math.abs(y[1])-Math.abs(x[1]))[0];if(Math.abs(top[1])/tot>=0.5){if(M.dominant&&M.dominant!==top[0])addAlert('DOMINANT DRIVER: '+top[0],{score:null,met:[`${top[0]} accounts for ${(Math.abs(top[1])/tot*100).toFixed(0)}% of the group's weighted 5m move (approx.)`],missing:[],lead:[top[0]],invalid:'n/a',data:'weights: '+MEGA.weightsSource},'info',300000);M.dominant=top[0];}}
  }
  {const ex=MEGA.syms.filter(x=>earnOut(x,now));if(ex.length&&!closed)raw.lines.push(['info','Excluded from alignment (earnings window): '+ex.join(', ')]);}
  if(raw.state!==M.state){if(raw.state==='DATA INSUFFICIENT')doSwitch(raw);else{if(M.pending!==raw.state){M.pending=raw.state;M.pendSince=now}if(now-M.pendSince>=MEGA.holdMs)doSwitch(raw);}}
  else{M.pending=null;if(raw.state!=='DATA INSUFFICIENT'){M.score=raw.score;const l=lvl(raw.score),ali=/^(BULL|BEAR)/.test(M.state);M.peak=Math.max(M.peak,raw.score);
    if(ali&&l!==M.level){const rank={weak:0,moderate:1,strong:2};addAlert(rank[l]>rank[M.level]?'ALIGNMENT STRENGTHENING':'ALIGNMENT WEAKENING',{score:raw.score,met:raw.lines.filter(x=>x[0]==='ok').map(x=>x[1]),missing:raw.lines.filter(x=>x[0]==='miss').map(x=>x[1]),lead:raw.lead,invalid:'n/a',data:''},'info',120000);mHist('strength',M.state+' '+l,raw.score,'');M.level=l;}
    M.weak=ali&&(M.peak-raw.score>=15||l==='weak');}}
  if(/^(BULL|BEAR)|DEVELOPING/.test(raw.state)&&nqX){if(!M.nqDiv){M.nqDiv=true;addAlert('NQ DIVERGING FROM MEGA-CAPS',{score:raw.score,met:[`Mega-caps lean ${raw.dir>0?'up':'down'} but NQ=F 1m is ${(n1*100).toFixed(3)}%`],missing:[],lead:raw.lead,invalid:'NQ=F realigns with the group',data:''},'info',300000);mHist('divergence','NQ vs mega-caps',raw.score,'');}}else if(!nqX)M.nqDiv=false;
  const sc=rowsOut.filter(r=>r.contrib!=null);
  a.mega={state:M.state,pending:M.pending,pendSince:M.pendSince,dir:M.dir,score:M.state==='DATA INSUFFICIENT'?0:raw.score,level:M.level,weak:M.weak,lines:raw.lines,ctx:raw.ctx||null,leadlag:leadLagAll(now),rows:rowsOut,freshN:F.length,t:now,
    nq:{ok:nqOk,price:nq?nq.price:null,pct:nqp,r1:n1,r3:n3,age:nq?now-nq.recvT:null},brk:{stage:M.brk.stage,dir:M.brk.dir,since:M.brk.since,ranges:M.brk.ranges},
    sumContrib:sc.length?sc.reduce((x,r)=>x+r.contrib,0):null,note:'Contribution = configured weight x day % change (approximate: weights are not live, share classes combined).'};
}
// ---- SSE / static ----
function snapshot(){return JSON.stringify({analysis,alerts:alerts.slice(0,50),mhist:megaHist.slice(0,30),journal:{stats:jStats(),recent:journal.slice(0,12)},cal:calendar(Date.now()),spacex:news.filter(n=>n.sx).slice(0,6),cfgMega:{holdMs:MEGA.holdMs,enterScore:MEGA.enterScore,exitScore:MEGA.exitScore,devScore:MEGA.devScore,weightsSource:MEGA.weightsSource},news:news.slice(0,120),feed,cfg:CFG,syms:SYMS,now:Date.now()});}
function push(){const d='data: '+snapshot()+'\n\n';for(const c of clients)c.write(d);}
// ---- Optional Finnhub push stream (set FINNHUB_KEY; free key) ----
let wsOn=false;feed.ws={ok:false,last:0,err:process.env.FINNHUB_KEY?'connecting':'no FINNHUB_KEY set - polling only'};
function connectWS(){
  const k=process.env.FINNHUB_KEY;if(!k)return;
  if(typeof WebSocket==='undefined'){feed.ws.err='Node 22+ required for WebSocket';return;}
  const ws=new WebSocket('wss://ws.finnhub.io?token='+k);let dead=false;
  ws.onopen=()=>{wsOn=true;feed.ws={ok:true,last:Date.now(),err:null};for(const s of Object.keys(SYMS))ws.send(JSON.stringify({type:'subscribe',symbol:s}));};
  ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type!=='trade')return;const now=Date.now();
    for(const d of m.data){const q=Q[d.s];if(!q)continue;q.price=d.p;q.provT=d.t;q.recvT=now;q.wsT=now;q.lat=Math.max(0,now-d.t);
      const h=H[d.s]=H[d.s]||[];if(h.length&&now-h[h.length-1][0]<250)h[h.length-1]=[h[h.length-1][0],d.p];else h.push([now,d.p]);}
    feed.ws.last=now;}catch{}};
  const down=()=>{if(dead)return;dead=true;wsOn=false;feed.ws={ok:false,last:feed.ws.last,err:'disconnected, retrying in 5s'};setTimeout(connectWS,5000);};
  ws.onclose=down;ws.onerror=down;
}
// ---- REST API + static ----
const TOKEN=process.env.ACCESS_TOKEN||'',PORT=process.env.PORT||8787;
const J=(r,c,o)=>{r.writeHead(c,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});r.end(JSON.stringify(o));};
const server=http.createServer((q,r)=>{
  const u=new URL(q.url,'http://x'),P=u.pathname,sp=u.searchParams;
  if(P==='/'||P==='/index.html'){fs.readFile(path.join(__dirname,'index.html'),(e,d)=>{r.writeHead(e?500:200,{'Content-Type':'text/html'});r.end(e?'missing index.html':d);});return;}
  if(P==='/healthz'){J(r,200,{ok:true,uptimeSec:Math.round(process.uptime())});return;}
  const tok=sp.get('token')||(q.headers.authorization||'').replace(/^Bearer /,'');
  if(TOKEN&&tok!==TOKEN){J(r,401,{error:'unauthorized - send ?token= or Authorization: Bearer'});return;}
  if((P==='/events'||P.startsWith('/api/'))&&limited(ipOf(q)+(P==='/events'?'#e':''),P==='/events'?20:120)){J(r,429,{error:'rate limited'});return;}
  if(P==='/events'){r.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});clients.add(r);r.write('data: '+snapshot()+'\n\n');q.on('close',()=>clients.delete(r));return;}
  if(P==='/api/events'&&q.method==='POST'){body(q,j=>{if(!j)return J(r,400,{error:'bad request'});if(typeof j.add==='string'){const e=parseEv(j.add);if(!e)return J(r,400,{error:'format: YYYY-MM-DD HH:MM | label (ET)'});if(CUSTOM.length<50)CUSTOM.push(e);}if(Number.isInteger(j.remove))CUSTOM.splice(j.remove,1);saveEv();J(r,200,{custom:CUSTOM.map(c=>c.s)});});return;}
  if(P==='/api/weights'&&q.method==='POST'){body(q,j=>{if(!j||!j.weights)return J(r,400,{error:'bad request'});J(r,200,{applied:applyW(j.weights,'manual (settings)'),source:MEGA.weightsSource});});return;}
  if(P==='/api/watch'&&q.method==='POST'){let b='';q.on('data',c=>{b+=c;if(b.length>2000)q.destroy()});q.on('end',()=>{try{const j=JSON.parse(b||'{}'),re=/^[A-Z][A-Z0-9.\-]{0,9}$/;for(const x of(j.remove||[]))if(SYMS[x]&&Object.keys(SYMS).length>3){delete SYMS[x];delete Q[x];delete H[x];}for(const x of(j.add||[]).map(v=>String(v).toUpperCase().trim()))if(re.test(x)&&!SYMS[x]&&!MACRO[x]&&Object.keys(SYMS).length<30)SYMS[x]=NAMES[x]||x;MEGA.syms=MEGA.syms.filter(x=>SYMS[x]);saveConf();J(r,200,{watchlist:Object.keys(SYMS)});}catch(e){J(r,400,{error:'bad request'});}});return;}
  if(P.startsWith('/api/')){const a=analysis,seg=P.split('/').filter(Boolean),lim=Math.min(+sp.get('limit')||50,300);
    if(P==='/api/status')return J(r,200,{now:Date.now(),session:a.session||null,fresh:a.fresh||0,feeds:feed,note:'Quotes are Yahoo (unofficial) polling unless feeds.ws.ok; coverage not verified consolidated.'});
    if(P==='/api/quotes')return J(r,200,{now:Date.now(),session:a.session,quotes:a.rows||{},nq:a.nq||null});
    if(seg[1]==='quotes'&&seg[2]){const s=seg[2].toUpperCase();if(!(a.rows&&a.rows[s]))return J(r,404,{error:'unknown symbol or no data yet'});return J(r,200,{symbol:s,...a.rows[s],news:news.filter(n=>n.tickers.includes(s)).slice(0,20).map(({base,...n})=>n)});}
    if(P==='/api/sync')return J(r,200,{now:Date.now(),sync:a.sync||{}});
    if(P==='/api/signals')return J(r,200,{alerts:alerts.slice(0,lim)});
    if(P==='/api/news'){let n=news;const t=sp.get('ticker'),c=sp.get('cat');if(t)n=n.filter(x=>x.tickers.includes(t.toUpperCase()));if(c)n=n.filter(x=>x.cat===c);if(sp.get('speaker'))n=n.filter(x=>x.speaker);return J(r,200,{count:n.length,news:n.slice(0,lim).map(({base,...x})=>x)});}
    if(P==='/api/mega')return J(r,200,{now:Date.now(),mega:a.mega||null,history:megaHist.slice(0,lim),weightsSource:MEGA.weightsSource});if(P==='/api/spacex')return J(r,200,{now:Date.now(),instrument:{ticker:'SPCX',what:'Space Exploration Technologies Corp. Class A - Nasdaq-listed since 2026-06-12, Nasdaq-100 member since 2026-07-07',quote:a.spcx||null,weightNote:'configured approximate weight, unverified'},news:news.filter(n=>n.sx).slice(0,lim).map(({base,...x})=>x)});if(P==='/api/journal')return J(r,200,{stats:jStats(),entries:journal.slice(0,lim)});if(P==='/api/calendar')return J(r,200,{events:calendar(Date.now())});if(P==='/api/macro')return J(r,200,{now:Date.now(),macro:a.macro||null,note:'Pearson correlation of 1-minute returns vs NQ=F; unstable, not causal'});if(P==='/api/config')return J(r,200,{cfg:CFG,symbols:SYMS});
    return J(r,404,{error:'not found',endpoints:['/api/status','/api/quotes','/api/quotes/:symbol','/api/sync','/api/signals','/api/news?ticker=&cat=&speaker=1&limit=','/api/config','/healthz','/events (SSE)']});}
  J(r,404,{error:'not found'});
});
function start(){server.listen(PORT,'0.0.0.0',()=>console.log('NQ Terminal on port '+PORT+(TOKEN?' (token required)':' (public, no token)')));
setInterval(()=>pollQuotes().catch(e=>{feed.yahoo={ok:false,last:Date.now(),err:e.message};push();}),CFG.pollMs);pollQuotes();
setInterval(pollNews,90000);pollNews();refreshWeights();setInterval(refreshWeights,43200000);if(process.env.RENDER_EXTERNAL_URL)setInterval(()=>fetch(process.env.RENDER_EXTERNAL_URL+'/healthz').catch(()=>{}),600000);setInterval(pollOfficial,30000);pollOfficial();connectWS();setInterval(()=>{if(wsOn){analyze();push();}},1000);
}
process.on('unhandledRejection',e=>console.error('unhandled',e));process.on('uncaughtException',e=>console.error('uncaught',e));
if(require.main===module)start();
module.exports={BM,corr,MEGA,CUSTOM,parseEv,events,calendar,etUtc,nthFri,jStats,leadLag,refreshWeights,applyW,setOkAt(v){okAt=v},record,get M(){return M},server,Q,H,SYMS,CFG,analyze,signal,nyMinutes,tickersIn,cat,pollQuotes,pollNews,pollOfficial,reset(){M=M0();megaHist=[];journal=[];CUSTOM.length=0;okAt=Date.now();rollT=0;fails=0;holdUntil=0;for(const k in BM)delete BM[k];alerts=[];lastAlert={};news=[];analysis={};for(const k in Q)delete Q[k];for(const k in H)delete H[k];},get state(){return{alerts,news,analysis,feed,mhist:megaHist,journal}}};
