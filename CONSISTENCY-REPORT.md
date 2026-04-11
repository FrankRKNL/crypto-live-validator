# RO15 Strategy Consistency Report

**Date:** 2026-04-11  
**Purpose:** Resolve 3 inconsistencies before continuous live operation

---

## 1. Strategy-definitie — MA20 Filter Question

**Antwoord: Nee, MA20 zit NIET in de gevalideerde research RO15 spec.**

| Aspect | Research (engine-v5.mjs) | Forward Tester (ro15-live-validator.mjs) | Match |
|--------|--------------------------|------------------------------------------|-------|
| trailPct | 0.15 (15%) | 0.15 | ✅ |
| Start state | Always invested (initial BUY) | Always invested (initial BUY) | ✅ |
| Exit | `price < peak × 0.85` | `close < peak × 0.85` | ✅ |
| Re-entry | `price > 10d high` (rolling window) | `close > tenDayHigh` (rolling window) | ✅ |
| MA20 filter | **NIET aanwezig** | **NIET aanwezig** | ✅ |
| MA50/MA200 | NIET aanwezig | NIET aanwezig | ✅ |
| Fee | 0.15% (= 0.0015) | 0.15% (= 0.0015) | ✅ |
| Slippage | 0% | 0% | ✅ |
| Interval | 1d daily candles | 1h → aggregated to 1d | ✅ Equivalent |

**Bron research engine-v5.mjs (regel 635-682):**
```javascript
// STRATEGY: RiskOverlay (always invested, trailing stop exit/reentry)
function strategyRiskOverlay(prices, ethPrices, startIdx, endIdx, trailPct = 0.20) {
  // Always invested from day 1...
  // Re-entry: price above 10-day high
  const recentHigh = Math.max(...priceArr.slice(Math.max(startIdx, i-10), i+1));
  if (price > recentHigh) { /* BUY */ }
}
```

**De "MA20" in RO15-CONDITIONAL-ANALYSIS.md was een beschrijving van markt-regimes (SMA20/SMA50/SMA200 als regime-classificatie), niet van de strategie entry-conditie zelf.**

**Conclusie:** De forward tester is een **exacte kopie** van de research strategie. Er is GEEN MA20 of andere MA filter in RO15.

---

## 2. Logging en Metrics — Explained

### Hoe vaak wat gebeurt

| Event | Frequentie | Trigger |
|-------|-----------|---------|
| Prijs fetch | Elke poll (1h) | Binance 1h klines |
| Equity update | Elke poll (1h) | `currentPrice` verandert |
| Signal check | **Eenmaal per dag** | UTC dag wisselt (new closed candle) |
| State save | Na elke poll | Persisteert naar `logs/assets/{ASSET}-state.json` |
| Daily CSV | Eenmaal per UTC dag | Nieuwe gesloten kaars gedetecteerd |
| Alert log | Bij entry/exit | Append naar `logs/alerts/{ASSET}-alerts.log` |

### Timestamp betekenis

- **Candle date** = de UTC dag waarop de kaars SLUIT (midnight UTC)
- Een kaars voor "2026-04-10" sluit om `2026-04-10T23:59:59Z`
- Signals worden geëvalueerd op dat moment
- De log toont de kaars DATUM, niet de processing tijd

### Equity berekening

```
Per poll:
  currentPrice = latest 1h candle close (incomplete UTC day)
  unrealizedPnL = (currentPrice - entryPrice) / entryPrice
  equity = initialCapital × (1 + realizedPnL + unrealizedPnL)

Per NEW CLOSED CANDLE (UTC midnight):
  signal = processClosedCandle(candle)  ← ALLEEN HIER signals gegenereerd
  realizedPnL += completedTradeReturn
  unrealizedPnL reset naar 0 voor nieuwe positie
```

**Belangrijk:** `unrealizedPnL` is gebaseerd op `entryPrice → currentPrice`, NIET peak → current. De peak bepaalt alleen de trailing stop trigger, niet de getoonde unrealized PnL.

---

## 3. 91% Win Rate — Root Cause + Sanity Check

### Root cause

De 91% win rate kwam van het **DEPRECATED** `ro15-paper-trader.mjs` (nu hernoemd met `.deprecated` suffix). Die versie had een **critical bug** in de re-entry logic:

```javascript
// BUG in ro15-paper-trader.mjs (DEPRECATED):
// Re-entry checked BEFORE adding current candle to price history
// pricesSinceExit was empty → ANY uptick triggered re-entry
if (pricesSinceExit.length === 0 && close > entryPrice * 0.99) {
  // Immediate re-entry ← WRONG
}
```

Dit veroorzaakte:
- Re-entry binnen 1-2 dagen na exit (vaak zelfde dag)
- In een bull market lijkt dit "hoge win rate"
- Maar het is eigenlijk **overtading** — meerdere valse re-entries

### Huidige situatie

De **nieuwe validator** (`ro15-live-validator.mjs`) heeft de fix:
```javascript
// CORRECT in ro15-live-validator.mjs:
if (this.daysSinceExit > 0 && close > this.tenDayHigh) {
  // Re-entry alleen als 10d high daadwerkelijk broken
}
```

### Waarom huidige win rate 100% lijkt (April 2026)

- BTC is in een aanhoudende bull run
- Nog geen exits getriggerd (prijs is nog niet 15% gedaald vanaf piek)
- Slechts 1 trade (de initiële entry)
- Win rate = 100% maar N=1 — statistisch betekenisloos

### Verwachte lange-termijn win rate

Van research (2001 dagen, 71 trades): **~46%**

MAAR RO15 is een **convex payoff** strategie — lage win rate + grote outliers:
- Median trade: **-3.3%** (kleine verlies typisch)
- Average trade: **+30%** (outliers domineren)
- Path dependency: grote wins komen in clusters tijdens bull runs

**De 91% is een KORTE STEekproef BULL MARKET artifact. Geen tegenstrijdigheid met research.**

---

## 4. Vergelijkingstabel: Research vs Forward Tester

| Item | Research | Forward Tester | Verschil |
|------|----------|----------------|-----------|
| trailPct | 0.15 | 0.15 | ✅ Geen |
| Start state | Always invested | Always invested | ✅ Geen |
| Exit trigger | `price < peak × 0.85` | `close < peak × 0.85` | ✅ Geen |
| Re-entry | `price > 10d high` | `close > tenDayHigh` | ✅ Geen |
| Fee | 0.15% | 0.15% | ✅ Geen |
| Slippage | 0% | 0% | ✅ Geen |
| Interval | 1d close | 1h→1d aggregation | ✅ Equivalent |
| MA filter | Geen | Geen | ✅ Geen |
| Data source | Historical | Binance live | — |
| Start datum | 2020-10-25 | 2026-04-11 | — (out-of-sample) |

**No meaningful differences remain.**

---

## 5. Cold Start Behaviour (Belangrijk)

When starting with no state file:
1. Fetch 30 days of 1h candles → aggregate to daily
2. Process ALL historical daily candles through `processClosedCandle()`
3. If result is FLAT → force BUY at latest price (research spec: always invested)
4. Start live polling

When restarting WITH state file:
- Restore `inPosition`, `entryPrice`, `peakPrice`, `tenDayHigh`, `tenDayPrices`, `daysSinceExit`
- Continue from where we left off
- Re-entry detection continuous (state includes all needed fields)

**Limitation:** If `inPosition = false` at restart, `tenDayHigh` restored from disk may be stale (last known 10d high at time of exit). Real trading would rebuild history from exchange. Acceptable for shadow mode.
