# RO15 Live Shadow-Mode Validator

Production-ready live shadow-mode validation of the RO15 (RiskOverlay-15%) trailing stop strategy. Runs in deployment-validation mode: monitoring live, no real orders, no paper orders yet.

**Mode: SHADOW ONLY** — no real orders, no exchange execution. Only signals, state, and logging.

## Strategy Specification (exact research spec — DO NOT CHANGE)

| Parameter | Value | Notes |
|-----------|-------|-------|
| Start | Always IN position | Buy at market on first run |
| Exit | Price < peak × 0.85 | 15% trailing stop |
| Re-entry | Price > 10-trading-day high | After exit, only |
| Fee | 0.15% per trade | Research spec |
| Slippage | 0% | Research spec |
| Signal basis | **Daily candle closes ONLY** | No intraday pseudo-signals |
| Poll interval | Hourly | Technical only |

## Quick Start

```bash
# One-shot (for cron)
npm run once
node ro15-live-validator.mjs

# Continuous live polling
npm start
node ro15-live-validator.mjs --live
```

## Map Structure

```
crypto-live-validator/
  ro15-live-validator.mjs     # Main engine
  package.json
  README.md
  SPEC.md                      # Strategy specification
  logs/
    validator-YYYY-MM-DD.log   # Daily console log (all output)
    state.json                 # Global state (restart reference)
    assets/
      BTC-state.json           # BTC persistent trading state
      ETH-state.json           # ETH persistent trading state
    daily/
      summary-YYYY-MM-DD.csv   # Daily equity snapshots (append-only)
    alerts/
      BTC-alerts.log           # BTC entry/exit events only
      ETH-alerts.log           # ETH entry/exit events only
```

## Monitoring Output (per poll)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  RO15 SHADOW MONITOR  |  2026-04-11  |  SHADOW MODE                                            │
├──────────┬────────┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────────────────┤
│ ASSET   │ POS    │ PRICE    │ PEAK     │ TRAIL    │ DIST     │ EQUITY   │ LAST EVENT          │
├──────────┼────────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────────────────┤
│ BTC      │ LONG │ 72766.55 │ 72962.70 │ 62018.29 │ 14.8%    │  9999.42 €│ ENTRY               │
│          │ unrealized: -0.01% (-0.58 €) | realized: +0.00% | trades: 1                       │
│ ETH      │ LONG │ 2234.23  │ 2245.05  │ 1908.29  │ 14.6%    │ 10000.00 €│ ENTRY               │
├──────────┴────────┴──────────┴──────────┴──────────┴──────────┴──────────┴─────────────────────┤
│  TOTAL PORTFOLIO: 19999.42 €  |  started: 2026-04-11  |  validation period: 2–4 weeks  │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Field definitions

| Field | Description |
|-------|-------------|
| POS | Current position: LONG or FLAT |
| PRICE | Latest price (today's ongoing candle close) |
| PEAK | Highest close since entry (for trailing stop) |
| TRAIL | Exit trigger level (peak × 0.85) |
| DIST | Distance from PRICE to TRAIL (% of price) |
| EQUITY | Current paper equity in EUR |
| unrealized | Open PnL % — current vs entry (position still open) |
| realized | Closed-trade PnL % (cumulative) |
| trades | Total completed trades |
| 10d high | Price to exceed for re-entry (only when FLAT) |

## State Recovery (restart-safe)

The system is fully restart-safe. On startup:

1. `loadAssetState()` reads `logs/assets/{ASSET}-state.json`
2. Saved state is hydrated (inPosition, entryPrice, peakPrice, tenDayPrices, etc.)
3. Fresh market data is fetched from Binance
4. Peak is updated with any new highs since last run
5. Equity is recalculated from current prices
6. Signals are re-evaluated only on newly-closed daily candles

**What is persisted per asset:**
- `inPosition`, `entryPrice`, `peakPrice`
- `currentPrice` (latest known price)
- `realizedPnL`, `cumFees`, `trades`
- `tenDayHigh`, `tenDayPrices[]`, `daysSinceExit`

**Cold start:** If no saved state exists, all available historical daily candles are processed. Entry is forced at the most recent close (always-in-position research spec).

## Example Logs

### Entry alert
```
[2026-04-11T08:00:00.000Z] [ALERT] BTC: 🟢 BUY — re-entry (>10d high 72962.70) | PnL: +0.00% | Total: +0.00%
```

### Exit alert
```
[2026-04-12T08:00:00.000Z] [ALERT] BTC: 🔴 SELL — trailing stop (peak 75623.91, trail 64280.32) | PnL: -8.50% | Total: -8.50%
```

### Daily poll (no new candle)
```
[2026-04-11T09:00:00.000Z] [INFO ] ───────────────────────────────────────────────────────────────────────────
[2026-04-11T09:00:00.000Z] [INFO ] POLL @ 2026-04-11T09:00:00.000Z
[2026-04-11T09:00:00.000Z] [INFO ]   BTC: ⏳ 2026-04-11 (no new candle yet) | price: 72766.54
[2026-04-11T09:00:00.000Z] [INFO ]   (no new closed candles this poll — signals skipped)
```

## Configuration

```javascript
const CONFIG = {
  assets:          ['BTC', 'ETH'],
  trailPct:        0.15,      // 15% trailing stop
  reentryLookback: 10,         // 10 trading days for re-entry
  feePct:          0.15,        // 0.15% fee
  slippagePct:     0,          // 0% slippage
  pollIntervalMs:  60*60*1000, // 1 hour
  lookbackDays:    30,          // candles for daily aggregation
  initialCapital:  10000,      // EUR per asset
  apiRetries:      3,           // retry on API failure
  apiRetryDelayMs: 5000,       // delay between retries
};
```

## Deployment

### Option 1: PM2 (recommended for long-running)

```bash
npm install -g pm2
pm2 start ro15-live-validator.mjs --name ro15-live -- --live
pm2 save
pm2 logs ro15-live
```

### Option 2: Systemd service

```ini
# /etc/systemd/system/ro15-live.service
[Unit]
Description=RO15 Live Shadow Validator
After=network.target

[Service]
Type=simple
User=node
WorkingDirectory=/home/node/.openclaw/workspace/crypto-live-validator
ExecStart=/usr/bin/node ro15-live-validator.mjs --live
Restart=always
RestartSec=60

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable ro15-live
sudo systemctl start ro15-live
journalctl -u ro15-live -f
```

### Option 3: Cron (one-shot hourly)

```cron
# /etc/cron.d/ro15-validator
0 * * * * node /home/node/.openclaw/workspace/crypto-live-validator/ro15-live-validator.mjs --once >> /home/node/.openclaw/workspace/crypto-live-validator/logs/cron.log 2>&1
```

## Validation Period

Minimum **2–4 weeks in shadow mode** before considering paper orders.

During this period:
- Monitor realized PnL vs expected range
- Verify no phantom signals (check against Binance charts)
- Track how often the 15% trailing stop is hit vs research expectations
- Validate 10d high re-entry behavior

## Research Context

- Validated in `crypto-backtester` (625+ parameter combinations, 18 walk-forward windows)
- RO15 Sharpe 0.96 (best among RO10/15/20/30 variants)
- 81.8% win rate on out-of-sample windows
- Best risk-adjusted strategy: Sharpe 0.97, MaxDD ~23%
- Outperforms B&H in bear/range markets; tied in strong bull runs

See: `crypto-backtester/results/FINAL-REPORT-2026-04-11.md`
