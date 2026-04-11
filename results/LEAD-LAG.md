# BTC Lead-Lag Analysis (15m candles)

**Data:** ~100 days, 2025-12-28T16:30:00.000Z to 2026-04-11T20:15:00.000Z
**Common candles:** 10000

## Event Study: BTC >+1% or <-1% moves

| Alt | Horizon | nUp | avgAltUp% | sameDir% | nDown | avgAltDown% | oppDir% | corr |
|-----|---------|-----|-----------|----------|-------|------------|---------|------|
| ETH | 15m | 51 | -0.032 | 0.0% | 57 | +0.022 | 0.0% | 0.9118 |
| ETH | 30m | 51 | +0.180 | 56.9% | 57 | -0.037 | 50.9% | 0.9328 |
| ETH | 1h | 51 | -0.169 | 0.0% | 57 | +0.119 | 0.0% | 0.9076 |
| ETH | 2h | 51 | +0.013 | 56.9% | 57 | +0.113 | 0.0% | 0.8945 |
| BNB | 15m | 51 | -0.058 | 0.0% | 57 | +0.033 | 0.0% | 0.8887 |
| BNB | 30m | 51 | +0.102 | 52.9% | 57 | -0.058 | 52.6% | 0.9126 |
| BNB | 1h | 51 | -0.150 | 0.0% | 57 | +0.102 | 0.0% | 0.9162 |
| BNB | 2h | 51 | +0.006 | 56.9% | 57 | +0.042 | 0.0% | 0.8881 |
| SOL | 15m | 51 | -0.083 | 0.0% | 57 | +0.012 | 0.0% | 0.8290 |
| SOL | 30m | 51 | +0.164 | 54.9% | 57 | -0.149 | 50.9% | 0.9449 |
| SOL | 1h | 51 | -0.265 | 0.0% | 57 | +0.148 | 0.0% | 0.9451 |
| SOL | 2h | 51 | -0.028 | 0.0% | 57 | +0.042 | 0.0% | 0.8915 |

## Cross-Correlation (BTC vs ALT returns)

Positive lag = BTC leads ALT. Peak at lag > 0 would suggest BTC leads.

## Key Findings

**ETH at 1h horizon:** BTC +1% -> ALT avg -0.169% (same: 0.0%), BTC -1% -> ALT avg +0.119% (opp: 0.0%), corr=0.9076
**BNB at 1h horizon:** BTC +1% -> ALT avg -0.150% (same: 0.0%), BTC -1% -> ALT avg +0.102% (opp: 0.0%), corr=0.9162
**SOL at 1h horizon:** BTC +1% -> ALT avg -0.265% (same: 0.0%), BTC -1% -> ALT avg +0.148% (opp: 0.0%), corr=0.9451

## Interpretation

What would "BTC leads alts" look like?
- After BTC +1%: alts also positive (same direction, >-0.3% avg)
- After BTC -1%: alts also negative (same direction, <-0.3% avg)
- Cross-correlation peaks at positive lag

What would "NO lead-lag" look like?
- Correlation near zero at all lags
- BTC events produce inconsistent/no ALT response
