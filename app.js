const names = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana" };
const fmt = (n) => n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 });
const money = (n) => n == null || !Number.isFinite(n) ? "—" : "$" + fmt(n);
const time = (s) => new Date(s).toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" });

async function refreshMarket() {
  const connection = document.getElementById("connection");
  const updated = document.getElementById("updated");
  const errorBox = document.getElementById("marketError");
  try {
    const response = await fetch("/api/market", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "Market data request failed");

    document.getElementById("marketRows").innerHTML = data.assets.map(asset => {
      const base = asset.symbol.replace("USDT", "");
      const change = asset.changePercent24h;
      const cls = change >= 0 ? "positive" : "negative";
      return `<tr>
        <td><b>${base}</b><small>${names[base] || base} / USDT</small></td>
        <td class="price">${money(asset.price)}</td>
        <td class="${cls}">${change > 0 ? "+" : ""}${change.toFixed(2)}%</td>
        <td>${money(asset.high24h)}</td><td>${money(asset.low24h)}</td>
      </tr>`;
    }).join("");

    document.getElementById("candleRows").innerHTML = data.assets.map(asset => {
      const c = asset.candles4h[asset.candles4h.length - 2] || asset.candles4h[asset.candles4h.length - 1];
      const base = asset.symbol.replace("USDT", "");
      if (!c) return "";
      const cls = c.close >= c.open ? "positive" : "negative";
      return `<div class="candle">
        <b>${base}</b><span>فتح: ${money(c.open)}</span><span>أعلى: ${money(c.high)}</span>
        <span>أدنى: ${money(c.low)}</span><span>إغلاق: ${money(c.close)}</span>
        <em class="${cls}">${c.close >= c.open ? "صاعدة" : "هابطة"}</em>
      </div>`;
    }).join("");

    connection.textContent = "متصل";
    connection.className = "connected";
    updated.textContent = "آخر تحديث: " + time(data.updatedAt);
    errorBox.hidden = true;
  } catch (error) {
    connection.textContent = "تعذر الاتصال";
    connection.className = "warn";
    errorBox.hidden = false;
    errorBox.textContent = "تعذر جلب بيانات Binance: " + error.message;
  }
}

refreshMarket();
setInterval(refreshMarket, 60000);
