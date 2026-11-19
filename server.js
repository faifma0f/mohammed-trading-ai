const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const BINANCE = 'https://data-api.binance.vision';
const CAPITAL = 50;
const ALLOCATION_PER_TRADE = CAPITAL * 0.10; // $5 لكل صفقة
const STOP_LOSS_PCT = 0.20;                  // -20% من سعر الدخول
const TAKE_PROFIT_1_PCT = 0.10;               // +10%: بيع نصف الكمية
const TAKE_PROFIT_2_PCT = 0.30;               // +30%: بيع النصف المتبقي
const MAX_OPEN_POSITIONS = 3;
const MAX_SYMBOLS = 10;
const FEE_RATE = 0.001;       // تقدير 0.10% لكل تنفيذ؛ عدّله حسب فئة رسوم حسابك
const SLIPPAGE_RATE = 0.0005; // تقدير 0.05% لكل تنفيذ
const DB = path.join(ROOT, 'paper-state.json');
const STABLES = new Set([
  'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'USDPUSDT', 'DAIUSDT',
  'USDEUSDT', 'EURUSDT', 'BUSDUSDT'
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function freshState() {
  return {
    version: 5,
    initialCapital: CAPITAL,
    cash: CAPITAL,
    realizedPnl: 0,
    positions: [],
    trades: [],
    lastEntry: {}
  };
}
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(DB, 'utf8'));
    if (!s || !Array.isArray(s.positions) || !Array.isArray(s.trades)) return freshState();
    return { ...freshState(), ...s, version: 5 };
  } catch {
    return freshState();
  }
}
let state = loadState();
function saveState() {
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB);
}
async function getJson(url) {
  const r = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  return r.json();
}
function mapRows(rows) {
  return rows.map(c => ({
    openTime: +c[0], open: +c[1], high: +c[2], low: +c[3],
    close: +c[4], volume: +c[5], closeTime: +c[6]
  }));
}
function ema(values, period) {
  if (values.length < period) return null;
  let v = 0;
  for (let i = 0; i < period; i++) v += values[i];
  v /= period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) v = values[i] * k + v * (1 - k);
  return v;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / period;
}
function analyze(candles, now = Date.now()) {
  const closed = candles.filter(c => c.closeTime < now);
  if (closed.length < 205) return { ready: false, count: closed.length };
  const closes = closed.map(c => c.close);
  const last = closed[closed.length - 1];
  return {
    ready: true, count: closed.length, close: last.close,
    previousClose: closed[closed.length - 2].close,
    ema20: ema(closes, 20), ema50: ema(closes, 50), ema200: ema(closes, 200),
    rsi14: rsi(closes), atr14: atr(closed), candleTime: last.closeTime
  };
}
function signal(a1h, a15, a5, a3, price) {
  const ready = [a1h, a15, a5, a3].every(a => a && a.ready);
  if (!ready) return {
    status: 'DATA_WAIT', label: 'بانتظار البيانات', reason: 'بيانات غير كافية',
    diagnostics: { '1h': a1h?.count || 0, '15m': a15?.count || 0, '5m': a5?.count || 0, '3m': a3?.count || 0 }
  };
  const trend1h = a1h.close > a1h.ema50 && a1h.ema50 > a1h.ema200;
  const trend15 = a15.close > a15.ema50 && a15.ema50 > a15.ema200;
  const confirm5 = a5.close > a5.ema20 && a5.ema20 > a5.ema50 && a5.rsi14 >= 50 && a5.rsi14 <= 70;
  const entry3 = a3.close > a3.ema20 && a3.close > a3.previousClose && a3.rsi14 >= 50 && a3.rsi14 <= 70;
  const bearish15 = a15.close < a15.ema50 && a15.ema50 < a15.ema200;
  const status = trend1h && trend15 && confirm5 && entry3 ? 'BUY' :
    (bearish15 ? 'NO_BUY' : 'WAIT');
  const distance = a3.atr14 * 1.5;
  const stop = price - distance;
  return {
    status,
    label: status === 'BUY' ? 'إشارة شراء تجريبية' : status === 'NO_BUY' ? 'تجنب الشراء' : 'انتظار',
    reason: status === 'BUY' ? 'توافق 1H و15m و5m و3m' :
      !trend1h ? 'فلتر 1H غير متحقق' :
      !trend15 ? 'اتجاه 15m غير متحقق' :
      !confirm5 ? 'تأكيد 5m غير متحقق' : 'إشارة الدخول 3m غير متحققة',
    checks: {
      trend1h: trend1h ? 'صاعد' : 'غير متحقق',
      trend15: trend15 ? 'صاعد' : bearish15 ? 'هابط' : 'محايد',
      confirm5: confirm5 ? 'إيجابي' : 'غير متحقق',
      entry3: entry3 ? 'متحقق' : 'غير متحقق',
      rsi1h: a1h.rsi14, rsi15: a15.rsi14, rsi5: a5.rsi14, rsi3: a3.rsi14
    },
    risk: {
      allocationUsd: ALLOCATION_PER_TRADE,
      stopPrice: price * (1 - STOP_LOSS_PCT),
      target1Price: price * (1 + TAKE_PROFIT_1_PCT),
      target2Price: price * (1 + TAKE_PROFIT_2_PCT),
      estimatedLossUsd: ALLOCATION_PER_TRADE * STOP_LOSS_PCT,
      quantityBase: price > 0 ? ALLOCATION_PER_TRADE / price : null,
      notionalUsd: ALLOCATION_PER_TRADE,
      management: 'TP1 +10% sell half, move remaining stop to entry; TP2 +30%'
    },
    candleTimes: { h1: a1h.candleTime, m15: a15.candleTime, m5: a5.candleTime, m3: a3.candleTime }
  };
}

async function getTopSymbols() {
  const [tickers, info] = await Promise.all([
    getJson(`${BINANCE}/api/v3/ticker/24hr`),
    getJson(`${BINANCE}/api/v3/exchangeInfo`)
  ]);
  const tradable = new Set(info.symbols
    .filter(s => s.status === 'TRADING' && s.isSpotTradingAllowed === true &&
      s.quoteAsset === 'USDT')
    .map(s => s.symbol));
  return tickers
    .filter(t => tradable.has(t.symbol) && !STABLES.has(t.symbol) &&
      Number(t.quoteVolume) > 1000000 && Number(t.lastPrice) > 0)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, MAX_SYMBOLS)
    .map(t => t.symbol);
}
async function getAsset(symbol) {
  const intervals = ['1h', '15m', '5m', '3m'];
  const [ticker, ...klines] = await Promise.all([
    getJson(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`),
    ...intervals.map(tf => getJson(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=250`))
  ]);
  const analyses = klines.map(rows => analyze(mapRows(rows)));
  const price = +ticker.lastPrice;
  return {
    symbol, price, changePercent24h: +ticker.priceChangePercent,
    quoteVolume24h: +ticker.quoteVolume, high24h: +ticker.highPrice, low24h: +ticker.lowPrice,
    analysis: { '1h': analyses[0], '15m': analyses[1], '5m': analyses[2], '3m': analyses[3] },
    signal: signal(analyses[0], analyses[1], analyses[2], analyses[3], price)
  };
}
function executePaper(assets) {
  const now = Date.now();

  // Manage existing positions first: stop, TP1 (half + move stop to entry), then TP2.
  for (const pos of [...state.positions]) {
    const asset = assets.find(a => a.symbol === pos.symbol);
    if (!asset) continue;
    const price = asset.price;
    pos.markPrice = price;

    if (price <= pos.stopPrice) {
      closePosition(pos, pos.stopPrice, pos.partialTaken ? 'وقف التعادل بعد TP1' : 'وقف خسارة -20%', now);
      continue;
    }

    if (!pos.partialTaken && price >= pos.target1Price) {
      closePosition(pos, pos.target1Price, 'TP1 +10% (بيع نصف الكمية)', now, 0.5);
      const remaining = state.positions.find(p => p.id === pos.id);
      if (remaining) {
        remaining.partialTaken = true;
        remaining.stopPrice = remaining.entryPrice;
        remaining.markPrice = price;
      }
    }

    const remaining = state.positions.find(p => p.id === pos.id);
    if (remaining && remaining.partialTaken && price <= remaining.stopPrice) {
      closePosition(remaining, remaining.stopPrice, 'وقف التعادل بعد TP1', now);
      continue;
    }
    if (remaining && remaining.partialTaken && price >= remaining.target2Price) {
      closePosition(remaining, remaining.target2Price, 'TP2 +30% (بيع المتبقي)', now);
    }
  }

  // New positions: 10% of initial $50 = $5 each, maximum three at once.
  for (const asset of assets) {
    if (state.positions.length >= MAX_OPEN_POSITIONS) break;
    if (asset.signal.status !== 'BUY') continue;
    if (state.positions.some(p => p.symbol === asset.symbol)) continue;
    const candle = asset.signal.candleTimes?.m3;
    if (!candle || state.lastEntry[asset.symbol] === candle) continue;

    const entryPrice = asset.price * (1 + SLIPPAGE_RATE);
    const qty = ALLOCATION_PER_TRADE / entryPrice;
    const notional = qty * entryPrice;
    const entryFee = notional * FEE_RATE;
    if (!(qty > 0) || notional + entryFee > state.cash) continue;

    const stopPrice = entryPrice * (1 - STOP_LOSS_PCT);
    const target1Price = entryPrice * (1 + TAKE_PROFIT_1_PCT);
    const target2Price = entryPrice * (1 + TAKE_PROFIT_2_PCT);
    const estimatedStopLoss = (entryPrice - stopPrice) * qty + entryFee +
      stopPrice * qty * (FEE_RATE + SLIPPAGE_RATE);

    state.cash -= notional + entryFee;
    state.positions.push({
      id: `${asset.symbol}-${now}`, symbol: asset.symbol,
      entryPrice, stopPrice, target1Price, target2Price,
      quantity: qty, originalQuantity: qty, notional,
      entryFee, riskUsd: estimatedStopLoss,
      openedAt: now, entryCandle: candle, markPrice: asset.price,
      partialTaken: false, allocationUsd: ALLOCATION_PER_TRADE
    });
    state.lastEntry[asset.symbol] = candle;
  }
  saveState();
}
function closePosition(pos, rawPrice, reason, now = Date.now(), fraction = 1) {
  const qty = pos.quantity * fraction;
  const exitPrice = rawPrice * (1 - SLIPPAGE_RATE);
  const gross = (exitPrice - pos.entryPrice) * qty;
  const exitFee = exitPrice * qty * FEE_RATE;
  const allocatedEntryFee = pos.entryFee * fraction;
  const pnl = gross - exitFee - allocatedEntryFee;
  state.cash += exitPrice * qty - exitFee;
  state.realizedPnl += pnl;
  pos.quantity -= qty;
  pos.notional = pos.quantity * pos.entryPrice;
  pos.entryFee -= allocatedEntryFee;
  state.trades.unshift({
    ...pos, quantity: qty, status: pnl >= 0 ? 'WIN' : 'LOSS',
    exitPrice, exitTime: now, pnl, exitReason: reason,
    entryFee: allocatedEntryFee, exitFee
  });
  if (pos.quantity <= 1e-12) state.positions = state.positions.filter(x => x.id !== pos.id);
}
function portfolio() {
  const unrealized = state.positions.reduce((sum, p) => {
    const mark = p.markPrice || p.entryPrice;
    return sum + (mark - p.entryPrice) * p.quantity -
      (mark * p.quantity * (FEE_RATE + SLIPPAGE_RATE));
  }, 0);
  const invested = state.positions.reduce((sum, p) => sum + p.quantity * p.entryPrice, 0);
  return {
    initialCapital: state.initialCapital, cash: state.cash, realizedPnl: state.realizedPnl,
    unrealizedPnl: unrealized, openCount: state.positions.length, closedCount: state.trades.length,
    maxOpenPositions: MAX_OPEN_POSITIONS, winRate: state.trades.length ?
      state.trades.filter(t => t.pnl > 0).length / state.trades.length * 100 : 0,
    positions: state.positions, trades: state.trades.slice(0, 100),
    equity: state.cash + invested + unrealized
  };
}
async function market() {
  const symbols = await getTopSymbols();
  const results = await Promise.allSettled(symbols.map(getAsset));
  const assets = results.filter(x => x.status === 'fulfilled').map(x => x.value);
  const errors = results.filter(x => x.status === 'rejected').map(x => x.reason.message);
  executePaper(assets);
  return {
    source: 'Binance Spot public market data', updatedAt: new Date().toISOString(),
    mode: 'paper_only', capitalUsd: CAPITAL, maxLossUsdPerPosition: ALLOCATION_PER_TRADE * STOP_LOSS_PCT,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    strategy: { allocationUsdPerTrade: ALLOCATION_PER_TRADE, stopLossPercent: STOP_LOSS_PCT * 100, takeProfit1Percent: TAKE_PROFIT_1_PCT * 100, takeProfit1SellPercent: 50, takeProfit2Percent: TAKE_PROFIT_2_PCT * 100 },
    symbols, assets, errors, portfolio: portfolio()
  };
}

// Historical candles are paginated; Binance limits each response to 1000 rows.
async function getHistorical(symbol, interval, total = 10000) {
  const all = [];
  let endTime = undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    let url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (endTime !== undefined) url += `&endTime=${endTime}`;
    const rows = await getJson(url);
    if (!rows.length) break;
    all.unshift(...mapRows(rows));
    const earliest = +rows[0][0];
    if (earliest <= 0 || rows.length < limit) break;
    endTime = earliest - 1;
  }
  const unique = new Map();
  for (const c of all) if (c.closeTime < Date.now()) unique.set(c.openTime, c);
  return [...unique.values()].sort((a, b) => a.openTime - b.openTime).slice(-total);
}
function indicatorSeries(candles) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  const closes = candles.map(c => c.close);
  const ema20 = new Array(n).fill(null);
  const ema50 = new Array(n).fill(null);
  const ema200 = new Array(n).fill(null);
  const rsi14 = new Array(n).fill(null);
  const atr14 = new Array(n).fill(null);

  function fillEma(period, target) {
    if (n < period) return;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    target[period - 1] = sum / period;
    const k = 2 / (period + 1);
    for (let i = period; i < n; i++) target[i] = closes[i] * k + target[i - 1] * (1 - k);
  }
  fillEma(20, ema20);
  fillEma(50, ema50);
  fillEma(200, ema200);

  if (n > 14) {
    let gain = 0, loss = 0;
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    gain /= 14; loss /= 14;
    rsi14[14] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = 15; i < n; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * 13 + Math.max(d, 0)) / 14;
      loss = (loss * 13 + Math.max(-d, 0)) / 14;
      rsi14[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    const trueRanges = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
      const c = candles[i], p = candles[i - 1];
      trueRanges[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    // Match the live atr() function: simple mean of the latest 14 true ranges.
    let trSum = 0;
    for (let i = 1; i <= 14; i++) trSum += trueRanges[i];
    atr14[14] = trSum / 14;
    for (let i = 15; i < n; i++) {
      trSum += trueRanges[i] - trueRanges[i - 14];
      atr14[i] = trSum / 14;
    }
  }

  for (let i = 204; i < n; i++) {
    out[i] = {
      ready: true, count: i + 1, close: closes[i],
      previousClose: closes[i - 1],
      ema20: ema20[i], ema50: ema50[i], ema200: ema200[i],
      rsi14: rsi14[i], atr14: atr14[i], candleTime: candles[i].closeTime
    };
  }
  return out;
}
function latestAt(series, candles, time, pointer) {
  while (pointer.index + 1 < candles.length && candles[pointer.index + 1].closeTime <= time) pointer.index++;
  return pointer.index >= 204 ? series[pointer.index] : null;
}
function feeAdjustedEntry(raw) { return raw * (1 + SLIPPAGE_RATE); }
function feeAdjustedExit(raw) { return raw * (1 - SLIPPAGE_RATE); }
function simulateTrade(candles, index, entry, maxMinutes) {
  const qty = ALLOCATION_PER_TRADE / entry;
  const stopInitial = entry * (1 - STOP_LOSS_PCT);
  const target1 = entry * (1 + TAKE_PROFIT_1_PCT);
  const target2 = entry * (1 + TAKE_PROFIT_2_PCT);
  let remaining = qty;
  let pnl = 0;
  let totalFees = entry * qty * FEE_RATE;
  let partialTaken = false;
  let activeStop = stopInitial;
  let exitTime = null;
  let exitReason = null;
  let lastSeen = index;
  const endTime = candles[index].openTime + maxMinutes * 60000;

  function realize(rawPrice, amount) {
    const fill = rawPrice * (1 - SLIPPAGE_RATE);
    const fee = fill * amount * FEE_RATE;
    pnl += (fill - entry) * amount - fee;
    totalFees += fee;
  }

  for (let j = index; j < candles.length; j++) {
    const candle = candles[j];
    if (candle.openTime > endTime) break;
    lastSeen = j;

    // Conservative gap handling and stop-first OHLC convention.
    if (candle.low <= activeStop) {
      const fill = candle.open < activeStop ? candle.open : activeStop;
      realize(fill, remaining);
      exitTime = candle.closeTime;
      exitReason = partialTaken ? 'BREAKEVEN_AFTER_TP1' : 'STOP_LOSS_20_PERCENT';
      remaining = 0;
      break;
    }

    if (!partialTaken && candle.high >= target1) {
      const fill = candle.open > target1 ? candle.open : target1;
      const half = remaining * 0.5;
      realize(fill, half);
      remaining -= half;
      partialTaken = true;
      activeStop = entry;

      // If same candle also reaches entry on the downside, assume the
      // remaining half is stopped at breakeven (conservative OHLC ordering).
      if (candle.low <= entry) {
        realize(entry, remaining);
        exitTime = candle.closeTime;
        exitReason = 'BREAKEVEN_AFTER_TP1';
        remaining = 0;
        break;
      }
    }

    if (partialTaken && candle.high >= target2) {
      const fill = candle.open > target2 ? candle.open : target2;
      realize(fill, remaining);
      exitTime = candle.closeTime;
      exitReason = 'TAKE_PROFIT_2_30_PERCENT';
      remaining = 0;
      break;
    }

    if (candle.closeTime >= endTime) {
      realize(candle.close, remaining);
      exitTime = candle.closeTime;
      exitReason = partialTaken ? 'TIME_EXIT_AFTER_TP1' : 'TIME_EXIT';
      remaining = 0;
      break;
    }
  }

  if (remaining > 0) {
    const last = candles[lastSeen];
    realize(last.close, remaining);
    exitTime = last.closeTime;
    exitReason = partialTaken ? 'TIME_EXIT_AFTER_TP1' : 'TIME_EXIT_DATA_END';
    remaining = 0;
  }

  const stopFill = stopInitial * (1 - SLIPPAGE_RATE);
  const stopRiskEstimate = (entry - stopFill) * qty +
    entry * qty * FEE_RATE + stopFill * qty * FEE_RATE;
  return {
    entryTime: candles[index].openTime, exitTime, entry,
    stop: stopInitial, target1, target2, qty,
    notional: entry * qty, pnl, reason: exitReason,
    partialTaken, estimatedRiskIncludingCosts: stopRiskEstimate,
    totalFees, allocationUsd: ALLOCATION_PER_TRADE
  };
}
function summarizeTrades(trades, label, symbol) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  let equity = CAPITAL, peak = CAPITAL, maxDrawdown = 0;
  for (const t of trades) {
    equity += t.pnl; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak * 100 : 0);
  }
  return {
    label, symbol, trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    netPnl: trades.reduce((s, t) => s + t.pnl, 0),
    profitFactor: grossLoss ? grossWin / grossLoss : (grossWin ? null : 0),
    expectancy: trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0,
    maxDrawdownPercent: maxDrawdown,
    avgHoldingMinutes: trades.length ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime) / 60000, 0) / trades.length : 0,
    stopExits: trades.filter(t => t.reason === 'STOP_LOSS_20_PERCENT').length,
    breakevenExits: trades.filter(t => t.reason === 'BREAKEVEN_AFTER_TP1').length,
    target1Trades: trades.filter(t => t.partialTaken).length,
    target2Exits: trades.filter(t => t.reason === 'TAKE_PROFIT_2_30_PERCENT').length,
    timeExits: trades.filter(t => String(t.reason).includes('TIME_EXIT')).length,
    totalFees: trades.reduce((s, t) => s + (t.totalFees || 0), 0),
    avgEstimatedRisk: trades.length ? trades.reduce((s, t) => s + (t.estimatedRiskIncludingCosts || 0), 0) / trades.length : 0,
    sample: trades.slice(-30)
  };
}
async function backtest(res) {
  try {
    const url = new URL(res.req.url, 'http://localhost');
    const requested = url.searchParams.get('symbol') || 'BTCUSDT';
    const symbol = requested.toUpperCase();
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new Error('صيغة الرمز غير صحيحة؛ استخدم زوجاً مقابل USDT مثل BTCUSDT');
    const [h1, m15, m5, m3] = await Promise.all([
      getHistorical(symbol, '1h'), getHistorical(symbol, '15m'),
      getHistorical(symbol, '5m'), getHistorical(symbol, '3m')
    ]);
    const series = {
      h1: indicatorSeries(h1), m15: indicatorSeries(m15),
      m5: indicatorSeries(m5), m3: indicatorSeries(m3)
    };
    const comparisons = [];
    const diagnostics = { scanned3mCandles: 0, candidateSignals: 0, rejected: { data: 0, h1: 0, m15: 0, m5: 0, m3: 0 } };
    for (const minutes of [30, 60, 120]) {
        const trades = [];
        const ptr = { h1: { index: -1 }, m15: { index: -1 }, m5: { index: -1 } };
        let nextAllowedTime = 0;
        for (let i = 205; i < m3.length - 1; i++) {
          const c = m3[i];
          if (c.closeTime >= Date.now() || c.openTime < nextAllowedTime) continue;
          diagnostics.scanned3mCandles++;
          const a1 = latestAt(series.h1, h1, c.closeTime, ptr.h1);
          const a15 = latestAt(series.m15, m15, c.closeTime, ptr.m15);
          const a5 = latestAt(series.m5, m5, c.closeTime, ptr.m5);
          const a3 = series.m3[i];
          if (!a1 || !a15 || !a5 || !a3) { diagnostics.rejected.data++; continue; }
          if (!(a1.close > a1.ema50 && a1.ema50 > a1.ema200)) { diagnostics.rejected.h1++; continue; }
          if (!(a15.close > a15.ema50 && a15.ema50 > a15.ema200)) { diagnostics.rejected.m15++; continue; }
          if (!(a5.close > a5.ema20 && a5.ema20 > a5.ema50 && a5.rsi14 >= 50 && a5.rsi14 <= 70)) { diagnostics.rejected.m5++; continue; }
          if (!(a3.close > a3.ema20 && a3.close > a3.previousClose && a3.rsi14 >= 50 && a3.rsi14 <= 70)) { diagnostics.rejected.m3++; continue; }
          diagnostics.candidateSignals++;
          const entryRaw = m3[i + 1].open;
          const entry = feeAdjustedEntry(entryRaw);
          const trade = simulateTrade(m3, i + 1, entry, minutes);
          trades.push(trade);
          nextAllowedTime = trade.exitTime || c.closeTime;
        }
        comparisons.push(summarizeTrades(trades, `TP1 +10% / TP2 +30% / ${minutes} min`, symbol));
    }
    const sharedStart = Math.max(h1[0]?.openTime || 0, m15[0]?.openTime || 0, m5[0]?.openTime || 0, m3[0]?.openTime || 0);
    const sharedEnd = Math.min(h1.at(-1)?.closeTime || 0, m15.at(-1)?.closeTime || 0, m5.at(-1)?.closeTime || 0, m3.at(-1)?.closeTime || 0);
    const defaultResult = comparisons.find(x => x.label.endsWith('/ 60 min')) || comparisons[0];
    send(res, {
      version: 'V5.3', symbol, intervals: ['1h', '15m', '5m', '3m'],
      // Legacy summary fields are retained so the existing V4 dashboard can still render a result.
      trades: defaultResult.trades, wins: defaultResult.wins, losses: defaultResult.losses,
      winRate: defaultResult.winRate, netPnl: defaultResult.netPnl,
      profitFactor: defaultResult.profitFactor, sample: defaultResult.sample,
      candleCounts: { '1h': h1.length, '15m': m15.length, '5m': m5.length, '3m': m3.length },
      sharedPeriod: { start: new Date(sharedStart).toISOString(), end: new Date(sharedEnd).toISOString() },
      comparisons, diagnostics,
      costs: { feeRatePerSide: FEE_RATE, slippageRatePerSide: SLIPPAGE_RATE },
      strategy: {
        allocationUsdPerTrade: ALLOCATION_PER_TRADE,
        allocationPercentOfCapital: 10,
        maxOpenPositions: MAX_OPEN_POSITIONS,
        stopLossPercent: STOP_LOSS_PCT * 100,
        takeProfit1Percent: TAKE_PROFIT_1_PCT * 100,
        takeProfit1SellPercent: 50,
        afterTakeProfit1: 'Sell half; move remaining stop to entry price',
        takeProfit2Percent: TAKE_PROFIT_2_PCT * 100,
        takeProfit2SellPercent: 100
      },
      limitations: [
        'قائمة أفضل 10 تُختار من بيانات السوق الحالية؛ لا تتوفر هنا لقطات تاريخية موثقة لقائمة الأزواج المؤهلة، لذلك لا يمكن إزالة انحياز البقاء بالكامل.',
        'الاختبار التاريخي لكل رمز على حدة وبحجم دخول ثابت 5 دولارات؛ لا يحاكي تداخل صفقات عدة رموز في محفظة واحدة. التداول الحي التجريبي يقيّد المراكز المفتوحة بثلاثة وبقيمة 5 دولارات لكل مركز.',
        'إدارة الصفقة المعتمدة: دخول بقيمة 5 دولارات، وقف عند -20% من سعر الدخول، بيع نصف الكمية عند +10%، ثم نقل وقف النصف المتبقي إلى سعر الدخول، وبيع الباقي عند +30%.',
        'الاختبار يستخدم شموع OHLC؛ ترتيب الحركة داخل الشمعة غير معروف، لذا يُحتسب الوقف أولاً عند لمس الوقف والهدف معاً.'
      ]
    });
  } catch (e) {
    send(res, { error: 'تعذر تنفيذ الاختبار', detail: e.message }, 502);
  }
}
function send(res, obj, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/market') {
    try { send(res, await market()); }
    catch (e) { send(res, { error: 'تعذر جلب بيانات Binance', detail: e.message }, 502); }
    return;
  }
  if (u.pathname === '/api/portfolio') { send(res, portfolio()); return; }
  if (u.pathname === '/api/backtest') { await backtest(res); return; }
  if (u.pathname === '/api/reset' && req.method === 'POST') {
    state = freshState(); saveState(); send(res, { ok: true, portfolio: portfolio() }); return;
  }
  const p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  const f = path.resolve(ROOT, '.' + p);
  if (!f.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); }
    else { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(data); }
  });
}).listen(PORT, '0.0.0.0', () => console.log(`Mohammed Trading AI V5.3 paper server on ${PORT}`));
