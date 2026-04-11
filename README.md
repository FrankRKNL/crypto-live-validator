# RO15 Live Shadow Validator

Production-ready live shadow-mode validation of the RO15 (RiskOverlay-15%) trailing stop strategy.

**Mode: SHADOW ONLY** — no real orders, no exchange execution. Only signals, state, and logging.

## Strategy Specification

Based on validated research from `crypto-backtester` (2026-04-11):

| Parameter | Value |
|-----------|-------|
| Start | Always IN position (buy at market) |
| Exit | Price < peak × (1 − 0.15) = peak × 0.85 |
| Re-entry | Price > 10-trading-day high (after exit) |
| Fee | 0.15% per trade |
| Slippage | 0% |
| Signal basis | Daily candle closes ONLY |

**Critical:** Signals are evaluated **only at daily candle closes** — no intraday pseudo-signals, even when polling hourly.

## Quick Start

```bash
# One-shot daily check (for cron)
npm run once

# Continuous live polling
npm start
```

Or directly:

```bash
node ro15-live-validator.mjs --live   # live polling
node ro15-live-validator.mjs           # one-shot
node ro15-live-validator.mjs --help    # help
```

## Project Structure

```
crypto-live-validator/
  ro15-live-validator.mjs     # Main validator engine
  package.json
  README.md
  logs/
    state.json                 # Global state (restart reference)
    validator-YYYY-MM-DD.log   # Daily console log
    assets/
      BTC-state.json           # BTC persistent trading state
      ETH-state.json           # ETH persistent trading state
    daily/
      YYYY-MM-DD.json          # Daily equity snapshots
    alerts/
      BTC-alerts.log           # BTC entry/exit alerts
      ETH-alerts.log           # ETH entry/exit alerts
```

## Configuration

Edit the `CONFIG` object in `ro15-live-validator.mjs`:

```javascript
const CONFIG = {
  assets: ['BTC', 'ETH'],           // Assets to track
  trailPct: 0.15,                   // 15% trailing stop
  reentryLookback: 10,              // 10 trading days
  feePct: 0.15,                     // 0.15% fee (research spec)
  slippagePct: 0,                   // 0% slippage (research spec)
  pollIntervalMs: 60*60*1000,       // 1 hour between polls
  initialCapital: 10000,            // EUR paper money per asset
  lookbackDays: 30,                 // Daily candles for 10d high calc
};
```

## Monitoring Output

Each poll prints a monitoring table:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  RO15 SHADOW MONITOR                                            │
├──────────┬────────┬──────────┬──────────┬───────────┬────────────────┤
│ ASSET    │ POS    │ PEAK     │ TRAIL    │ EQUITY    │ LAST EVENT    │
├──────────┼────────┼──────────┼──────────┼───────────┼────────────────┤
│ BTC      │ LONG   │ 72716.64 │ 61809.14 │  10450.32 €│ HOLD          │
│          │   unrealized: +4.50% | realized: +0.00% | trades: 3       │
│ ETH      │ FLAT   │     —    │      —   │  11230.18 €│ EXIT          │
│          │   realized: +12.30% | trades: 5 | 10d high: 2245.00      │
└──────────┴────────┴──────────┴──────────┴───────────┴────────────────┘
  TOTAL PORTFOLIO: 21680.50 € | started: 2026-04-11
```

**Field definitions:**

| Field | Description |
|-------|-------------|
| POS | Current position: LONG or FLAT |
| PEAK | Highest price since entry |
| TRAIL | Exit trigger level (peak × 0.85) |
| EQUITY | Current paper equity in EUR |
| unrealized | Open PnL % (only when LONG) |
| realized | Closed-trade PnL % |
| trades | Total completed trades |
| 10d high | Price level for re-entry (only when FLAT) |

## State Recovery

The system is **restart-safe**:

1. On startup, `loadState()` reads `logs/state.json`
2. Each asset's state is loaded from `logs/assets/{ASSET}-state.json`
3. Fresh market data is fetched and compared against saved state
4. Signals are re-evaluated from the last saved daily candle

**What is persisted per asset:**
- `inPosition`, `entryPrice`, `peakPrice`
- `realizedPnL`, `cumFees`, `trades`
- `tenDayHigh`, `tenDayPrices[]` (rolling 10d window)
- `daysSinceExit`

**Cold start:** If no saved state exists, all available historical candles are processed and entry is forced at the most recent daily close.

## Validation Period

Minimum **2–4 weeks in shadow mode** before considering paper orders.

During this period:
- Monitor realized PnL vs expected range
- Verify no phantom signals (confirm against Binance charts)
- Track how often the 15% stop is hit vs research expectations
- Validate 10d high re-entry behavior

## Log Files

| File | Purpose |
|------|---------|
| `logs/validator-YYYY-MM-DD.log` | All console output |
| `logs/assets/{ASSET}-state.json` | Full trading state per asset |
| `logs/daily/YYYY-MM-DD.json` | Daily equity snapshot |
| `logs/alerts/{ASSET}-alerts.log` | Entry/exit events only |

## Deployment Options

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
0 * * * * node /home/node/.openclaw/workspace/crypto-live-validator/ro15-live-validator.mjs >> /home/node/.openclaw/workspace/crypto-live-validator/logs/cron.log 2>&1
```

## Alert Examples

```
[2026-04-11T08:00:00.000Z] [ALERT] BTC: 🟢 BUY — re-entry (>10d high 72962.70) | PnL: +0.00% | Total: +0.00%
[2026-04-12T08:00:00.000Z] [ALERT] BTC: 🔴 SELL — trailing stop (peak 75623.91, trail 64280.32) | PnL: -8.50% | Total: -8.50%
```

## Research Context

- Validated in `crypto-backtester` (625+ parameter combinations, 18 walk-forward windows)
- RO15 Sharpe 0.96 (best among RO10/15/20/30 variants)
- 81.8% win rate on OOS windows
- Outperforms B&H in bear/range markets; tied in strong bull runs
- Risk: 15% max drawdown (vs 73% for B&H in sample)

See: `crypto-backtester/results/FINAL-REPORT-2026-04-11.md`
