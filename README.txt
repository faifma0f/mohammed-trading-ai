Mohammed Trading AI V8 - Configurable Historical Backtest

Deployment:
1. Replace the existing project files with these files (keep the filenames exactly as shown).
2. Commit/push to the connected GitHub repository used by Railway.
3. Railway should run: npm start (package.json starts node server.js).
4. Open the app and use the Historical Backtest section.

Backtest controls:
- Pair symbol, period (30/90/180/365 days)
- RSI minimum/maximum, relative volume threshold, minimum signal score
- Stop loss, TP1, TP2 and percentage of position sold at TP1

Important:
- These controls affect /api/backtest only. They do not alter live/paper-trading parameters or existing paper positions.
- Existing live Paper Trading settings remain as they were in the supplied V7 source.
- Backtest remains one symbol per run, uses 1d/4h/1h candles, fixed $5 allocation, 0.10% fee and 0.05% slippage per side.
- This update does not implement the proposed 15m/5m/3m strategy; it makes the existing historical test configurable.
- Binance public historical data access is required at runtime.
