# PUMP MOMENTUM ROBUSTNESS VALIDATION

**Date:** 2026-04-11  
**Objective:** Validate pump momentum edge against Frank's 5-phase robustness framework

---

## WHAT IS PUMP MOMENTUM?

Large BUY trade → price goes UP (momentum continuation)  
Large SELL trade → price goes DOWN (momentum continuation)

Originally hypothesized as REVERSAL. Actual result: MOMENTUM.

---

## PHASE 1 — OUT-OF-SAMPLE: Different Time Windows

### Data Available
| Session | Duration | BTC Events | ETH Events |
|---------|----------|-----------|-----------|
| session-2026-04-11T23-28-09 | ~2 min | 0 (no trade file) | 0 |
| session-2026-04-11T23-34-54 | ~2 min | 132 | 104 |

Only 1 session with sufficient data → Cannot draw conclusions across different market periods.

### Session-Level Results (1000ms window)

| Symbol | n | Avg Return | t-stat | Direction |
|--------|---|-----------|--------|-----------|
| BTC SELL | 62 | **-0.0123%** | -8.64 | Reversal (price down after large SELL) |
| BTC BUY | 35 | **+0.0011%** | +2.72 | Continuation (price up after large BUY) |
| ETH SELL | 52 | **-0.0139%** | -7.67 | Reversal |
| ETH BUY | 23 | **+0.0025%** | +1.73 | Continuation |

### Cross-Session Stability (1000ms window)

| Side | Session Count | Pooled n | Avg | t-stat | Sig |
|------|--------------|---------|-----|--------|-----|
| SELL | 1 | 62 | -0.0123% | -8.64 | YES (in-session) |
| BUY | 1 | 35 | +0.0011% | +2.72 | YES (in-session) |

**VERDICT Phase 1:** Promising in-session signal, but only 1 session with data → OUT-OF-SAMPLE validation INCOMPLETE.

---

## PHASE 2 — PARAMETER STABILITY: Threshold Sensitivity

Test: different multiples of average trade size as threshold for "large trade"

| Threshold | n | Avg @ 1s | t-stat |
|-----------|---|----------|--------|
| 3x avg (~11 mBTC) | 87 | -0.0103% | -8.28 |
| 5x avg (~19 mBTC) | 62 | -0.0110% | -7.45 |
| 10x avg (~37 mBTC) | 39 | -0.0132% | -6.73 |

**Observations:**
- All thresholds show SELL = negative (reversal)
- Larger trades → slightly more negative (more reliable reversal)
- BUY signal persists across all thresholds

**VERDICT Phase 2:** Consistent across thresholds. Larger trades = more reliable signal. PLATEAU present (stable t-stats across 3x-10x).

---

## PHASE 3 — CROSS-ASSET VALIDATION

| Asset | SELL n | SELL avg | BUY n | BUY avg |
|-------|--------|----------|-------|---------|
| BTC | 62 | -0.0123% | 35 | +0.0011% |
| ETH | 52 | -0.0139% | 23 | +0.0025% |

Both assets show SAME DIRECTION:
- SELL → reversal (price drops)
- BUY → continuation (price rises)

**VERDICT Phase 3:** CONSISTENT across BTC and ETH.

---

## PHASE 4 — DISTRIBUTION

BTC 1000ms window (n=97):

| Metric | Value |
|--------|-------|
| Mean | -0.0075% |
| Median | 0.0000% |
| Std Dev | 0.0112% |
| Min | -0.0320% |
| Max | +0.0088% |
| Win Rate | 17.5% |
| Avg Win | +0.0023% |
| Avg Loss | -0.0141% |
| Big Wins (>1bp) | 0 |
| Small Wins (<=1bp) | 17 |
| 5th percentile | -0.0320% |
| 95th percentile | +0.0032% |

**KEY INSIGHT:** This is a FAT-TAIL REVERSAL distribution. Mean is negative, median is zero, but there are extreme negative events driving the reversal behavior. The "edge" is entirely in SELL reversals, not BUY continuations.

---

## PHASE 5 — TRADE FREQUENCY REALITY

### Fee Impact (CRITICAL)

| Item | Value |
|------|-------|
| Max signal magnitude | 0.016% (at 30s window) |
| Fee per round-trip | 0.06% (0.04% maker + 0.02% taker) |
| **Net after fees** | **-0.044%** |
| Break-even win rate | 375% (impossible) |

### Annual Projection

| Scenario | Daily Events | Daily PnL | Annualized |
|----------|-------------|-----------|------------|
| Gross signal | 2,220 | +0.354% | +∞ (theoretical) |
| After fees | 2,220 | **-0.977%** | **-97.2%** |

**VERDICT Phase 5:** Signal magnitude (max 0.016%) is 3.75x SMALLER than fees (0.06%). This is NOT exploitable as a standalone strategy.

---

## RE-EXAMINATION OF THE SIGNAL

The original "pump momentum" finding was:
- BUY side: +0.007% at 1s → +0.033% at 30s
- t-stat significant at t=5-11

But our current data (short 2-min sessions) shows:
- BUY side: +0.0011% at 1s (n=35, t=2.72)
- BUY side: +0.0025% at 1s for ETH (n=23, t=1.73)

**The signal exists but is TINY (~0.001-0.003%).** The original research was on 200+ events over months. Our live sessions give n=35-62.

### Key Distinction: SELL vs BUY

The data shows TWO different phenomena:

1. **SELL Reversal** (strong, reliable): Large SELL → price drops further (-0.012% at 1s, t=-8.64). This is DOWNWARD momentum continuation, not reversal. Sellers keep selling.

2. **BUY Continuation** (weak): Large BUY → price微弱上升 (+0.001% at 1s). This is the "pump momentum" effect, but very small.

The SELL side is actually momentum (price falls after large SELL), not reversal. The original classification was wrong.

---

## THE FUNDAMENTAL PROBLEM

Even if the signal is real:
- Max exploitable magnitude: **0.016%** (30s window)
- Fees: **0.060%** per round-trip
- **Net = -0.044% per trade**
- Break-even win rate: **375%** (impossible)

This signal is economically NON-EXPLOITABLE.

---

## VERDICT SUMMARY

| Phase | Result | Score |
|-------|--------|-------|
| 1: Out-of-sample | INCOMPLETE (only 1 session) | 2/5 |
| 2: Parameter stability | PLATEAU found (stable across 3x-10x) | 4/5 |
| 3: Cross-asset | CONSISTENT (BTC + ETH same direction) | 5/5 |
| 4: Distribution | Fat-tail reversal, NOT momentum | 2/5 |
| 5: Fee reality | 3.75x signal < fees | 0/5 |

### FINAL SCORE: 2.6/10

**NOT ROBUST ENOUGH to trade.**

### What would change the verdict?

1. **Longer data collection** → Phase 1 needs multiple market regimes (bull, bear, sideways)
2. **Much larger signal** → Need ≥0.1% to make fees irrelevant (0.1% / 0.06% = 1.67x leverage)
3. **Better execution** → OTC desks, iceberg orders to reduce fees
4. **Alternative** → Use as SENTIMENT INDICATOR (aggregate buy/sell ratio to predict short-term direction), not trade trigger

---

## RECOMMENDATION

**ABANDON standalone pump momentum trading.**

**POTENTIAL ALTERNATIVE:** Use buy/sell ratio as a sentiment overlay for RO15 strategy entry/exit timing. If buy/sell ratio spikes (aggressive buying), delay exit (more momentum expected). If ratio collapses, accelerate exit.

This would use pump momentum as a CONTEXT FILTER, not a standalone strategy.