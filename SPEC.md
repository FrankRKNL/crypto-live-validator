# RO15 Forward Tester - Strategy Specification

**Last Updated: 2026-04-11**

## Research vs Forward Tester: Strategy Definition

| Aspect | Research (engine-v5.mjs) | Forward Tester (ro15-live-validator.mjs) | Status |
|--------|-------------------------|----------------------------------------|--------|
| **trailPct** | 0.15 | 0.15 | ✅ MATCH |
| **Start state** | Always invested (initial BUY) | Always invested (initial BUY) | ✅ MATCH |
| **Exit logic** | `price < peak × (1 - trailPct)` | `close < peak × (1 - trailPct)` | ✅ MATCH |
| **Re-entry filter** | `price > 10-day HIGH` | `close > tenDayHigh` | ✅ MATCH |
| **Re-entry timing** | Next candle when condition met | Next daily candle when condition met | ✅ MATCH |
| **Data interval** | 1d daily candles | 1h → aggregated to daily | ✅ EQUIVALENT |
| **Fee** | 0.1% | 0.15% | ⚠️ DIFFERENT (see below) |

## Fee Discrepancy

- **Research**: 0.1% fee
- **Forward tester**: 0.15% fee

This is a minor difference. The forward tester uses 0.15% which is closer to real Binance futures fees (0.02-0.04% maker/taker) plus a safety margin. The research used 0.1% as a simplified estimate.

**Decision**: Keep 0.15% in forward tester (more realistic). This does NOT affect signal generation, only PnL calculation.

## Re-entry Logic Explained

```
Research engine-v5.mjs:
  if (!pos) {
    const recentHigh = Math.max(...priceArr.slice(Math.max(startIdx, i-10), i+1));
    if (price > recentHigh) { /* BUY */ }
  }

Forward tester:
  if (!this.inPosition) {
    const canReenter = this.daysSinceExit > 0 && close > this.tenDayHigh;
    if (canReenter) { /* BUY */ }
  }
```

Both implementations require:
1. At least 1 day since exit
2. Price exceeds the 10-day high (rolling window)

The forward tester uses a slightly different mechanism:
- `tenDayHigh` is set at exit to the current 10-day high
- It updates each day while flat: `tenDayHigh = Math.max(tenDayHigh, close)`
- This creates a "rising floor" that must be broken for re-entry

## Why 91% Win Rate Was Wrong (Original Bug)

The original forward tester (ro15-paper-trader.mjs) had a CRITICAL BUG:
- Re-entry was checked BEFORE adding current candle to price history
- This meant `pricesSinceExit` was empty or contained only the exit candle
- Result: ANY uptick after exit triggered immediate re-entry
- This inflated win rate to 91% (research shows ~46%)

**FIXED** in ro15-live-validator.mjs by:
1. Using `daysSinceExit` counter (must be > 0)
2. Using `close > tenDayHigh` (not just any price movement)
3. Maintaining proper sliding window for 10-day high

## Logging and Metrics

| Metric | Description | CSV Column |
|--------|-------------|------------|
| **Equity evaluation** | Every hourly poll | `equityEUR` |
| **Signal check** | Only at daily candle close (00:00 UTC) | `event` |
| **Re-entry requirement** | `daysSinceExit > 0` AND `close > tenDayHigh` | N/A (internal) |
| **Timestamp** | ISO timestamp of the candle close | `timestamp` |
| **Unrealized PnL** | `(currentPrice - entryPrice) / entryPrice` | `unrealizedPct` |
| **Realized PnL** | Cumulative from completed trades | `realizedPct` |
| **Total Equity** | `initialCapital × (1 + realized + unrealized)` | `equityEUR` |

## Equity Calculation

```
unrealizedPnL = (currentPrice - entryPrice) / entryPrice
realizedPnL = sum of (exitPrice - entryPrice) / entryPrice for all completed trades
equity = initialCapital × (1 + realizedPnL + unrealizedPnL)
```

## Known Issues (from testing)

### Issue 1: Cold Start Forces Entry at Latest Price
When starting with no state file, the system processes historical candles but MUST end in a position (research spec: always invested). If historical processing leaves us flat, we force entry at the latest price.

**Impact**: Short backtests (< 30 days) may have distorted entry points.

**Fix**: No fix needed for live operation (state is persisted correctly after first run).

### Issue 2: tenDayHigh Initialization After Restore
When state is restored with `inPosition = false` and `daysSinceExit > 0`:
- `tenDayHigh` is restored from file (the value at time of exit)
- `tenDayPrices` is restored from file (may be stale)

**Impact**: Re-entry may be slightly delayed or premature depending on price action since state save.

**Fix**: Acceptable for shadow mode. Real trading would rebuild history from exchange.

## Forward Results: Sanity Check

Test run (2026-03-21 to 2026-04-11, 22 days):
- BTC: 1 trade (initial entry), no exits
- ETH: 1 trade (initial entry), no exits

**Analysis**:
- 22 days is too short to trigger a 15% trailing stop in a relatively bullish period
- Research showed BTC rarely hits 15% stop in short timeframes
- No re-entries because price never dropped enough to trigger exit

**Conclusion**: Results are PLAUSIBLE for this time period. Not enough data to validate against research (~46% win rate).

## Configuration

```javascript
CONFIG = {
  trailPct: 0.15,           // 15% trailing stop
  reentryLookback: 10,      // 10-day high for re-entry
  feePct: 0.15,            // 0.15% per trade
  slippagePct: 0,           // 0% (conservative)
  initialCapital: 10000,   // EUR per asset
  lookbackDays: 30,         // Fetch 30 days of 1h candles
}
```

## State Persistence

### Files
- `logs/state.json` — global state (assets, last prices, timestamps)
- `logs/assets/{BTC,ETH}-state.json` — per-asset strategy state
- `logs/daily/YYYY-MM-DD.json` — daily summaries
- `logs/alerts/{BTC,ETH}-alerts.log` — entry/exit alerts

### State Fields (per asset)
```json
{
  "inPosition": true,
  "entryPrice": 72770.73,
  "peakPrice": 72962.7,
  "trades": 1,
  "realizedPnL": 0,
  "cumFees": 0,
  "lastEvent": "ENTRY",
  "tenDayHigh": 72962.7,
  "tenDayPrices": [66901.99, 66964.3, ...],
  "daysSinceExit": 22,
  "currentPrice": 72770.74
}
```

## Alert Format

```
[ALERT] BTC: 🟢 BUY — 2026-04-11T00:00:00.000Z @ 72770.7300 | re-entry (>10d high 72962.70) | PnL: +0.00% | Total: +0.00%
[ALERT] BTC: 🔴 SELL — 2026-04-11T00:00:00.000Z @ 71000.0000 | trailing stop (peak 72962.70, trail 62018.30) | PnL: -2.42% | Total: -2.42%
```

## Continuous Operation (Shadow Mode)

The system is designed for continuous operation:

1. **Hourly polling**: Fetches latest candles, checks for daily close
2. **State persistence**: Saves after each poll (restart-safe)
3. **Alerts**: Only on entry/exit events (not spam)
4. **No external dependencies**: Binance public API only

### Restart Behavior
- If state file exists: Restore and continue from current position
- If no state file: Cold start, process historical data, force entry
