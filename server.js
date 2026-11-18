const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const BINANCE = "https://data-api.binance.vision";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  return r.json();
}
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let v = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i=period; i<values.length; i++) v = values[i]*k + v*(1-k);
  return v;
}
function rsi(values, period=14) {
  if (values.length <= period) return null;
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1]; if(d>=0) gains+=d; else losses-=d;}
  let avgGain=gains/period, avgLoss=losses/period;
  for(let i=period+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    avgGain=(avgGain*(period-1)+Math.max(d,0))/period;
    avgLoss=(avgLoss*(period-1)+Math.max(-d,0))/period;
  }
  if(avgLoss===0) return 100;
  return 100-(100/(1+avgGain/avgLoss));
}
function atr(candles, period=14) {
  if(candles.length < period+1) return null;
  const trs=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i], p=candles[i-1];
    trs.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close)));
  }
  return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function analyze(candles) {
  // Binance's last kline may still be forming; use only fully closed candles.
  const closed = candles.filter(c => c.closeTime < Date.now());
  const closes = closed.map(c=>c.close);
  if(closed.length < 205) return {ready:false, count:closed.length};
  const last=closed[closed.length-1], prev=closed[closed.length-2];
  return {
    ready:true, close:last.close, previousClose:prev.close,
    ema20:ema(closes,20), ema50:ema(closes,50), ema200:ema(closes,200),
    rsi14:rsi(closes,14), atr14:atr(closed,14),
    candleTime:last.closeTime, candleOpen:last.open, candleHigh:last.high, candleLow:last.low
  };
}
function strategy(a15,a5,a3,price) {
  if(!a15.ready || !a5.ready || !a3.ready) return {
    status:"DATA_WAIT", label:"بانتظار اكتمال البيانات", reason:"نحتاج 205 شموع مغلقة لكل إطار لحساب EMA 200 بشكل سليم."
  };
  const trend15 = a15.close > a15.ema50 && a15.ema50 > a15.ema200;
  const trend15Bear = a15.close < a15.ema50 && a15.ema50 < a15.ema200;
  const confirm5 = a5.close > a5.ema20 && a5.ema20 > a5.ema50 && a5.rsi14 >= 50 && a5.rsi14 <= 70;
  const confirm5Bear = a5.close < a5.ema20 && a5.ema20 < a5.ema50 && a5.rsi14 < 50;
  const entry3 = a3.close > a3.ema20 && a3.close > a3.previousClose && a3.rsi14 >= 50 && a3.rsi14 <= 70;
  const invalid3 = a3.close < a3.ema20 || a3.rsi14 > 75;
  let status="WAIT", label="انتظار", reason="الشروط غير مكتملة؛ لا توجد صفقة.";
  if(trend15 && confirm5 && entry3 && !invalid3){
    status="BUY"; label="إشارة شراء تجريبية";
    reason="اتجاه 15m صاعد، وتأكيد 5m إيجابي، وزخم 3m يؤكد الدخول.";
  } else if(trend15Bear || confirm5Bear){
    status="NO_BUY"; label="تجنب الشراء";
    reason="الاتجاه أو تأكيد 5m لا يدعم صفقة شراء Spot.";
  } else {
    reason="ننتظر توافق الاتجاه على 15m والتأكيد على 5m وإشارة التوقيت على 3m.";
  }
  const stopDistance = a3.atr14 ? a3.atr14*1.5 : null;
  const stop = stopDistance ? price-stopDistance : null;
  const quantity = stopDistance && stopDistance>0 ? 0.50/stopDistance : null;
  const notional = quantity ? quantity*price : null;
  const target = stopDistance ? price+2*stopDistance : null;
  return {
    status,label,reason,
    checks:{
      trend15: trend15 ? "صاعد" : trend15Bear ? "هابط" : "محايد",
      confirm5: confirm5 ? "إيجابي" : confirm5Bear ? "سلبي" : "غير مؤكد",
      entry3: entry3 ? "متحقق" : "غير متحقق",
      rsi15: a15.rsi14, rsi5:a5.rsi14, rsi3:a3.rsi14
    },
    risk:{maxLossUsd:0.50, stopPrice:stop, targetPrice:target, quantityBase:quantity, notionalUsd:notional, riskReward:"1:2"},
    candleTimes:{m15:a15.candleTime,m5:a5.candleTime,m3:a3.candleTime}
  };
}
async function getAsset(symbol) {
  const [ticker, k15, k5, k3] = await Promise.all([
    getJson(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`),
    getJson(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=15m&limit=250`),
    getJson(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=5m&limit=250`),
    getJson(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=3m&limit=250`)
  ]);
  const map = rows => rows.map(c=>({openTime:c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5],closeTime:c[6]}));
  const c15=map(k15), c5=map(k5), c3=map(k3);
  const a15=analyze(c15), a5=analyze(c5), a3=analyze(c3);
  const price=+ticker.lastPrice;
  return {
    symbol, price, changePercent24h:+ticker.priceChangePercent,
    high24h:+ticker.highPrice, low24h:+ticker.lowPrice,
    analysis:{ "15m":a15, "5m":a5, "3m":a3 },
    signal:strategy(a15,a5,a3,price)
  };
}
async function api(res) {
  try {
    const assets=await Promise.all(SYMBOLS.map(getAsset));
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    res.end(JSON.stringify({source:"Binance Spot public market data",updatedAt:new Date().toISOString(),capitalUsd:50,maxRiskUsd:0.5,mode:"paper_only",assets}));
  } catch(e) {
    res.writeHead(502,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    res.end(JSON.stringify({error:"تعذر جلب بيانات Binance أو تحليلها حالياً",detail:e.message}));
  }
}
http.createServer((req,res)=>{
  const pathname=new URL(req.url||"/","http://localhost").pathname;
  if(pathname==="/api/market") return api(res);
  const requested=pathname==="/" ? "/index.html" : decodeURIComponent(pathname);
  const file=path.resolve(ROOT,"."+requested);
  if(!file.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end("Forbidden");}
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);return res.end("Not found");}
    res.writeHead(200,{"Content-Type":MIME[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"});
    res.end(data);
  });
}).listen(PORT,"0.0.0.0",()=>console.log(`Mohammed Trading AI listening on ${PORT}`));
