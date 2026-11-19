const $ = (id) => document.getElementById(id);
const money = (v) => Number.isFinite(Number(v)) ? `$${Number(v).toFixed(2)}` : '—';
const pct = (v) => Number.isFinite(Number(v)) ? `${Number(v).toFixed(2)}%` : '—';
const fmtPrice = (v) => Number.isFinite(Number(v)) ? Number(v).toPrecision(7).replace(/\.?0+$/, '') : '—';
const fmtTime = (v) => v ? new Date(v).toLocaleString('ar-SA') : '—';
let lastAssets = [];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function setSigned(el, value) {
  el.textContent = money(value);
  el.classList.toggle('negative', Number(value) < 0);
  el.classList.toggle('positive', Number(value) > 0);
}
function renderMarket(assets) {
  $('marketBody').innerHTML = assets.length ? assets.map(a => {
    const s = a.signal || {};
    const cls = s.status === 'BUY' ? 'buy' : s.status === 'NO_BUY' ? 'avoid' : 'wait';
    return `<tr>
      <td><strong>${esc(a.symbol)}</strong></td>
      <td>${fmtPrice(a.price)}</td>
      <td class="${Number(a.changePercent24h) >= 0 ? 'positive' : 'negative'}">${pct(a.changePercent24h)}</td>
      <td>${money(a.quoteVolume24h)}</td>
      <td><span class="signal ${cls}">${esc(s.label || s.status || '—')}</span></td>
      <td class="reason">${esc(s.reason || '—')}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">لم تصل بيانات صالحة من Binance.</td></tr>';
}
function renderPortfolio(p) {
  $('initialCapital').textContent = money(p.initialCapital);
  $('cash').textContent = money(p.cash);
  $('equity').textContent = money(p.equity);
  setSigned($('realized'), p.realizedPnl);
  $('openCount').textContent = `${p.openCount} / ${p.maxOpenPositions || 3}`;
  $('winRate').textContent = pct(p.winRate);

  $('positionsBody').innerHTML = p.positions?.length ? p.positions.map(x => `<tr>
    <td>${esc(x.symbol)}</td><td>${fmtPrice(x.entryPrice)}</td>
    <td>${fmtPrice(x.stopPrice)}</td><td>${fmtPrice(x.targetPrice)}</td>
    <td>${Number(x.quantity).toFixed(6)}</td><td>${money(x.riskUsd)}</td>
  </tr>`).join('') : '<tr><td colspan="6" class="empty">لا توجد مراكز مفتوحة.</td></tr>';

  $('tradesBody').innerHTML = p.trades?.length ? p.trades.slice(0, 30).map(t => `<tr>
    <td>${esc(t.symbol)}</td><td>${fmtPrice(t.entryPrice)}</td><td>${fmtPrice(t.exitPrice)}</td>
    <td class="${Number(t.pnl) >= 0 ? 'positive' : 'negative'}">${money(t.pnl)}</td>
    <td>${esc(t.exitReason || '—')}</td><td>${fmtTime(t.exitTime)}</td>
  </tr>`).join('') : '<tr><td colspan="6" class="empty">لا توجد صفقات مغلقة بعد.</td></tr>';
}
function populateSymbols(assets) {
  const select = $('symbolSelect');
  const previous = select.value;
  const symbols = [...new Set(assets.map(a => a.symbol))];
  if (!symbols.length) return;
  select.innerHTML = symbols.map(s => `<option value="${esc(s)}">${esc(s.replace('USDT', ' / USDT'))}</option>`).join('');
  select.value = symbols.includes(previous) ? previous : (symbols.includes('BTCUSDT') ? 'BTCUSDT' : symbols[0]);
}
async function refreshMarket() {
  $('refreshBtn').disabled = true;
  $('marketStatus').textContent = 'جاري جلب بيانات Binance…';
  try {
    const r = await fetch('/api/market', { cache: 'no-store' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || data.error || 'فشل جلب السوق');
    lastAssets = data.assets || [];
    renderMarket(lastAssets);
    renderPortfolio(data.portfolio || {});
    populateSymbols(lastAssets);
    $('updatedAt').textContent = `آخر تحديث: ${fmtTime(data.updatedAt)}`;
    $('marketStatus').textContent = `${lastAssets.length} أزواج متاحة`;
    if (data.errors?.length) $('marketStatus').textContent += ` · تعذر تحميل ${data.errors.length}`;
  } catch (e) {
    $('marketStatus').textContent = `خطأ: ${e.message}`;
  } finally {
    $('refreshBtn').disabled = false;
  }
}
function renderComparisons(data) {
  const rows = data.comparisons || [];
  $('backtestSummary').innerHTML = rows.map(x => `
    <article class="result-card">
      <div class="result-title">${esc(x.label)}</div>
      <div class="result-main ${Number(x.netPnl) >= 0 ? 'positive' : 'negative'}">${money(x.netPnl)}</div>
      <div class="result-metrics">
        <span>الصفقات <b>${x.trades}</b></span>
        <span>الفوز <b>${pct(x.winRate)}</b></span>
        <span>Profit Factor <b>${x.profitFactor == null ? '—' : Number(x.profitFactor).toFixed(2)}</b></span>
        <span>وقف الخسارة <b>${x.stopExits ?? 0}</b></span>
        <span>وصل TP1 <b>${x.target1Trades ?? 0}</b></span>
        <span>وصل TP2 <b>${x.target2Exits ?? 0}</b></span>
        <span>تعادل بعد TP1 <b>${x.breakevenExits ?? 0}</b></span>
        <span>Expectancy <b>${money(x.expectancy)}</b></span>
        <span>Max Drawdown <b>${pct(x.maxDrawdownPercent)}</b></span>
        <span>متوسط الاحتفاظ <b>${Number(x.avgHoldingMinutes || 0).toFixed(1)} د</b></span>
        <span>وقف الخسارة <b>${x.stopExits ?? 0}</b></span>
        <span>التعادل <b>${x.breakevenExits ?? 0}</b></span>
        <span>أهداف ربح <b>${x.targetExits ?? 0}</b></span>
        <span>خروج زمني <b>${x.timeExits ?? 0}</b></span>
        <span>إجمالي الرسوم <b>${money(x.totalFees || 0)}</b></span>
        <span>متوسط المخاطرة الفعلية <b>${money(x.avgEstimatedRisk || 0)}</b></span>
      </div>
    </article>`).join('');
  const c = data.candleCounts || {};
  $('diagnostics').innerHTML = `
    <h3>بيانات الاختبار والتشخيص</h3>
    <p>الشموع: 1H (${c['1h'] || 0}) · 15m (${c['15m'] || 0}) · 5m (${c['5m'] || 0}) · 3m (${c['3m'] || 0})</p>
    <p>إشارات مرشحة: ${data.diagnostics?.candidateSignals ?? '—'} · شموع 3m مفحوصة: ${data.diagnostics?.scanned3mCandles ?? '—'}</p>
    <p>الرفض حسب الفلتر: 1H (${data.diagnostics?.rejected?.h1 ?? 0}) · 15m (${data.diagnostics?.rejected?.m15 ?? 0}) · 5m (${data.diagnostics?.rejected?.m5 ?? 0}) · 3m (${data.diagnostics?.rejected?.m3 ?? 0})</p>
    <p class="muted">الفترة المشتركة: ${fmtTime(data.sharedPeriod?.start)} — ${fmtTime(data.sharedPeriod?.end)}</p>`;
  $('limitations').innerHTML = `<strong>حدود الاختبار:</strong><ul>${(data.limitations || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  $('limitations').classList.remove('hidden');
}

function renderV6Backtest(data) {
  const metrics = [
    ['عدد الصفقات', data.trades], ['نسبة الفوز', pct(data.winRate)],
    ['Profit Factor', data.profitFactor == null ? '—' : Number(data.profitFactor).toFixed(2)],
    ['صافي الربح بعد التكاليف', money(data.netPnl)], ['Expectancy', money(data.expectancy)],
    ['Max Drawdown', pct(data.maxDrawdownPercent)], ['TP1', data.tp1Hits],
    ['TP2', data.tp2Exits], ['وقف الخسارة', data.stopExits],
    ['تعادل بعد TP1', data.breakevenExits], ['إجمالي الرسوم', money(data.totalFees)],
    ['متوسط مدة الصفقة', `${Number(data.avgHoldingHours || 0).toFixed(1)} ساعة`]
  ];
  $('backtestSummary').innerHTML = `<article class="result-card">
    <div class="result-title">نتيجة الاختبار السنوي · ${esc(data.symbol)}</div>
    <div class="result-main ${Number(data.netPnl)>=0?'positive':'negative'}">${money(data.netPnl)}</div>
    <div class="result-metrics">${metrics.map(([k,v])=>`<span>${k}<b>${v}</b></span>`).join('')}</div>
  </article>`;
  const c=data.candleCounts||{}, d=data.diagnostics||{};
  $('diagnostics').innerHTML = `<h3>بيانات الاختبار والتشخيص</h3>
    <p>الشموع: 1H (${c['1h']||0}) · 15m (${c['15m']||0}) · 5m (${c['5m']||0}) · 3m (${c['3m']||0})</p>
    <p>إشارات مرشحة: ${d.candidateSignals??0} · رفض اتجاه 1H: ${d.rejected?.trend1h??0} · رفض 15m: ${d.rejected?.trend15m??0} · رفض النقاط/السيولة: ${d.rejected?.score??0}</p>
    <p>الفترة: ${fmtTime(data.period?.start)} — ${fmtTime(data.period?.end)}</p>`;
  $('limitations').innerHTML = `<strong>حدود الاختبار:</strong><ul>${(data.limitations||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
  $('limitations').classList.remove('hidden');
}

async function runBacktest() {
  const symbol = $('symbolSelect').value;
  $('backtestBtn').disabled = true;
  $('backtestStatus').textContent = `جاري تحميل بيانات سنة كاملة للفريمات الأربعة وتحليل المؤشرات والنماذج والسيولة. قد يستغرق عدة دقائق…`;
  $('backtestSummary').innerHTML = '';
  $('diagnostics').innerHTML = '';
  $('limitations').classList.add('hidden');
  try {
    const r = await fetch(`/api/backtest?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || data.error || 'فشل الاختبار');
    if (data.version !== 'V6' || !Number.isFinite(Number(data.netPnl))) {
      throw new Error('استجابة الخادم غير متوافقة. تأكد من نشر ملفات V6 الأربعة.');
    }
    renderV6Backtest(data);
    $('backtestStatus').textContent = `اكتمل اختبار سنة: ${symbol} · ${data.trades} صفقة · صافي ${money(data.netPnl)} بعد الرسوم والانزلاق.`;
  } catch (e) {
    $('backtestStatus').textContent = `تعذر الاختبار: ${e.message}`;
  } finally {
    $('backtestBtn').disabled = false;
  }
}
async function resetPaper() {
  if (!confirm('هل تريد حذف سجل التداول التجريبي وإعادة رأس المال إلى 50 دولاراً؟')) return;
  $('resetBtn').disabled = true;
  try {
    const r = await fetch('/api/reset', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'تعذرت إعادة الضبط');
    renderPortfolio(data.portfolio);
  } catch (e) {
    alert(e.message);
  } finally {
    $('resetBtn').disabled = false;
  }
}
$('refreshBtn').addEventListener('click', refreshMarket);
$('backtestBtn').addEventListener('click', runBacktest);
$('resetBtn').addEventListener('click', resetPaper);
refreshMarket();
setInterval(refreshMarket, 30000);
