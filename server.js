'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const BINANCE = 'https://data-api.binance.vision';
const CAPITAL = 50, ALLOCATION = 5, MAX_POSITIONS = 3, MAX_SYMBOLS = 10;
const FEE = 0.001, SLIPPAGE = 0.0005;
const STOP_PCT = 0.10, TP1_PCT = 0.20, TP2_PCT = 0.30;
const BACKTEST_DAYS = 365;
const INTERVALS = ['1d', '4h', '1h'];
const DB = path.join(ROOT, 'paper-state.json');
const STABLES = new Set(['USDCUSDT','FDUSDUSDT','TUSDUSDT','USDPUSDT','DAIUSDT','USDEUSDT','EURUSDT','BUSDUSDT']);
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};

function freshState(){return {version:7,initialCapital:CAPITAL,cash:CAPITAL,realizedPnl:0,positions:[],trades:[],lastEntry:{},symbolsUpdatedAt:0,symbols:[]};}
function loadState(){try{const s=JSON.parse(fs.readFileSync(DB,'utf8'));return {...freshState(),...s,version:7};}catch{return freshState();}}
let state=loadState();
function saveState(){const tmp=DB+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,DB);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url,retries=4){
  let last;
  for(let i=0;i<=retries;i++){
    try{
      const r=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(25000)});
      if(r.status===429||r.status===418){const wait=Number(r.headers.get('retry-after'))*1000||Math.min(15000,1000*2**i);await sleep(wait);continue;}
      if(!r.ok)throw new Error(`Binance HTTP ${r.status}`);
      return await r.json();
    }catch(e){last=e;if(i<retries)await sleep(Math.min(8000,500*2**i));}
  }
  throw last||new Error('Binance request failed');
}
function mapRows(rows){return rows.map(c=>({openTime:+c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5],closeTime:+c[6],quoteVolume:+c[7],trades:+c[8]}));}
function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:0;}
function emaSeries(v,p){const out=Array(v.length).fill(null);if(v.length<p)return out;let x=avg(v.slice(0,p));out[p-1]=x;const k=2/(p+1);for(let i=p;i<v.length;i++){x=v[i]*k+x*(1-k);out[i]=x;}return out;}
function buildSeries(cs){
  const n=cs.length,cl=cs.map(c=>c.close),e20=emaSeries(cl,20),e50=emaSeries(cl,50),e200=emaSeries(cl,200);
  const rsi=Array(n).fill(null),atr=Array(n).fill(null),macdHist=Array(n).fill(null),macdLine=Array(n).fill(null),macdSignal=Array(n).fill(null),rel=Array(n).fill(null);
  let gain=0,loss=0;
  for(let i=1;i<n;i++){const d=cl[i]-cl[i-1];if(i<=14){if(d>0)gain+=d;else loss-=d;}if(i===14){gain/=14;loss/=14;}else if(i>14){gain=(gain*13+Math.max(d,0))/14;loss=(loss*13+Math.max(-d,0))/14;}if(i>=14)rsi[i]=loss===0?100:100-100/(1+gain/loss);}
  const tr=Array(n).fill(0);for(let i=1;i<n;i++){const c=cs[i],p=cs[i-1];tr[i]=Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));}
  if(n>14){let s=0;for(let i=1;i<=14;i++)s+=tr[i];atr[14]=s/14;for(let i=15;i<n;i++)atr[i]=(atr[i-1]*13+tr[i])/14;}
  const f=emaSeries(cl,12),sl=emaSeries(cl,26);for(let i=0;i<n;i++)if(f[i]!=null&&sl[i]!=null)macdLine[i]=f[i]-sl[i];
  const valid=macdLine.filter(x=>x!=null),sig=emaSeries(valid,9);let k=0;for(let i=0;i<n;i++)if(macdLine[i]!=null){macdSignal[i]=sig[k++];if(macdSignal[i]!=null)macdHist[i]=macdLine[i]-macdSignal[i];}
  for(let i=20;i<n;i++){let v=0;for(let j=i-20;j<i;j++)v+=(cs[j].quoteVolume||cs[j].volume*cs[j].close);rel[i]=(cs[i].quoteVolume||cs[i].volume*cs[i].close)/(v/20||1);}
  return cs.map((c,i)=>{
    if(i<204)return null;
    const prev=cs[i-1],w=cs.slice(i-20,i),priorHigh=Math.max(...w.map(x=>x.high));
    const bullishEngulf=c.close>c.open&&prev.close<prev.open&&c.close>=prev.open&&c.open<=prev.close;
    const breakout=c.close>priorHigh;
    const reclaim=c.low<=(e20[i]||0)*1.002&&c.close>e20[i];
    return {ready:true,close:c.close,open:c.open,high:c.high,low:c.low,ema20:e20[i],ema50:e50[i],ema200:e200[i],rsi14:rsi[i],atr14:atr[i],macdHist:macdHist[i],macdLine:macdLine[i],macdSignal:macdSignal[i],relVolume:rel[i],quoteVolume:c.quoteVolume||c.volume*c.close,breakout,bullishEngulf,reclaim,time:c.closeTime};
  });
}
function scoreSignal(a,liq={}){
  const [d,h4,h1]=a;if(!a.every(x=>x&&x.ready))return {status:'DATA_WAIT',label:'بانتظار البيانات',score:0,reason:'بيانات غير كافية'};
  let score=0;const checks={};
  const daily=d.close>d.ema50&&d.ema50>d.ema200;checks.daily=daily?'اتجاه يومي صاعد':'غير متحقق';if(daily)score+=25;
  const four=h4.close>h4.ema20&&h4.ema20>h4.ema50;checks.fourHour=four?'اتجاه 4 ساعات صاعد':'غير متحقق';if(four)score+=25;
  const mac=h1.macdHist>0&&h1.macdLine>h1.macdSignal;checks.macd=mac?'زخم صاعد':'غير متحقق';if(mac)score+=10;
  const rsi=h1.rsi14>=50&&h1.rsi14<=72;checks.rsi=rsi?'ضمن النطاق':'خارج النطاق';if(rsi)score+=10;
  const pattern=h1.breakout||h1.reclaim||h1.bullishEngulf||h4.breakout||h4.reclaim;checks.pattern=pattern?'نموذج سعري مؤكد':'لا يوجد تأكيد';if(pattern)score+=15;
  const volume=h1.relVolume>=1.3;checks.relativeVolume=volume?'حجم أعلى من المتوسط':'حجم غير كافٍ';if(volume)score+=5;
  const spread=liq.spreadPct==null||liq.spreadPct<=0.15,turnover=(liq.quoteVolume24h||0)>=1000000;checks.liquidity=spread&&turnover?'سيولة مقبولة':'سيولة ضعيفة';if(spread&&turnover)score+=10;
  const hardReject=!daily||!four||!spread||!turnover;
  const status=score>=75&&!hardReject?'BUY':!daily||!four?'NO_BUY':'WAIT';
  return {status,label:status==='BUY'?'فرصة شراء تجريبية':status==='NO_BUY'?'تجنب الدخول':'انتظار',score,checks,reason:status==='BUY'?'توافق الاتجاه والزخم والنموذج والسيولة':hardReject?'اتجاه يومي أو 4 ساعات أو سيولة غير متحقق':'النقاط غير كافية',risk:{allocationUsd:ALLOCATION,stopLossPct:10,tp1Pct:20,tp2Pct:30}};
}
async function getTopSymbols(force=false){
  if(!force&&state.symbols.length&&Date.now()-state.symbolsUpdatedAt<4*3600000)return state.symbols;
  const [tickers,info]=await Promise.all([getJson(`${BINANCE}/api/v3/ticker/24hr`),getJson(`${BINANCE}/api/v3/exchangeInfo`)]);
  const allowed=new Set(info.symbols.filter(s=>s.status==='TRADING'&&s.isSpotTradingAllowed&&s.quoteAsset==='USDT').map(s=>s.symbol));
  state.symbols=tickers.filter(t=>allowed.has(t.symbol)&&!STABLES.has(t.symbol)&&+t.quoteVolume>=1000000&&+t.lastPrice>0).sort((a,b)=>+b.quoteVolume-+a.quoteVolume).slice(0,MAX_SYMBOLS).map(t=>t.symbol);
  state.symbolsUpdatedAt=Date.now();saveState();return state.symbols;
}
async function getLiquidity(symbol){
  const [b,t]=await Promise.all([getJson(`${BINANCE}/api/v3/ticker/bookTicker?symbol=${symbol}`),getJson(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`)]);
  const bid=+b.bidPrice,ask=+b.askPrice,mid=(bid+ask)/2;return {bid,ask,spreadPct:mid>0?(ask-bid)/mid*100:null,quoteVolume24h:+t.quoteVolume};
}
async function getAsset(symbol){
  const [ticker,liq,...rows]=await Promise.all([getJson(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`),getLiquidity(symbol),...INTERVALS.map(tf=>getJson(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=250`))]);
  const analyses=rows.map(r=>buildSeries(mapRows(r)).at(-2));const price=+ticker.lastPrice,signal=scoreSignal(analyses,liq);
  signal.risk.stopPrice=price*(1-STOP_PCT);signal.risk.target1Price=price*(1+TP1_PCT);signal.risk.target2Price=price*(1+TP2_PCT);
  return {symbol,price,changePercent24h:+ticker.priceChangePercent,quoteVolume24h:+ticker.quoteVolume,high24h:+ticker.highPrice,low24h:+ticker.lowPrice,liquidity:liq,analysis:{'1d':analyses[0],'4h':analyses[1],'1h':analyses[2]},signal};
}
function closePosition(pos,raw,reason,now=Date.now(),fraction=1){
  const qty=pos.quantity*fraction,fill=raw*(1-SLIPPAGE),gross=(fill-pos.entryPrice)*qty,exitFee=fill*qty*FEE,entryFee=pos.entryFee*fraction,pnl=gross-exitFee-entryFee;
  state.cash+=fill*qty-exitFee;state.realizedPnl+=pnl;pos.quantity-=qty;pos.entryFee-=entryFee;
  state.trades.unshift({...pos,quantity:qty,exitPrice:fill,exitTime:now,pnl,exitReason:reason,exitFee,entryFee});
  if(pos.quantity<=1e-12)state.positions=state.positions.filter(x=>x.id!==pos.id);
}
function executePaper(assets){
  const now=Date.now();
  for(const pos of [...state.positions]){const a=assets.find(x=>x.symbol===pos.symbol);if(!a)continue;const p=a.price;pos.markPrice=p;
    if(p<=pos.stopPrice){closePosition(pos,pos.stopPrice,pos.partialTaken?'تعادل بعد TP1':'وقف خسارة -10%',now);continue;}
    if(!pos.partialTaken&&p>=pos.target1Price){closePosition(pos,pos.target1Price,'TP1 +20% (بيع النصف)',now,0.5);const rem=state.positions.find(x=>x.id===pos.id);if(rem){rem.partialTaken=true;rem.stopPrice=rem.entryPrice;}}
    const rem=state.positions.find(x=>x.id===pos.id);if(!rem)continue;
    if(rem.partialTaken&&p<=rem.stopPrice){closePosition(rem,rem.stopPrice,'وقف التعادل بعد TP1',now);continue;}
    if(rem.partialTaken&&p>=rem.target2Price)closePosition(rem,rem.target2Price,'TP2 +30%',now);
  }
  for(const a of assets){if(state.positions.length>=MAX_POSITIONS)break;if(a.signal.status!=='BUY'||state.positions.some(p=>p.symbol===a.symbol))continue;
    const candle=a.analysis['1h']?.time;if(!candle||state.lastEntry[a.symbol]===candle)continue;
    const entry=a.price*(1+SLIPPAGE),qty=ALLOCATION/entry,notional=qty*entry,entryFee=notional*FEE;if(notional+entryFee>state.cash)continue;
    state.cash-=notional+entryFee;state.positions.push({id:`${a.symbol}-${now}`,symbol:a.symbol,entryPrice:entry,stopPrice:entry*(1-STOP_PCT),target1Price:entry*(1+TP1_PCT),target2Price:entry*(1+TP2_PCT),quantity:qty,notional,entryFee,riskUsd:ALLOCATION*STOP_PCT,openedAt:now,entryCandle:candle,markPrice:a.price,partialTaken:false});state.lastEntry[a.symbol]=candle;
  }saveState();
}
function portfolio(){const unrealized=state.positions.reduce((s,p)=>s+((p.markPrice||p.entryPrice)-p.entryPrice)*p.quantity-(p.markPrice||p.entryPrice)*p.quantity*(FEE+SLIPPAGE),0),invested=state.positions.reduce((s,p)=>s+p.quantity*p.entryPrice,0);return {initialCapital:state.initialCapital,cash:state.cash,realizedPnl:state.realizedPnl,unrealizedPnl:unrealized,openCount:state.positions.length,closedCount:state.trades.length,maxOpenPositions:MAX_POSITIONS,winRate:state.trades.length?state.trades.filter(t=>t.pnl>0).length/state.trades.length*100:0,positions:state.positions,trades:state.trades.slice(0,100),equity:state.cash+invested+unrealized};}
async function market(){const symbols=await getTopSymbols(),settled=await Promise.allSettled(symbols.map(getAsset)),assets=settled.filter(x=>x.status==='fulfilled').map(x=>x.value),errors=settled.filter(x=>x.status==='rejected').map(x=>String(x.reason?.message||x.reason));executePaper(assets);return {version:'V7',source:'Binance Spot public market data',updatedAt:new Date().toISOString(),symbolsUpdatedAt:new Date(state.symbolsUpdatedAt).toISOString(),mode:'paper_only',capitalUsd:CAPITAL,maxOpenPositions:MAX_POSITIONS,symbols,assets,errors,strategy:{timeframes:INTERVALS,allocationUsd:ALLOCATION,stopLossPercent:10,tp1Percent:20,tp1SellPercent:50,tp2Percent:30,scoreThreshold:75,universeRefreshHours:4},portfolio:portfolio()};}
async function getHistorical(symbol,interval,start,end){
  const all=[];let cursor=start;
  while(cursor<end){const url=`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${end}&limit=1000`,rows=await getJson(url);if(!rows.length)break;all.push(...mapRows(rows));const next=+rows[rows.length-1][0]+1;if(next<=cursor)break;cursor=next;if(rows.length<1000)break;await sleep(120);}
  const byTime=new Map();for(const c of all)if(c.closeTime<=end)byTime.set(c.openTime,c);return [...byTime.values()].sort((a,b)=>a.openTime-b.openTime);
}
function latestIndex(cs,t,p){while(p.i+1<cs.length&&cs[p.i+1].closeTime<=t)p.i++;return p.i;}
function scoreAt(d,h4,h1,opts={}){if(!d||!h4||!h1)return {score:0,ok:false};let score=0;const rsiMin=opts.rsiMin??50,rsiMax=opts.rsiMax??72,volumeMin=opts.volumeMin??1.3,scoreMin=opts.scoreMin??75;
  if(d.close>d.ema50&&d.ema50>d.ema200)score+=25;
  if(h4.close>h4.ema20&&h4.ema20>h4.ema50)score+=25;
  if(h1.macdHist>0&&h1.macdLine>h1.macdSignal)score+=10;
  if(h1.rsi14>=rsiMin&&h1.rsi14<=rsiMax)score+=10;
  if(h1.breakout||h1.reclaim||h1.bullishEngulf||h4.breakout||h4.reclaim)score+=15;
  if(h1.relVolume>=volumeMin)score+=5;
  if(h1.quoteVolume>=50000)score+=10;
  const hard=d.close>d.ema50&&d.ema50>d.ema200&&h4.close>h4.ema20&&h4.ema20>h4.ema50&&h1.quoteVolume>=50000;
  return {score,ok:score>=scoreMin&&hard};
}
function simulate(cs,startIndex,entry,opts={}){const stopPct=opts.stopPct??STOP_PCT,tp1Pct=opts.tp1Pct??TP1_PCT,tp2Pct=opts.tp2Pct??TP2_PCT,tp1SellPct=opts.tp1SellPct??0.5;const qty=ALLOCATION/entry,stop=entry*(1-stopPct),tp1=entry*(1+tp1Pct),tp2=entry*(1+tp2Pct);let rem=qty,pnl=0,fees=entry*qty*FEE,partial=false,activeStop=stop,reason='DATA_END',exitTime=cs.at(-1).closeTime,last=startIndex;
  function realize(raw,q){const fill=raw*(1-SLIPPAGE),fee=fill*q*FEE;pnl+=(fill-entry)*q-fee;fees+=fee;}
  for(let j=startIndex;j<cs.length;j++){const c=cs[j];last=j;
    if(c.low<=activeStop){const fill=c.open<activeStop?c.open:activeStop;realize(fill,rem);rem=0;reason=partial?'BREAKEVEN_AFTER_TP1':'STOP_LOSS';exitTime=c.closeTime;break;}
    if(!partial&&c.high>=tp1){const fill=c.open>tp1?c.open:tp1,half=rem*tp1SellPct;realize(fill,half);rem-=half;partial=true;activeStop=entry;if(c.low<=entry){realize(entry,rem);rem=0;reason='BREAKEVEN_AFTER_TP1';exitTime=c.closeTime;break;}}
    if(partial&&c.high>=tp2){const fill=c.open>tp2?c.open:tp2;realize(fill,rem);rem=0;reason='TP2';exitTime=c.closeTime;break;}
  }
  if(rem>0){realize(cs[last].close,rem);rem=0;}return {entryTime:cs[startIndex].openTime,exitTime,entry,stop,tp1,tp2,pnl,fees,reason,partial,holdingHours:(exitTime-cs[startIndex].openTime)/3600000};}
function summarize(trades,symbol,start,end){const wins=trades.filter(t=>t.pnl>0),loss=trades.filter(t=>t.pnl<0),gw=wins.reduce((s,t)=>s+t.pnl,0),gl=-loss.reduce((s,t)=>s+t.pnl,0);let equity=CAPITAL,peak=CAPITAL,dd=0;for(const t of trades){equity+=t.pnl;peak=Math.max(peak,equity);dd=Math.max(dd,peak?(peak-equity)/peak*100:0);}return {symbol,period:{start:new Date(start).toISOString(),end:new Date(end).toISOString()},trades:trades.length,wins:wins.length,losses:loss.length,winRate:trades.length?wins.length/trades.length*100:0,netPnl:trades.reduce((s,t)=>s+t.pnl,0),profitFactor:gl?gw/gl:(gw?null:0),expectancy:trades.length?trades.reduce((s,t)=>s+t.pnl,0)/trades.length:0,maxDrawdownPercent:dd,avgHoldingHours:trades.length?trades.reduce((s,t)=>s+t.holdingHours,0)/trades.length:0,stopExits:trades.filter(t=>t.reason==='STOP_LOSS').length,tp1Hits:trades.filter(t=>t.partial).length,tp2Exits:trades.filter(t=>t.reason==='TP2').length,breakevenExits:trades.filter(t=>t.reason==='BREAKEVEN_AFTER_TP1').length,totalFees:trades.reduce((s,t)=>s+t.fees,0),sample:trades.slice(-20)};}
async function backtest(req,res){try{
  const u=new URL(req.url,'http://localhost'),symbol=(u.searchParams.get('symbol')||'BTCUSDT').toUpperCase();
  if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))throw new Error('رمز غير صحيح');
  const number=(key,def,min,max)=>{const raw=u.searchParams.get(key);const n=raw===null?def:Number(raw);if(!Number.isFinite(n)||n<min||n>max)throw new Error(`قيمة ${key} خارج النطاق`);return n;};
  const days=number('days',365,30,365),stopPct=number('sl',10,0.1,30)/100,tp1Pct=number('tp1',10,0.1,50)/100,tp2Pct=number('tp2',20,0.2,100)/100;
  const rsiMin=number('rsiMin',50,1,99),rsiMax=number('rsiMax',72,2,100),volumeMin=number('volume',1.3,0.1,10),scoreMin=number('score',75,25,100),tp1SellPct=number('tp1Sell',50,1,99)/100;
  if(rsiMin>=rsiMax)throw new Error('يجب أن يكون RSI الأدنى أقل من الأعلى');if(tp1Pct>=tp2Pct)throw new Error('يجب أن يكون TP1 أقل من TP2');
  const end=Date.now()-60000,start=end-days*86400000;
  const d=await getHistorical(symbol,'1d',start-210*86400000,end);await sleep(150);const h4=await getHistorical(symbol,'4h',start-40*86400000,end);await sleep(150);const h1=await getHistorical(symbol,'1h',start-10*86400000,end);
  if(h1.length<250)throw new Error(`بيانات الساعة غير كافية: ${h1.length} شمعة`);
  const sd=buildSeries(d),s4=buildSeries(h4),s1=buildSeries(h1),ptr={d:-1,h4:-1},trades=[],rejected={data:0,daily:0,fourHour:0,score:0};let candidateSignals=0,nextEntry=0;
  const opts={stopPct,tp1Pct,tp2Pct,tp1SellPct};
  for(let i=205;i<h1.length-1;i++){const c=h1[i];if(c.closeTime<start||c.closeTime<nextEntry)continue;ptr.d=latestIndex(d,c.closeTime,{i:ptr.d});ptr.h4=latestIndex(h4,c.closeTime,{i:ptr.h4});const ad=sd[ptr.d],a4=s4[ptr.h4],a1=s1[i];if(!ad||!a4||!a1){rejected.data++;continue;}if(!(ad.close>ad.ema50&&ad.ema50>ad.ema200)){rejected.daily++;continue;}if(!(a4.close>a4.ema20&&a4.ema20>a4.ema50)){rejected.fourHour++;continue;}const decision=scoreAt(ad,a4,a1,{rsiMin,rsiMax,volumeMin,scoreMin});if(!decision.ok){rejected.score++;continue;}candidateSignals++;const entry=h1[i+1].open*(1+SLIPPAGE),trade=simulate(h1,i+1,entry,opts);trades.push(trade);nextEntry=trade.exitTime||c.closeTime;}
  const result=summarize(trades,symbol,start,end);send(res,{version:'V8',...result,intervals:INTERVALS,settings:{days,slPercent:stopPct*100,tp1Percent:tp1Pct*100,tp2Percent:tp2Pct*100,tp1SellPercent:tp1SellPct*100,rsiMin,rsiMax,relativeVolumeMin:volumeMin,scoreThreshold:scoreMin},candleCounts:{'1d':d.length,'4h':h4.length,'1h':h1.length},diagnostics:{candidateSignals,rejected},costs:{feePerSidePercent:FEE*100,slippagePerSidePercent:SLIPPAGE*100},strategy:{allocationUsd:ALLOCATION,stopLossPercent:stopPct*100,tp1Percent:tp1Pct*100,tp1SellPercent:tp1SellPct*100,tp2Percent:tp2Pct*100,scoreThreshold:scoreMin,weights:{dailyTrend:25,fourHourTrend:25,macd:10,rsi:10,pricePattern:15,relativeVolume:5,liquidityProxy:10}},limitations:['الاختبار لزوج واحد في كل تشغيل، ولا يحاكي محفظة متعددة الأزواج أو ثلاثة مراكز متزامنة.','الفريمات المستخدمة في الاختبار هي اليومي و4 ساعات والساعة؛ لم يتم تحويل محرك الإشارات إلى فريمات 15 و5 و3 دقائق.','الاختبار يستخدم شموع Binance التاريخية، ولا يعيد بناء دفتر الأوامر أو ترتيب أفضل 10 أزواج تاريخياً.','Spot Long فقط، ورسوم مفترضة 0.10% وانزلاق 0.05% لكل جهة.','تغيير هذه الإعدادات يؤثر على Backtest فقط ولا يغير Paper Trading الحالي.']});
 }catch(e){console.error('BACKTEST_ERROR',e.stack||e);send(res,{error:'تعذر تنفيذ الاختبار التاريخي',detail:e.message},400);}}

function send(res,obj,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
http.createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/health'){send(res,{ok:true,version:'V7',timeframes:INTERVALS});return;}
  if(u.pathname==='/api/market'){try{send(res,await market());}catch(e){send(res,{error:'تعذر جلب بيانات Binance',detail:e.message},502);}return;}
  if(u.pathname==='/api/portfolio'){send(res,portfolio());return;}
  if(u.pathname==='/api/backtest'){await backtest(req,res);return;}
  if(u.pathname==='/api/reset'&&req.method==='POST'){state=freshState();saveState();send(res,{ok:true,portfolio:portfolio()});return;}
  const p=u.pathname==='/'?'/index.html':decodeURIComponent(u.pathname),f=path.resolve(ROOT,'.'+p);if(!f.startsWith(ROOT+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end('Not found');}else{res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(d);}});
}).listen(PORT,'0.0.0.0',()=>console.log(`Mohammed Trading AI V7 Paper Trading + V8 Backtest on ${PORT}`));
