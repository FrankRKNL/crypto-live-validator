# RO15 Live Shadow Validator — Deployment Runbook

**Status:** RUNNING (PID 2566) | **Mode:** SHADOW ONLY | **Started:** 2026-04-11  
**Validation period:** 2–4 weeks minimum before paper trading

---

## 1. Quick Start

```bash
# Live mode (continuous hourly polling)
node ro15-live-validator.mjs --live

# One-shot (for cron)
node ro15-live-validator.mjs --once

# PM2 setup
pm2 start ro15-live-validator.mjs --name ro15-live -- --live
pm2 save
pm2 logs ro15-live
```

---

## 2. Map Structure

```
crypto-live-validator/
├── ro15-live-validator.mjs          # Main validator (ESM, pure Node.js)
├── package.json
├── README.md
├── SPEC.md                          # Strategy specification (source of truth)
├── STRATEGY-COMPARISON.md
├── CONSISTENCY-REPORT.md
├── RUN.md                           # This file
└── logs/
    ├── state.json                   # Global state (restart anchor)
    ├── validator-YYYY-MM-DD.log     # Per-day console log
    ├── VALIDATION-TRACKER.md        # Trade log + monitoring
    ├── live-polling.log
    ├── daily/
    │   └── summary-YYYY-MM-DD.csv   # Daily equity snapshots
    ├── assets/
    │   ├── BTC-state.json           # BTC full trading state
    │   └── ETH-state.json           # ETH full trading state
    └── alerts/
        ├── BTC-alerts.log            # BTC entry/exit events
        └── ETH-alerts.log            # ETH entry/exit events
```

---

## 3. RO15 Strategy — Exact Research Spec

| Aspect | Value |
|--------|-------|
| Start state | Always IN position |
| Exit | `close < peak × 0.85` (15% trailing stop) |
| Re-entry | `daysSinceExit > 0 AND close > 10d rolling high` |
| Fee | 0.15% per trade |
| Slippage | 0% |
| Data | 1h candles → aggregated to daily |
| Signal timing | **ONLY at daily candle close (UTC midnight)** |

---

## 4. State Recovery (Restart-Safe)

State is persisted after every poll to `logs/assets/{ASSET}-state.json`.

**On restart:**
1. `loadAssetState()` reads `{ASSET}-state.json`
2. All fields restored: `inPosition`, `entryPrice`, `peakPrice`, `tenDayHigh`, `tenDayPrices[]`, `daysSinceExit`, `trades`, `realizedPnL`, `cumFees`
3. `hydrate()` repopulates the RO15Strategy object
4. Polling resumes from exact last state

**No state file:** Cold start — processes 30 days historical candles, forces entry if left flat.

**State fields:**
```json
{
  "inPosition": true,
  "entryPrice": 72770.73,
  "peakPrice": 72962.70,
  "trailLevel": 62018.29,
  "trades": 1,
  "realizedPnL": 0,
  "cumFees": 0,
  "lastEvent": "ENTRY",
  "tenDayHigh": 72962.70,
  "tenDayPrices": [66901.99, 66964.3, ...],
  "daysSinceExit": 22,
  "currentPrice": 72750.06
}
```

---

## 5. Daily Monitoring Output

Every poll prints:

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  RO15 SHADOW MONITOR  |  2026-04-11  |  SHADOW MODE                                           │
├──────────┬────────┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────────────────┤
│ ASSET    │ POS    │ PRICE    │ PEAK     │ TRAIL    │ DIST     │ EQUITY   │ LAST EVENT          │
├──────────┼────────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────────────────┤
│ BTC      │ LONG │ 72750.06 │ 72962.70 │ 62018.29 │ 14.8%    │  9997.16 € │ ENTRY               │
│          │ unrealized: -0.03% (-2.84 €) | realized: +0.00% | trades: 1                     │
│ ETH      │ LONG │ 2234.75  │ 2245.05  │ 1908.29  │ 14.6%    │ 10002.33 € │ ENTRY               │
│          │ unrealized: +0.02% (+2.33 €) | realized: +0.00% | trades: 1                     │
├──────────┴────────┴──────────┴──────────┴──────────┴──────────┴──────────┴─────────────────────┤
│  TOTAL PORTFOLIO: 19999.49 €  |  started: 2026-04-11  |  validation period: 2–4 weeks  │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Monitored per day per asset:**
- `POS` — current position (LONG / FLAT)
- `PRICE` — latest price
- `PEAK` — highest price since entry
- `TRAIL` — trailing stop level (peak × 0.85)
- `DIST` — distance to stop (% from current price to trail level)
- `EQUITY` — total EUR value
- `unrealized` — open PnL in % and EUR
- `realized` — closed trade PnL
- `LAST EVENT` — ENTRY / EXIT / HOLD / FLAT
- `trades` — number of completed round-trip trades

---

## 6. Alert Format

Written to `logs/alerts/{ASSET}-alerts.log` on entry/exit only (no spam):

```
[2026-04-11T08:14:09.747Z] [ALERT] BTC: 🟢 BUY — 72770.7300 | re-entry (>10d high 72962.70) | PnL: +0.00% | Total: +0.00%
[2026-04-15T23:59:59.000Z] [ALERT] BTC: 🔴 SELL — 71000.0000 | trailing stop (peak 72962.70, trail 62018.30) | PnL: -2.42% | Total: -2.42%
```

---

## 7. Daily CSV Format

`logs/daily/summary-YYYY-MM-DD.csv`:

```
timestamp,asset,position,currentPrice,peakPrice,trailLevel,distToStopPct,equityEUR,unrealizedPct,unrealizedEUR,realizedPct,realizedEUR,lastEvent,trades,cumFees
2026-04-11T08:34:24.481Z,BTC,LONG,72750.0600,72962.7000,62018.2950,14.7516,9997.16,-0.0284,-2.84,0.0000,0.00,ENTRY,1,0.0000
2026-04-11T08:34:24.481Z,ETH,LONG,2234.7500,2245.0500,1908.2925,14.6082,10002.33,0.0233,2.33,0.0000,0.00,ENTRY,1,0.0000
```

---

## 8. Error Handling

| Failure | Response |
|---------|----------|
| HTTP 429 (rate limit) | Retry after 5s, up to 3 attempts |
| Network error | Retry after 5s, up to 3 attempts |
| API timeout (15s) | Retry after 5s, up to 3 attempts |
| All retries exhausted | Log ERROR, skip asset, continue with others |
| JSON parse error | Log ERROR, skip asset |
| State file write error | Log ERROR, continue (state may be stale) |

---

## 9. Current Status

```
Process:  PID 2566, running since 2026-04-11 08:34
Mode:     --live (hourly polling)
Assets:   BTC + ETH (10,000 EUR each)
Started equity: BTC 10,000 € + ETH 10,000 € = 20,000 €
BTC:      Entry $72,770.73 | Peak $72,962.70 | Trail $62,018.29 | 14.8% to stop
ETH:      Entry $2,234.23  | Peak $2,245.05  | Trail $1,908.29  | 14.6% to stop
Signals:  Evaluated ONLY at UTC daily candle closes
Alerts:   Entry/exit only (silent between)
```

---

## 10. PM2 Commands

```bash
pm2 start ro15-live-validator.mjs --name ro15-live -- --live
pm2 save
pm2 logs ro15-live --lines 50
pm2 restart ro15-live
pm2 stop ro15-live
pm2 delete ro15-live
```

Or for cron one-shot mode:
```bash
0 * * * * cd /home/node/.openclaw/workspace/crypto-live-validator && node ro15-live-validator.mjs --once >> logs/cron.log 2>&1
```
