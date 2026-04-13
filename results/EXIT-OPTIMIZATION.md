# Exit Optimization Research
**Date:** 2026-04-12
**Entry:** Fast move >= 1.5%, follow-through confirmed
**Goal:** Compress 24h payoff to <8h via better exits

## Three Exit Strategies Tested

### TEST 1: Dynamic Exit
- Exit on: 2 bearish candles OR price < SMA8
- Max hold: 8h

### TEST 2: Partial Take Profit
- 50% closes at +0.5%
- Remaining 50%: 24h max OR stop loss (-1% within 2h)

### TEST 3: Volatility Exit
- Exit when: ATR < 50% of entry ATR OR range < 50% of entry range
- Max hold: 24h

## Results

| Asset | Baseline(24h) | DynExit | PartTP | VolExit |
|-------|--------------|---------|--------|---------|
| BTC | +4.7% | -29.7% | +17.6% | +11.5% |
| ETH | +4.9% | -42.1% | +24.3% | +2.0% |
| BNB | -6.9% | -32.9% | -1.1% | -9.2% |
| SOL | +0.5% | -38.6% | -10.0% | -2.0% |
| XRP | -0.0% | -40.8% | +10.3% | -0.7% |

**Averages:** Baseline=+0.6% | DynExit=-36.8% | PartTP=+8.2% | VolExit=+0.3%

## Verdict
**Best exit:** PartTP (avg return +8.19% +7.6pp vs baseline)

Data: ~41 days of 1h candles per asset. Short window — validate on longer dataset.
