# RO15 Live Validation Protocol
**Version:** 1.0 | **Started:** 2026-04-11 | **Duration:** 2–4 weeks
**Strategy:** RO15 (15% trailing stop, 10-day high re-entry, shadow mode)
**Assets:** BTC, ETH | **Mode:** Paper trading (no real money)

---

## 1. Daily Monitoring (Automatic)

### Snapshot Schedule
- **Interval:** Every 60 minutes (live polling)
- **Signals:** Only evaluated at daily candle closes (~01:00 UTC)
- **Logging:** Every poll to `logs/validator-YYYY-MM-DD.log`

### Snapshot Format (per asset)
```
ASSET: [BTC|ETH]
  POSITION:    LONG / OUT
  ENTRY PRICE: €XXXXX.XX
  CURRENT:     €XXXXX.XX
  PEAK:        €XXXXX.XX
  TRAIL STOP:  €XXXXX.XX
  DISTANCE:    XX.X% (distance to stop)
  UNREALIZED:  +X.XX% (+€XX.XX)
  REALIZED:    +X.XX% (+€XX.XX)
  TRADES:      X
  LAST EVENT:  [ENTRY|EXIT|TRAIL_HIT|REENTRY]
  TIMESTAMP:   YYYY-MM-DDTHH:MM:SSZ
```

### Equity Snapshot
```
TOTAL PORTFOLIO: €XXXXX.XX
DAILY CHANGE:    +€XX.XX (+X.XX%)
DRAWDOWN:        XX.X% from ATH
VALIDATION DAY:  X/14
```

---

## 2. Event Logging (Critical)

Every entry/exit MUST log:
- **Reason:** TRAIL_HIT / 10D_HIGH_REENTRY / MANUAL
- **Peak at exit:** Price when exit triggered
- **Exact drawdown:** (peak - exit price) / peak * 100
- **PnL per trade:** €XX.XX (%)

### Trade Log Format
```csv
timestamp,asset,event,entry_price,exit_price,peak,drawdown,pnl_pct,pnl_eur,reason
2026-04-11T08:18:00Z,BTC,ENTRY,72770.73,–,72962.70,–,–,–,Initial entry
```

---

## 3. State Integrity Tests (2x manual)

### Test Procedure
1. Restart validator: `kill <PID> && node ro15-live-validator.mjs --live`
2. Compare state before/after restart:
   - Position unchanged ✓/✗
   - Peak unchanged ✓/✗
   - Trailing stop level unchanged ✓/✗
   - Equity within ±€1 ✓/✗

### State Files
- `logs/state.json` — global state (assets, trailPct, startedAt)
- `logs/assets/BTC-state.json` — BTC-specific state
- `logs/assets/ETH-state.json` — ETH-specific state

---

## 4. Exit Validation (Most Important)

First real exit triggers full audit:
- [ ] Exit within ±1% of 15% drawdown from peak
- [ ] No duplicate exit events
- [ ] No state glitch (position incorrectly set to OUT)
- [ ] Trail level correctly calculated
- [ ] Realized PnL correctly logged

### Exit Audit Report Template
```
=== EXIT AUDIT ===
Asset:      BTC
Date:       2026-04-XX
Peak:       €XXXXX
Exit Price: €XXXXX
Drawdown:   XX.X%
Expected:   15.0%
Deviation:  ±X.X%  [PASS/FAIL]
Position:   OUT   [CORRECT/INCORRECT]
Trail:      €XXXXX [CLEARED/CORRUPT]
Events:     [single/duplicate]
Status:     [VALID/INVALID]
```

---

## 5. Re-Entry Validation

After first exit, monitor for re-entry:
- [ ] Re-entry only triggers at true 10-day high
- [ ] No premature entries
- [ ] Re-entry price > previous exit price
- [ ] 10-day high calculation verified against Binance data

### Re-Entry Criteria
```
HIGH_10D > previous_peak AND
HIGH_10D > entry_price * 1.02 (minimum 2% above entry for re-entry)
```

---

## 6. Weekly Review (after 7 days)

### Report Template
```
=== WEEKLY REVIEW #X ===
Period: YYYY-MM-DD → YYYY-MM-DD
Duration: X days

TRADES:
  BTC: X entries, X exits
  ETH: X entries, X exits
  Total: X trades

EQUITY:
  Start: €XXXXX
  Current: €XXXXX
  Change: +€XXX (+X.X%)
  vs B&H: +X.XXpp / -X.XXpp

PERFORMANCE:
  Win rate: XX%
  Avg trade: +X.XX%
  Best trade: +X.XX%
  Worst trade: -X.XX%

DEVIATIONS:
  - [list any unexpected behaviors]
  - [list any bugs/edge cases]

STATUS: [GREEN/YELLOW/RED]
```

---

## 7. Hard Rules

- **NO optimizing** — strategy params are locked
- **NO strategy changes** — RO15 spec is fixed
- **NO new indicators** — validation, not R&D
- **Shadow mode only** — no real orders
- **14-day minimum** — don't draw early conclusions

---

## Status History

| Date       | Day | BTC Pos  | ETH Pos  | Equity   | Status | Notes |
|------------|-----|----------|----------|----------|--------|-------|
| 2026-04-11 | 1   | LONG     | LONG     | €20,034  | 🟢 GREEN | Initial state |