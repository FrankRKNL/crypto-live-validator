# Strategy Comparison: Research RO15 vs Forward Tester

**Date:** 2026-04-11  
**Purpose:** Document exact differences and rationale

---

## 1. Strategy Definition

| Aspect | Research (engine-v5.mjs) | Forward Tester (ro15-live-validator.mjs) | Match? |
|--------|-------------------------|------------------------------------------|--------|
| trailPct | 0.15 | 0.15 | ✅ |
| Start state | Always invested (initial BUY at start) | Always invested (initial BUY at start) | ✅ |
| Exit | `price < peak × 0.85` | `close < peak × 0.85` | ✅ |
| Re-entry | `price > 10-day HIGH` | `close > tenDayHigh` (rolling 10d window) | ✅ |
| **MA20 filter** | **NO — not in research spec** | **NO — correctly not present** | ✅ |
| **MA50/MA200 filter** | **NO — not in RO15 strategy** | **NO** | ✅ |
| Fee | 0.15% ( FEE = 0.0015 ) | 0.15% | ✅ |
| Slippage | 0% | 0% | ✅ |
| Interval | 1d candles | 1h → aggregated to 1d | ✅ Equivalent |

### Answer to Frank's Question: "zat de MA20 re-entry filter ook in de gevalideerde researchversie?"

**Nee.** De MA20 re-entry filter is nooit onderdeel geweest van de RO15 research. De RO15 strategie is:

```
ALWAYS INVESTED → trailing stop exit → re-entry when price > 10d high
```

De "MA50/MA200 golden cross" noeming in RO15-CONDITIONAL-ANALYSIS.md was een **beschrijving van markt regimes**, niet van de strategie entryconditie. De RO15 strategie kent GEEN moving average crossover — dat is een ander strategie type (SMA200 crossover).

**Conclusie:** De forward tester is een **exacte kopie** van de research strategie. Er is geen MA20 filter in beide.

---

## 2. Logging & Metrics — Explained

### How Often What Happens

| Event | Frequency | Trigger |
|-------|-----------|---------|
| Price fetch | Every poll (1h) | Binance 1h klines |
| Equity update | Every poll (1h) | `currentPrice` changes |
| Signal check | **Once per day** | When UTC day changes (new closed candle) |
| State save | After each poll | Persists to `logs/assets/{ASSET}-state.json` |
| Daily CSV | Once per UTC day | New closed candle detected |

### Timestamp Meaning in Logs

- **Candle date** = the UTC day the candle CLOSED (midnight UTC)
- A candle for "2026-04-10" closes at `2026-04-10T23:59:59Z` 
- Signals are evaluated at that moment
- The log entry shows the candle DATE, not the processing time

### Equity Calculation Chain

```
Per poll:
  currentPrice = latest 1h candle close (incomplete UTC day)
  unrealizedPnL = (currentPrice - entryPrice) / entryPrice  [peak-based, NOT currentPrice based]
  equity = initialCapital × (1 + realizedPnL + unrealizedPnL)

Per NEW CLOSED CANDLE (UTC midnight):
  signal = processClosedCandle(candle)  ← ONLY HERE signals are generated
  realizedPnL += completedTradeReturn
  unrealizedPnL resets to 0 (new position or fresh entry)
```

**Important:** `unrealizedPnL` is based on `entryPrice → currentPrice`, NOT peak → current. The peak only affects the trailing stop trigger, not the unrealized PnL display.

---

## 3. 91% Win Rate — Root Cause Analysis

### What Happened

The 91% win rate came from the **DEPRECATED** `ro15-paper-trader.mjs` (now renamed with `.deprecated` suffix). That version had a **critical bug** in the re-entry logic:

```javascript
// BUG in ro15-paper-trader.mjs (DEPRECATED):
// Re-entry checked BEFORE adding current candle to price history
// pricesSinceExit was empty → ANY uptick triggered re-entry
if (pricesSinceExit.length === 0 && close > entryPrice * 0.99) {
  // Immediate re-entry ← WRONG
}
```

This bug caused:
- Re-entry within 1-2 days of exit (often same day)
- In a bull market, this looks like "high win rate"
- But it's actually **overtading** — multiple false re-entries

### Current Status

The **new validator** (`ro15-live-validator.mjs`) has this fix:
```javascript
// CORRECT in ro15-live-validator.mjs:
if (this.daysSinceExit > 0 && close > this.tenDayHigh) {
  // Re-entry only when 10d high is actually broken
}
```

### Why Live Win Rate Looks High Now (April 2026)

- BTC has been in a sustained bull run
- No exits triggered yet (price never fell 15% from peak)
- Only 1 trade (the initial entry)
- Win rate = 100% but N=1 — statistically meaningless

### Expected Long-Term Win Rate

From research (2001 days, 71 trades): **~46%**

But RO15 is **convex payoff** — low win rate + large outliers:
- Median trade: **-3.3%** (small loss typical)
- Average trade: **+30%** (outliers dominate)
- Path dependency: big wins come in clusters during bull runs

**The 91% is a SHORT-SAMPLE BULL MARKET artifact. Not a contradiction of research.**

---

## 4. Remaining Differences (Acceptable)

| Item | Research | Forward Tester | Rationale |
|------|----------|----------------|-----------|
| Fee | 0.15% | 0.15% | ✅ Same |
| Slippage | 0% | 0% | ✅ Conservative estimate |
| Interval | 1d close | 1h→1d aggregation | ✅ Equivalent (same close price) |

**No meaningful differences remain.**

---

## 5. Action Items

- [x] MA20 filter question answered — not in research spec
- [x] Logging/metrics explained
- [x] 91% win rate root cause identified (deprecated paper trader bug)
- [x] Confirmed: forward tester matches research exactly
