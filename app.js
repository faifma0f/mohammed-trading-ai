const labels={BTC:"Bitcoin",ETH:"Ethereum",SOL:"Solana"};
const fmt=(n,d=2)=>n==null||!Number.isFinite(n)?"—":n.toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:d});
const usd=n=>n==null?"—":"$"+fmt(n,n>=100?2:4);
const clsStatus=s=>s==="BUY"?"buy":s==="NO_BUY"?"avoid":"wait";
const statusLabel=s=>s==="BUY"?"شراء تجريبي":s==="NO_BUY"?"تجنب الشراء":s==="DATA_WAIT"?"بانتظار البيانات":"انتظار";
async function refresh(){
 const connection=document.getElementById("connection"), updated=document.getElementById("updated"), error=document.getElementById("error");
 try{
  const r=await fetch("/api/market",{cache:"no-store"}), data=await r.json();
  if(!r.ok) throw new Error(data.detail||data.error||"Market API error");
  document.getElementById("marketRows").innerHTML=data.assets.map(a=>{
   const base=a.symbol.replace("USDT","");
   return `<tr><td><b>${base}</b><small>${labels[base]} / USDT</small></td><td class="price">${usd(a.price)}</td><td class="${a.changePercent24h>=0?"positive":"negative"}">${a.changePercent24h>0?"+":""}${fmt(a.changePercent24h)}%</td><td><span class="signal ${clsStatus(a.signal.status)}">${statusLabel(a.signal.status)}</span></td></tr>`;
  }).join("");
  document.getElementById("analysisCards").innerHTML=data.assets.map(a=>{
   const base=a.symbol.replace("USDT",""), s=a.signal, c=s.checks||{};
   return `<article class="asset-card"><div class="asset-head"><b>${base}</b><span class="signal ${clsStatus(s.status)}">${s.label}</span></div><p>${s.reason}</p><div class="checks"><div><small>15m الاتجاه</small><b>${c.trend15||"غير متاح"}</b></div><div><small>5m التأكيد</small><b>${c.confirm5||"غير متاح"}</b></div><div><small>3m الدخول</small><b>${c.entry3||"غير متاح"}</b></div></div><div class="rsi">RSI — 15m: ${fmt(c.rsi15,1)} · 5m: ${fmt(c.rsi5,1)} · 3m: ${fmt(c.rsi3,1)}</div></article>`;
  }).join("");
  document.getElementById("riskCards").innerHTML=data.assets.map(a=>{
   const base=a.symbol.replace("USDT",""), risk=a.signal.risk||{};
   return `<article class="asset-card"><div class="asset-head"><b>${base}</b><span class="tag">حد المخاطرة $0.50</span></div><div class="risk-grid"><div><small>سعر مرجعي</small><b>${usd(a.price)}</b></div><div><small>وقف الخسارة النظري</small><b>${usd(risk.stopPrice)}</b></div><div><small>هدف 2R النظري</small><b>${usd(risk.targetPrice)}</b></div><div><small>قيمة المركز التقريبية</small><b>${usd(risk.notionalUsd)}</b></div></div><p class="muted">حجم الأصل المحسوب: ${fmt(risk.quantityBase,6)} · لا يتم فتح مركز تلقائياً.</p></article>`;
  }).join("");
  connection.textContent="متصل";connection.className="connected";updated.textContent="آخر تحديث: "+new Date(data.updatedAt).toLocaleTimeString("ar-SA");error.hidden=true;
 }catch(e){connection.textContent="تعذر الاتصال";connection.className="warn";error.hidden=false;error.textContent="تعذر تحديث التحليل: "+e.message;}
}
refresh();setInterval(refresh,60000);
