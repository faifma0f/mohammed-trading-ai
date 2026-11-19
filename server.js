const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const BINANCE = 'https://data-api.binance.vision';
const CAPITAL = 50;
const ALLOCATION = 5;
const MAX_POSITIONS = 3;
const MAX_SYMBOLS = 10;
const FEE = 0.001;
const SLIPPAGE = 0.0005;
const STOP_PCT = 0.10;       // 10% of original position notional
const TP1_PCT = 0.20;        // full-position-equivalent target
const TP2_PCT = 0.30;        // full-position-equivalent target
const BACKTEST_DAYS = 365;
const INTERVALS = ['1h', '15m', '5m', '3m'];
const DB = path.join(ROOT, 'paper-state.json');
const STABLES = new Set(['USDCUSDT','FDUSDUSDT','TUSDUSDT','USDPUSDT','DAIUSDT','USDEUSDT','EURUSDT','BUSDUSDT']);
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};

function freshState(){return {version:6,initialCapital:CAPITAL,cash:CAPITAL,realizedPnl:0,positions:[],trades:[],lastEntry:{},symbolsUpdatedAt:0,symbols:[]};}
function loadState(){try{const s=JSON.parse(fs.readFileSync(DB,'utf8'));return {...freshState(),...s,version:6};}catch{return freshState();}}
let state=loadState();
function saveState(){const tmp=DB+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,DB);}
async function getJson(url){
  const r=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});
  if(!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  return r.json();
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function mapRows(rows){return rows.map(c=>({openTime:+c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5],closeTime:+c[6],quoteVolume:+c[7],trades:+c[8]}));}
function ema(values,p){if(values.length<p)return null;let x=values.slice(0,p).reduce((a,b)=>a+b,0)/p,k=2/(p+1);for(let i=p;i<values.length;i++)x=values[i]*k+x*(1-k);return x;}
function rsi(values,p=14){if(values.length<=p)return null;let g=0,l=0;for(let i=1;i<=p;i++){let d=values[i]-values[i-1];if(d>0)g+=d;else l-=d;}g/=p;l/=p;for(let i=p+1;i<values.length;i++){let d=values[i]-values[i-1];g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p;}return l===0?100:100-100/(1+g/l);}
function atr(cs,p=14){if(cs.length<=p)return null;let s=0;for(let i=cs.length-p;i<cs.length;i++){const c=cs[i],q=cs[i-1];s+=Math.max(c.high-c.low,Math.abs(c.high-q.close),Math.abs(c.low-q.close));}return s/p;}
function macd(values){if(values.length<35)return null;const fast=seriesEma(values,12),slow=seriesEma(values,26),line=values.map((_,i)=>fast[i]!=null&&slow[i]!=null?fast[i]-slow[i]:null);const valid=line.filter(x=>x!=null);const sigValid=seriesEma(valid,9);const signal=new Array(values.length).fill(null);let k=0;for(let i=0;i<line.length;i++)if(line[i]!=null)signal[i]=sigValid[k++];const i=values.length-1;return {line:line[i],signal:signal[i],hist:line[i]-signal[i]};}
function seriesEma(v,p){const out=new Array(v.length).fill(null);if(v.length<p)return out;let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p;out[p-1]=x;const k=2/(p+1);for(let i=p;i<v.length;i++){x=v[i]*k+x*(1-k);out[i]=x;}return out;}
function avg(arr){return arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;}
function analyze(cs,now=Date.now()){
  const c=cs.filter(x=>x.closeTime<now);if(c.length<205)return {ready:false,count:c.length};
  const v=c.map(x=>x.close),last=c.at(-1),vol20=c.slice(-21,-1).map(x=>x.quoteVolume || x.volume*x.close);
  const mac=macd(v), relVol=(last.quoteVolume || last.volume*last.close)/(avg(vol20)||1);
  const look=c.slice(-21,-1),priorHigh=Math.max(...look.map(x=>x.high)),priorLow=Math.min(...look.map(x=>x.low));
  const prev=c.at(-2);
  const bullishEngulf=last.close>last.open&&prev.close<prev.open&&last.close>=prev.open&&last.open<=prev.close;
  const breakout=last.close>priorHigh;
  const reclaim=last.low<=ema(v.slice(0,-1),20)*1.002&&last.close>ema(v,20);
  return {ready:true,count:c.length,close:last.close,previousClose:prev.close,ema20:ema(v,20),ema50:ema(v,50),ema200:ema(v,200),rsi14:rsi(v),atr14:atr(c),macd:mac,relVolume:relVol,quoteVolume:last.quoteVolume||last.volume*last.close,priorHigh,priorLow,breakout,bullishEngulf,reclaim,candleTime:last.closeTime};
}
function scoreSignal(a,liquidity={}){
  const [h,m15,m5,m3]=a;
  if(!a.every(x=>x&&x.ready))return {status:'DATA_WAIT',label:'بانتظار البيانات',score:0,reason:'بيانات غير كافية'};
  let score=0, checks={};
  const hTrend=h.close>h.ema50&&h.ema50>h.ema200;
  checks.trend1h=hTrend?'إيجابي':'غير متحقق'; if(hTrend)score+=20;
  const trend15=m15.close>m15.ema20&&m15.ema20>m15.ema50;
  checks.trend15=trend15?'إيجابي':'غير متحقق'; if(trend15)score+=15;
  const macdOk=m5.macd&&m5.macd.hist>0&&m5.macd.line>m5.macd.signal;
  checks.macd=macdOk?'صاعد':'غير متحقق'; if(macdOk)score+=15;
  const rsiOk=m5.rsi14>=50&&m5.rsi14<=72;
  checks.rsi=rsiOk?'ضمن النطاق':'خارج النطاق'; if(rsiOk)score+=10;
  const pattern=m15.breakout||m15.reclaim||m3.bullishEngulf||m3.breakout;
  checks.pattern=m15.breakout?'اختراق قمة 20 شمعة':m15.reclaim?'استعادة EMA20':m3.bullishEngulf?'ابتلاع شرائي':m3.breakout?'اختراق قصير':'لا يوجد تأكيد'; if(pattern)score+=15;
  const volumeOk=m5.relVolume>=1.4&&m3.relVolume>=1.2;
  checks.relativeVolume=volumeOk?'نشاط أعلى من المتوسط':'حجم غير كافٍ'; if(volumeOk)score+=15;
  const depthOk=liquidity.spreadPct==null?true:liquidity.spreadPct<=0.15;
  const turnoverOk=(liquidity.quoteVolume24h||0)>=1000000;
  checks.marketLiquidity=depthOk&&turnoverOk?'مقبولة':'ضعيفة'; if(depthOk&&turnoverOk)score+=10;
  const hardReject=!hTrend||!trend15||!volumeOk||!depthOk||!turnoverOk;
  const status=score>=75&&!hardReject?'BUY':score<45||!hTrend?'NO_BUY':'WAIT';
  return {status,label:status==='BUY'?'فرصة شراء تجريبية':status==='NO_BUY'?'تجنب الدخول':'انتظار',score,checks,reason:status==='BUY'?'توافق الاتجاه والزخم والنموذج والسيولة':hardReject?'فلتر اتجاه أو سيولة غير متحقق':'النقاط غير كافية',risk:{allocationUsd:ALLOCATION,stopLossPct:STOP_PCT*100,tp1Pct:TP1_PCT*100,tp2Pct:TP2_PCT*100,stopPrice:null,target1Price:null,target2Price:null}};
}
async function getTopSymbols(force=false){
  if(!force&&state.symbols.length&&Date.now()-state.symbolsUpdatedAt<4*60*60*1000)return state.symbols;
  const [tickers,info]=await Promise.all([getJson(`${BINANCE}/api/v3/ticker/24hr`),getJson(`${BINANCE}/api/v3/exchangeInfo`)]);
  const tradable=new Set(info.symbols.filter(s=>s.status==='TRADING'&&s.isSpotTradingAllowed&&s.quoteAsset==='USDT').map(s=>s.symbol));
  state.symbols=tickers.filter(t=>tradable.has(t.symbol)&&!STABLES.has(t.symbol)&&+t.quoteVolume>=1000000&&+t.lastPrice>0).sort((a,b)=>+b.quoteVolume-+a.quoteVolume).slice(0,MAX_SYMBOLS).map(t=>t.symbol);
  state.symbolsUpdatedAt=Date.now();saveState();return state.symbols;
}
async function getLiquidity(symbol){
  const [book,ticker]=await Promise.all([getJson(`${BINANCE}/api/v3/ticker/bookTicker?symbol=${symbol}`),getJson(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`)]);
  const bid=+book.bidPrice,ask=+book.askPrice,mid=(bid+ask)/2;
  return {bid,ask,spreadPct:mid>0?(ask-bid)/mid*100:null,quoteVolume24h:+ticker.quoteVolume};
}
async function getAsset(symbol){
  const [ticker,liq,...rows]=await Promise.all([
    getJson(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`),getLiquidity(symbol),
    ...INTERVALS.map(tf=>getJson(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=250`))
  ]);
  const analyses=rows.map(r=>analyze(mapRows(r))),price=+ticker.lastPrice;
  const signal=scoreSignal(analyses,liq);
  const qty=ALLOCATION/price;
  signal.risk.stopPrice=price*(1-STOP_PCT);
  signal.risk.target1Price=price*(1+TP1_PCT);
  signal.risk.target2Price=price*(1+TP2_PCT);
  return {symbol,price,changePercent24h:+ticker.priceChangePercent,quoteVolume24h:+ticker.quoteVolume,high24h:+ticker.highPrice,low24h:+ticker.lowPrice,liquidity:liq,analysis:{'1h':analyses[0],'15m':analyses[1],'5m':analyses[2],'3m':analyses[3]},signal};
}
function closePosition(pos,rawPrice,reason,now=Date.now(),fraction=1){
  const qty=pos.quantity*fraction,fill=rawPrice*(1-SLIPPAGE),gross=(fill-pos.entryPrice)*qty;
  const exitFee=fill*qty*FEE,entryFee=pos.entryFee*fraction,pnl=gross-exitFee-entryFee;
  state.cash+=fill*qty-exitFee;state.realizedPnl+=pnl;pos.quantity-=qty;pos.entryFee-=entryFee;
  state.trades.unshift({...pos,quantity:qty,exitPrice:fill,exitTime:now,pnl,exitReason:reason,exitFee,entryFee});
  if(pos.quantity<=1e-12)state.positions=state.positions.filter(x=>x.id!==pos.id);
}
function executePaper(assets){
  const now=Date.now();
  for(const pos of [...state.positions]){
    const a=assets.find(x=>x.symbol===pos.symbol);if(!a)continue;
    const p=a.price;pos.markPrice=p;
    if(p<=pos.stopPrice){closePosition(pos,pos.stopPrice,pos.partialTaken?'تعادل بعد TP1':'وقف خسارة -10%',now);continue;}
    if(!pos.partialTaken&&p>=pos.target1Price){
      closePosition(pos,pos.target1Price,'TP1 +20% من مبلغ الصفقة (بيع النصف)',now,0.5);
      const remain=state.positions.find(x=>x.id===pos.id);
      if(remain){remain.partialTaken=true;remain.stopPrice=remain.entryPrice;}
    }
    const remain=state.positions.find(x=>x.id===pos.id);if(!remain)continue;
    if(remain.partialTaken&&p<=remain.stopPrice){closePosition(remain,remain.stopPrice,'وقف التعادل بعد TP1',now);continue;}
    if(remain.partialTaken&&p>=remain.target2Price)closePosition(remain,remain.target2Price,'TP2 +30% من مبلغ الصفقة (تصفية المتبقي)',now);
  }
  for(const a of assets){
    if(state.positions.length>=MAX_POSITIONS)break;
    if(a.signal.status!=='BUY'||state.positions.some(p=>p.symbol===a.symbol))continue;
    const candle=a.analysis['3m'].candleTime;if(!candle||state.lastEntry[a.symbol]===candle)continue;
    const entry=a.price*(1+SLIPPAGE),qty=ALLOCATION/entry,notional=qty*entry,entryFee=notional*FEE;
    if(notional+entryFee>state.cash)continue;
    state.cash-=notional+entryFee;
    state.positions.push({id:`${a.symbol}-${now}`,symbol:a.symbol,entryPrice:entry,stopPrice:entry*(1-STOP_PCT),target1Price:entry*(1+TP1_PCT),target2Price:entry*(1+TP2_PCT),quantity:qty,originalQuantity:qty,notional,entryFee,riskUsd:ALLOCATION*STOP_PCT,openedAt:now,entryCandle:candle,markPrice:a.price,partialTaken:false});
    state.lastEntry[a.symbol]=candle;
  }
  saveState();
}
function portfolio(){
  const unrealized=state.positions.reduce((s,p)=>s+((p.markPrice||p.entryPrice)-p.entryPrice)*p.quantity-(p.markPrice||p.entryPrice)*p.quantity*(FEE+SLIPPAGE),0);
  const invested=state.positions.reduce((s,p)=>s+p.quantity*p.entryPrice,0);
  return {initialCapital:state.initialCapital,cash:state.cash,realizedPnl:state.realizedPnl,unrealizedPnl:unrealized,openCount:state.positions.length,closedCount:state.trades.length,maxOpenPositions:MAX_POSITIONS,winRate:state.trades.length?state.trades.filter(t=>t.pnl>0).length/state.trades.length*100:0,positions:state.positions,trades:state.trades.slice(0,100),equity:state.cash+invested+unrealized};
}
async function market(){
  const symbols=await getTopSymbols();const results=await Promise.allSettled(symbols.map(getAsset));
  const assets=results.filter(x=>x.status==='fulfilled').map(x=>x.value),errors=results.filter(x=>x.status==='rejected').map(x=>String(x.reason?.message||x.reason));
  executePaper(assets);
  return {version:'V6',source:'Binance Spot public market data',updatedAt:new Date().toISOString(),symbolsUpdatedAt:new Date(state.symbolsUpdatedAt).toISOString(),mode:'paper_only',capitalUsd:CAPITAL,maxOpenPositions:MAX_POSITIONS,symbols,assets,errors,strategy:{timeframes:INTERVALS,allocationUsd:ALLOCATION,stopLossPercent:10,tp1Percent:20,tp1SellPercent:50,tp2Percent:30,scoreThreshold:75,universeRefreshHours:4},portfolio:portfolio()};
}
async function getHistorical(symbol,interval,startTime,endTime){
  const all=[];let cursor=startTime;
  while(cursor<endTime){
    const url=`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const rows=await getJson(url);if(!rows.length)break;
    all.push(...mapRows(rows));const next=+rows[rows.length-1][0]+1;
    if(next<=cursor)break;cursor=next;
    if(rows.length<1000)break;
    await sleep(80);
  }
  const seen=new Map();for(const c of all)if(c.closeTime<=endTime)seen.set(c.openTime,c);
  return [...seen.values()].sort((a,b)=>a.openTime-b.openTime);
}
function buildSeries(cs){
  const n=cs.length,cl=cs.map(c=>c.close),e20=seriesEma(cl,20),e50=seriesEma(cl,50),e200=seriesEma(cl,200);
  const r=new Array(n).fill(null),tr=new Array(n).fill(null),vol=new Array(n).fill(null),hist=new Array(n).fill(null);
  let gain=0,loss=0;
  for(let i=1;i<n;i++){const d=cl[i]-cl[i-1];if(i<=14){if(d>0)gain+=d;else loss-=d;}if(i===14){gain/=14;loss/=14;}else if(i>14){gain=(gain*13+Math.max(d,0))/14;loss=(loss*13+Math.max(-d,0))/14;}if(i>=14)r[i]=loss===0?100:100-100/(1+gain/loss);}
  for(let i=1;i<n;i++){const c=cs[i],p=cs[i-1];tr[i]=Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));}
  let sum=0;for(let i=1;i<=14&&i<n;i++)sum+=tr[i];if(n>14){vol[14]=sum/14;for(let i=15;i<n;i++){sum+=tr[i]-tr[i-14];vol[i]=sum/14;}}
  const fast=seriesEma(cl,12),slow=seriesEma(cl,26),line=cl.map((_,i)=>fast[i]!=null&&slow[i]!=null?fast[i]-slow[i]:null),valid=line.filter(x=>x!=null),sig=seriesEma(valid,9);let k=0;const signal=new Array(n).fill(null);for(let i=0;i<n;i++)if(line[i]!=null)signal[i]=sig[k++];for(let i=0;i<n;i++)if(line[i]!=null&&signal[i]!=null)hist[i]=line[i]-signal[i];
  const rel=new Array(n).fill(null);
  for(let i=20;i<n;i++){let s=0;for(let j=i-20;j<i;j++)s+=(cs[j].quoteVolume||cs[j].volume*cs[j].close);rel[i]=(cs[i].quoteVolume||cs[i].volume*cs[i].close)/(s/20||1);}
  return cs.map((c,i)=>{
    if(i<204)return null;
    const prev=cs[i-1],window=cs.slice(i-20,i),priorHigh=Math.max(...window.map(x=>x.high));
    const bullishEngulf=c.close>c.open&&prev.close<prev.open&&c.close>=prev.open&&c.open<=prev.close;
    const breakout=c.close>priorHigh;
    const reclaim=c.low<=(e20[i]||0)*1.002&&c.close>e20[i];
    return {ready:true,close:c.close,previousClose:prev.close,ema20:e20[i],ema50:e50[i],ema200:e200[i],rsi14:r[i],atr14:vol[i],macdHist:hist[i],macdLine:line[i],macdSignal:signal[i],relVolume:rel[i],quoteVolume:c.quoteVolume||c.volume*c.close,breakout,bullishEngulf,reclaim,time:c.closeTime};
  });
}
function latestIndex(cs,t,p){while(p.i+1<cs.length&&cs[p.i+1].closeTime<=t)p.i++;return p.i;}
function scoreAt(a1,a15,a5,a3){
  if(![a1,a15,a5,a3].every(Boolean))return {score:0,ok:false};
  let s=0;
  if(a1.close>a1.ema50&&a1.ema50>a1.ema200)s+=20;
  if(a15.close>a15.ema20&&a15.ema20>a15.ema50)s+=15;
  if(a5.macdHist>0&&a5.macdLine>a5.macdSignal)s+=15;
  if(a5.rsi14>=50&&a5.rsi14<=72)s+=10;
  if(a15.breakout||a15.reclaim||a3.bullishEngulf||a3.breakout)s+=15;
  if(a5.relVolume>=1.4&&a3.relVolume>=1.2)s+=15;
  if(a5.quoteVolume>=100000&&a3.quoteVolume>=20000)s+=10;
  const hard=a1.close>a1.ema50&&a1.ema50>a1.ema200&&a15.close>a15.ema20&&a15.ema20>a15.ema50&&a5.relVolume>=1.4&&a3.relVolume>=1.2;
  return {score:s,ok:s>=75&&hard};
}
function simulate(c3,startIndex,entry){
  const qty=ALLOCATION/entry,stop=entry*(1-STOP_PCT),tp1=entry*(1+TP1_PCT),tp2=entry*(1+TP2_PCT);
  let remaining=qty,pnl=0,fees=entry*qty*FEE,partial=false,activeStop=stop,reason='DATA_END',exitTime=c3.at(-1).closeTime,last=c3.length-1;
  function realize(raw,q){const fill=raw*(1-SLIPPAGE),fee=fill*q*FEE;pnl+=(fill-entry)*q-fee;fees+=fee;}
  for(let j=startIndex;j<c3.length;j++){
    const c=c3[j];last=j;
    if(c.low<=activeStop){const fill=c.open<activeStop?c.open:activeStop;realize(fill,remaining);remaining=0;reason=partial?'BREAKEVEN_AFTER_TP1':'STOP_LOSS';exitTime=c.closeTime;break;}
    if(!partial&&c.high>=tp1){const fill=c.open>tp1?c.open:tp1,half=remaining/2;realize(fill,half);remaining-=half;partial=true;activeStop=entry;if(c.low<=entry){realize(entry,remaining);remaining=0;reason='BREAKEVEN_AFTER_TP1';exitTime=c.closeTime;break;}}
    if(partial&&c.high>=tp2){const fill=c.open>tp2?c.open:tp2;realize(fill,remaining);remaining=0;reason='TP2';exitTime=c.closeTime;break;}
  }
  if(remaining>0){realize(c3[last].close,remaining);remaining=0;}
  return {entryTime:c3[startIndex].openTime,exitTime,entry,stop,tp1,tp2,pnl,fees,reason,partial,holdingMinutes:(exitTime-c3[startIndex].openTime)/60000};
}
function summarize(trades,symbol,start,end){
  const wins=trades.filter(t=>t.pnl>0),loss=trades.filter(t=>t.pnl<0),gw=wins.reduce((s,t)=>s+t.pnl,0),gl=-loss.reduce((s,t)=>s+t.pnl,0);
  let equity=CAPITAL,peak=CAPITAL,dd=0;for(const t of trades){equity+=t.pnl;peak=Math.max(peak,equity);dd=Math.max(dd,peak?(peak-equity)/peak*100:0);}
  return {symbol,period:{start:new Date(start).toISOString(),end:new Date(end).toISOString()},trades:trades.length,wins:wins.length,losses:loss.length,winRate:trades.length?wins.length/trades.length*100:0,netPnl:trades.reduce((s,t)=>s+t.pnl,0),profitFactor:gl?gw/gl:(gw?null:0),expectancy:trades.length?trades.reduce((s,t)=>s+t.pnl,0)/trades.length:0,maxDrawdownPercent:dd,avgHoldingHours:trades.length?trades.reduce((s,t)=>s+t.holdingMinutes,0)/trades.length/60:0,stopExits:trades.filter(t=>t.reason==='STOP_LOSS').length,tp1Hits:trades.filter(t=>t.partial).length,tp2Exits:trades.filter(t=>t.reason==='TP2').length,breakevenExits:trades.filter(t=>t.reason==='BREAKEVEN_AFTER_TP1').length,totalFees:trades.reduce((s,t)=>s+t.fees,0),sample:trades.slice(-25)};
}
async function backtest(res){
  try{
    const u=new URL(res.req.url,'http://localhost'),symbol=(u.searchParams.get('symbol')||'BTCUSDT').toUpperCase();
    if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))throw new Error('رمز غير صحيح');
    const end=Date.now()-60000,start=end-BACKTEST_DAYS*86400000;
    const [h1,m15,m5,m3]=await Promise.all(INTERVALS.map(tf=>getHistorical(symbol,tf,start,end)));
    if(m3.length<10000)throw new Error(`بيانات 3m غير كافية: ${m3.length} شمعة`);
    const s1=buildSeries(h1),s15=buildSeries(m15),s5=buildSeries(m5),s3=buildSeries(m3);
    const ptr={h1:-1,m15:-1,m5:-1},trades=[],reject={data:0,trend1h:0,trend15m:0,score:0},signals=0;
    let nextEntry=0;
    for(let i=205;i<m3.length-1;i++){
      const c=m3[i];if(c.closeTime<start||c.closeTime<nextEntry)continue;
      ptr.h1=latestIndex(h1,c.closeTime,{i:ptr.h1});ptr.m15=latestIndex(m15,c.closeTime,{i:ptr.m15});ptr.m5=latestIndex(m5,c.closeTime,{i:ptr.m5});
      const a1=s1[ptr.h1],a15=s15[ptr.m15],a5=s5[ptr.m5],a3=s3[i];
      if(!a1||!a15||!a5||!a3){reject.data++;continue;}
      if(!(a1.close>a1.ema50&&a1.ema50>a1.ema200)){reject.trend1h++;continue;}
      if(!(a15.close>a15.ema20&&a15.ema20>a15.ema50)){reject.trend15m++;continue;}
      const decision=scoreAt(a1,a15,a5,a3);if(!decision.ok){reject.score++;continue;}
      const ptr={h1:-1,m15:-1,m5:-1},trades=[],reject={data:0,trend1h:0,trend15m:0,score:0};
let signals=0;
let nextEntry=0;
    const result=summarize(trades,symbol,start,end);
    send(res,{version:'V6',...result,intervals:INTERVALS,candleCounts:{'1h':h1.length,'15m':m15.length,'5m':m5.length,'3m':m3.length},diagnostics:{candidateSignals:signals,rejected:reject},costs:{feePerSidePercent:FEE*100,slippagePerSidePercent:SLIPPAGE*100},strategy:{allocationUsd:ALLOCATION,stopLossPercent:10,tp1Percent:20,tp1SellPercent:50,tp2Percent:30,scoreThreshold:75,scoreModel:{trend1h:20,trend15m:15,macd:15,rsi:10,pricePattern:15,relativeVolume:15,turnover:10}},limitations:[
      'اختبار الرمز المحدد فقط؛ لا يحاكي محفظة متعددة العملات أو حد ثلاثة مراكز متزامنة.',
      'الحجم النسبي وحجم التداول التاريخي محسوبان من بيانات الشموع. لا تتوفر لقطات دفتر أوامر تاريخية موثوقة لسنة كاملة، لذلك لا يمكن اختبار عمق دفتر الطلبات والسبريد التاريخي.',
      'أفضل 10 عملات في التداول الحي تُحدّث كل 4 ساعات من ترتيب السوق الحالي. الاختبار التاريخي لا يعيد بناء قائمة أفضل 10 لكل فترة تاريخية، لتجنب الادعاء بوجود بيانات تاريخية غير متاحة.',
      'الاستراتيجية Spot Long فقط، ويفترض تنفيذ الدخول والخروج مع رسوم 0.10% وانزلاق 0.05% لكل جهة. تحقق من رسوم حساب Binance الفعلية.',
      'هدف TP1 وTP2 محسوبان كربح مكافئ على كامل مبلغ الصفقة الأصلي؛ بيع نصف الكمية عند TP1 ثم النصف المتبقي عند TP2. لا يوجد ضمان للأداء المستقبلي.'
    ]});
  }catch(e){console.error('BACKTEST_ERROR:',e.stack||e);send(res,{error:'تعذر تنفيذ الاختبار السنوي',detail:e.message,trace:e.stack||String(e)},502);}
}
function send(res,obj,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/api/market'){try{send(res,await market());}catch(e){send(res,{error:'تعذر جلب بيانات Binance',detail:e.message},502);}return;}
  if(u.pathname==='/api/portfolio'){send(res,portfolio());return;}
  if(u.pathname==='/api/backtest'){await backtest(res);return;}
  if(u.pathname==='/api/reset'&&req.method==='POST'){state=freshState();saveState();send(res,{ok:true,portfolio:portfolio()});return;}
  const p=u.pathname==='/'?'/index.html':decodeURIComponent(u.pathname),f=path.resolve(ROOT,'.'+p);
  if(!f.startsWith(ROOT+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end('Not found');}else{res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(d);}});
}).listen(PORT,'0.0.0.0',()=>console.log(`Mohammed Trading AI V6 Paper Trading on ${PORT}`));
