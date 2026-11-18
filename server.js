const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = process.env.PORT || 8080;
const base = "https://data-api.binance.vision";
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

async function getJson(url) {
  const response = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Binance API returned HTTP ${response.status}`);
  return response.json();
}

async function marketData() {
  const pricesQuery = encodeURIComponent(JSON.stringify(symbols));
  const tickers = await getJson(`${base}/api/v3/ticker/24hr?symbols=${pricesQuery}`);
  const rows = await Promise.all(symbols.map(async (symbol) => {
    const candles = await getJson(`${base}/api/v3/klines?symbol=${symbol}&interval=4h&limit=30`);
    const ticker = tickers.find(item => item.symbol === symbol);
    const mapped = candles.map(c => ({
      openTime: c[0], open: Number(c[1]), high: Number(c[2]),
      low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]),
      closeTime: c[6], isClosed: c[6] < Date.now()
    }));
    return {
      symbol,
      price: ticker ? Number(ticker.lastPrice) : null,
      changePercent24h: ticker ? Number(ticker.priceChangePercent) : null,
      high24h: ticker ? Number(ticker.highPrice) : null,
      low24h: ticker ? Number(ticker.lowPrice) : null,
      quoteVolume24h: ticker ? Number(ticker.quoteVolume) : null,
      candles4h: mapped
    };
  }));
  return { source: "Binance Spot public market data", interval: "4h", quote: "USDT", updatedAt: new Date().toISOString(), assets: rows };
}

http.createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (pathname === "/api/market") {
    try {
      const data = await marketData();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: "تعذر جلب بيانات Binance حالياً", detail: error.message }));
    }
  }

  let requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = path.resolve(root, "." + requested);
  if (!filePath.startsWith(root + path.sep) && filePath !== path.join(root, "index.html")) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(port, "0.0.0.0", () => console.log(`Dashboard listening on ${port}`));
