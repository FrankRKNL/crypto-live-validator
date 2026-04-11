# RO15 Forward Tester - Strategy Specification

## Research vs Forward Tester Comparison

| Aspect | Research (engine-v5.mjs) | Forward Tester (before fix) | Forward Tester (FIXED) |
|--------|-------------------------|----------------------------|------------------------|
| **trailPct** | 0.15 | 0.15 | 0.15 |
| **Start state** | Always invested (BUY at start) | IN position | IN position |
| **Exit** | price < peak × (1 - trailPct) | price < peak × (1 - trailPct) | price < peak × (1 - trailPct) |
| **Re-entry** | price > 10-day high | **next candle (WRONG)** | price > 10-day high |
| **MA filter** | None | MA20 mentioned but NOT implemented | None |
| **Data interval** | 1d (daily candles) | 1h (hourly candles) | 1h (hourly candles) |
| **Signals evaluated** | Daily | Hourly | Hourly |

## Key Finding: 91% Win Rate is INVALID

The 91% win rate reported by the unfixed forward tester is WRONG because:
- Immediate re-entry on next candle creates many small winning trades
- Research RO15 has ~46% win rate with convex payoff (few big wins, many small losses)
- The 91% was due to the broken re-entry logic

## Corrected RO15 Strategy Spec

### Entry
- **Initial**: BUY at market price at strategy start (always invested)
- **Re-entry**: BUY when price breaks above the 10-calendar-day high (since exit)

### Exit
- **Trailing stop**: SELL when price drops below peak × (1 - 0.15)
- Peak is continuously updated while in position

### Re-entry Filter
- Price must exceed the highest price seen in the 10 days BEFORE the exit candle
- This prevents immediate re-entry whipsaw

### Position State
- Always in market (either LONG or FLAT, never cash)
- When FLAT, wait for 10-day high breakout to re-enter

### Interval
- Data: 1h candles from Binance (USDT pairs)
- Polling: every 1 hour
- Equity: updated every candle

### Fees
- Fee: 0.1% per trade
- Slippage: 0.05% per trade

### Metrics Logged
Per CSV row:
- `timestamp`: ISO timestamp of the candle
- `asset`: BTC or ETH
- `price`: close price of candle
- `position`: LONG or FLAT
- `peakPrice`: highest price since entry
- `trailLevel`: current stop level (peak × 0.85)
- `equity`: current portfolio value in USDT
- `unrealizedPnL`: (current - entry) × capital (not yet realized)
- `realizedPnL`: cumulative realized PnL from trades
- `event`: INIT, ENTRY, HOLD, EXIT, REENTRY
- `tradeReturn`: return of the completed trade (%)
- `cumFees`: cumulative fees paid

## Why 1h Instead of 1d?

Research used daily data (1d). Forward tester uses 1h for:
- Faster signal detection
- More granular equity curve
- Earlier detection of regime changes

**Note**: The strategy logic is IDENTICAL regardless of interval. The trailing stop % and 10-day high are calendar-based (not candle-count based).

## Assets
- BTCUSDT
- ETHUSDT

## State Persistence

File: `logs/state.json`
```json
{
  "timestamp": "ISO",
  "assets": {
    "BTC": {
      "inPosition": true,
      "entryPrice": 65000,
      "peakPrice": 70000,
      "realizedPnL": 0.12,
      "cumFees": 15.50,
      "trades": 5,
      "lastEvent": "HOLD"
    }
  }
}
```

## Daily Summary

File: `logs/daily/YYYY-MM-DD.json`
```json
{
  "date": "2026-04-11",
  "BTC": { "open": 65000, "close": 67000, "high": 68000, "low": 64500, "equity": 11500, "position": "LONG" },
  "ETH": { "open": 3200, "close": 3350, "high": 3400, "low": 3180, "equity": 10800, "position": "FLAT" }
}
```

## Alert Events

When event is EXIT or REENTRY, output:
```
[ALERT] BTC: EXIT at 65234.56 | Return: -3.45% | Equity: 9655.00
[ALERT] BTC: REENTRY at 66100.00 | Equity: 9655.00
```
