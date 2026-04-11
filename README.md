# RO15 Live/Paper Trading Validator

Live validation environment for the RO15 (RiskOverlay-15%) trailing stop strategy.

## Strategy: RO15

- **Start**: Always IN position (buy at market start)
- **Track**: Peak price since entry
- **Exit**: When price drops 15% below peak (`price < peak * 0.85`)
- **Re-entry**: Immediately on next candle after exit
- **Always in market** (no cash position)

Based on validated research from `crypto-backtester` project.

## Quick Start

```bash
# Historical backtest only
npm run historical

# Start live/paper trading
npm start

# Or run directly
node ro15-paper-trader.mjs --historical-only
node ro15-paper-trader.mjs --live
```

## Output

### CSV Log (`logs/ro15-trades.csv`)

| Column | Description |
|--------|-------------|
| timestamp | ISO timestamp |
| asset | BTC or ETH |
| price | Current price |
| position | LONG or FLAT |
| peakPrice | Highest price since entry |
| trailLevel | Peak * 0.85 (exit trigger) |
| equity | Paper equity in EUR |
| unrealizedPnL | Open position P&L |
| realizedPnL | Closed trades P&L |
| event | ENTRY, EXIT, or HOLD |
| tradeReturn | Return on exited trade (%) |
| cumFees | Cumulative fees paid |

### Console Output

- Entry/Exit events logged with price, return, equity
- Summary after historical run
- Live polling status every hour

## Configuration

Edit `ro15-paper-trader.mjs` CONFIG section:

```javascript
const CONFIG = {
  assets: ['BTC', 'ETH'],      // Assets to trade
  trailPct: 0.15,              // 15% trailing stop
  pollIntervalMs: 60 * 60 * 1000, // 1 hour between checks
  initialCapital: 10000,       // EUR paper money
  feePct: 0.1,                 // 0.1% trading fee
  slippagePct: 0.05,           // 0.05% slippage
  dataPoints: 168,             // ~7 days of 1h candles for initial load
};
```

## Data Source

Binance public API (no API key required):
- Endpoint: `https://api.binance.com/api/v3/klines`
- Symbol: BTCUSDT, ETHUSDT
- Interval: 1h candles

## Mode

- **Paper trading only** — no real orders
- **Shadow mode** — simulates trades, tracks equity
- **No optimization** — execute and observe

## Workflow

1. Run historical backtest to verify strategy behavior
2. Compare results with backtester engine (should match)
3. Start live mode to track real-time signals
4. Compare live signals with historical patterns
5. Monitor for regime changes (RO15 works best in trending markets)

## Validation Goals

- [x] Strategy logic matches backtest engine exactly
- [x] CSV logging with all required fields
- [x] Binance public API integration
- [x] Paper trading with equity tracking
- [ ] Real-time signal monitoring
- [ ] Comparison with backtest results
- [ ] Alerting for regime changes

## Project Structure

```
crypto-live-validator/
  ro15-paper-trader.mjs    # Main trading engine
  package.json
  README.md
  logs/
    ro15-trades.csv        # Trade log
    state.json             # Persistent state
```

## Research Context

RO15 was validated in `crypto-backtester` project across:
- 2001 days of BTC/ETH data (Oct 2020 - Apr 2026)
- 18 walk-forward out-of-sample windows
- 5/5 robustness tests PASSED
- Sharpe 0.96 (best among 7 trail% variants)
- 83% win rate in OOS windows
