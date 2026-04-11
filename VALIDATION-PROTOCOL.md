# RO15 Live Validation Protocol
**Start:** 2026-04-11
**Goal:** Confirm live implementation behaves exactly like research version
**Mode:** SHADOW ONLY — no real orders
**Validation Period:** 2–4 weeks minimum

---

## 1. Daily Monitoring (automatic)

Every 60 minutes (on daily candle closes only):

### Per Asset Snapshot:
| Field | BTC | ETH |
|-------|-----|-----|
| Position | LONG / OUT | LONG / OUT |
| Entry Price | € | € |
| Current Price | € | € |
| Peak Price | € | € |
| Trailing Stop Level | € | € |
| Distance to Stop | % | % |
| Unrealized PnL | € | € |
| Realized PnL | € | € |
| Last Event | ENTRY/EXIT/TRAIL HIT | ENTRY/EXIT/TRAIL HIT |
| Timestamp | ISO8601 | ISO8601 |

---

## 2. Event Logging (critical)

On every entry/exit, log explicitly:

```
{
  "event": "EXIT",
  "asset": "BTC",
  "reason": "TRAIL HIT" | "10D HIGH RE-ENTRY",
  "exitPrice": 62018.29,
  "peakAtExit": 72962.70,
  "drawdownPct": -15.0,
  "PnL": -180.52,
  "fee": 0.93,
  "netPnL": -181.45,
  "timestamp": "2026-04-11T12:00:00Z",
  "tradesTotal": 2,
  "positionAfter": "OUT"
}
```

---

## 3. State Integrity Tests (manual, 2x weekly)

**Test procedure:**
1. `kill [PID]` — hard stop
2. Wait 5 seconds
3. `node --live validator.mjs` — restart
4. Verify from logs/state.json:
   - Position unchanged
   - Peak unchanged
   - Trail level unchanged
   - Unrealized PnL consistent with prices

**Pass criteria:** All three values within ±0.1% of pre-restart values.

---

## 4. Exit Validation (most important)

At first real exit event:

| Check | Criteria | Status |
|-------|----------|--------|
| Exit price | Within ±1% of 15% drawdown from peak | PENDING |
| No duplicate exit events | Single EXIT logged | PENDING |
| No state glitch | Position=OUT, realizedPnL updated | PENDING |
| Trail level correct | Was peak × 0.85 | PENDING |

---

## 5. Re-entry Validation

After first exit:

| Check | Criteria | Status |
|-------|----------|--------|
| Re-entry trigger | Price > 10-day high only | PENDING |
| No premature entries | 10d high must be new high | PENDING |
| Days since exit tracked | Counter increments correctly | PENDING |

---

## 6. Weekly Review (every 7 days)

Report:
- Number of trades (entries + exits)
- Equity change vs start
- Realized vs unrealized PnL
- Deviations from expected behavior
- Bugs or edge cases observed

---

## 7. Hard Rules

- ❌ NOT optimize parameters
- ❌ NOT adjust strategy
- ❌ NOT build new features
- ✅ ONLY observe, log, validate

**Primary question:** Does realtime behavior match backtester engine?

---

## Validation Status

| Test | Status | Date |
|------|--------|------|
| System startup | ✅ PASS | 2026-04-11 |
| State restoration | ✅ PASS | 2026-04-11 |
| Price fetching (BTC+ETH) | ✅ PASS | 2026-04-11 |
| Trail level calculation | ✅ PASS | 2026-04-11 |
| First exit event | PENDING | — |
| First re-entry event | PENDING | — |
| State integrity restart #1 | PENDING | — |
| State integrity restart #2 | PENDING | — |
| Weekly review #1 | PENDING | 2026-04-18 |
| Weekly review #2 | PENDING | 2026-04-25 |
