# Micro Edges: Time-of-Day + Lead-Lag (BTC 15m)

**Generated:** 2026-04-11
**Data:** ~100 days (2025-12-28 to 2026-04-11), BTC/ETH/BNB/SOL 15m candles

---

## HYPOTHESE 1: Time-of-Day Volatility

### Hourly Volatility Profile (BTC 15m, UTC)

| Hour (UTC) | AvgRange% | Bull% | Next1h% |
|---|---|---|---|
| 00:00 | 0.3700 | 48.80% | +0.062 |
| 01:00 | 0.3869 | 49.76% | -0.028 |
| 02:00 | 0.3279 | 48.08% | -0.020 |
| 03:00 | 0.2931 | 48.08% | +0.016 |
| 04:00 | 0.2787 | 45.91% | -0.034 |
| 05:00 | 0.2729 | 46.63% | -0.083 |
| 06:00 | 0.2859 | 48.08% | -0.012 |
| 07:00 | 0.2878 | 50.96% | +0.034 |
| 08:00 | 0.3180 | 49.76% | +0.038 |
| 09:00 | 0.2943 | 53.85% | -0.037 |
| 10:00 | 0.2545 | 49.28% | +0.001 |
| 11:00 | 0.2854 | 50.72% | -0.023 |
| 12:00 | 0.3092 | 50.96% | -0.019 |
| 13:00 | 0.3916 | 48.08% | -0.028 |
| **14:00** | **0.5648** | 52.40% | +0.017 |
| **15:00** | **0.5819** | **56.25%** | +0.050 |
| 16:00 | 0.4896 | 50.96% | -0.098 |
| 17:00 | 0.4509 | 45.95% | -0.062 |
| 18:00 | 0.4117 | 48.57% | +0.040 |
| 19:00 | 0.3681 | 49.29% | +0.013 |
| 20:00 | 0.3482 | **54.07%** | **+0.062** |
| 21:00 | 0.3137 | 52.40% | +0.012 |
| 22:00 | 0.3645 | 50.00% | -0.022 |
| 23:00 | 0.3304 | 49.52% | -0.012 |

### Session Comparison

| Session | AvgRange% | Bull% | Next1h% |
|---|---|---|---|
| US Overlap (14-21 UTC) | 0.4411 | 51.24% | +0.004 |
| US Open burst (14-16 UTC) | 0.5454 | 53.20% | -0.011 |
| US Close (20-21 UTC) | 0.3309 | 53.24% | +0.037 |
| Asian quiet (03-07 UTC) | 0.2837 | 47.93% | -0.016 |
| Full Day (baseline) | 0.3575 | 49.93% | -0.006 |

### Significance (US Overlap vs Non-US)

| Metric | US Overlap | Non-US | t-stat | Cohen's d | 
|---|---|---|---|---|
| Avg Range% | 0.4410 | 0.3157 | 1146 | 0.42 (medium) |
| Avg Return% | +0.0006 | -0.0024 | 28.8 | 0.01 (negligible) |

### H1 CONCLUSIE

**ACCEPTEER** - US market hours (14-21 UTC) hebben structureel hogere volatility:
- Volatility is ~40% hoger tijdens US overlap vs non-US
- Effect size: Cohen's d = 0.42 (medium, robuust)
- US open burst (14-16 UTC): 2x zo hoog als Asian quiet hours
- **Directionele bias:** Geen significant directioneel voordeel gevonden
- **Post-event:** US close (20-21) heeft beste 1h forward returns (+0.037%)

**Mogelijk exploitabel:**
- Long volatility during US hours (elevated range in 14-17 UTC window)
- Long BTC during US close (20-21 UTC, 54% bullish, +0.062% avg next hour)

**Beperking:** 100 dagen data is beperkt voor zeldzame events. Significance driven by sample size, niet door magnitude.

---

## HYPOTHESE 2: BTC Lead-Lag

### Event Study (BTC >+1% or <-1%, ALT response)

| Alt | Horizon | nUp | avgAltUp% | sameDir% | nDown | avgAltDown% | oppDir% |
|---|---|---|---|---|---|---|---|
| ETH | 15m | 51 | -0.032 | 0% | 57 | +0.022 | 0% |
| ETH | 30m | 51 | **+0.180** | 57% | 57 | -0.037 | 51% |
| ETH | 1h | 51 | -0.169 | 0% | 57 | +0.119 | 0% |
| ETH | 2h | 51 | +0.013 | 57% | 57 | +0.113 | 0% |
| BNB | 30m | 51 | +0.102 | 53% | 57 | -0.058 | 53% |
| SOL | 30m | 51 | **+0.164** | 55% | 57 | **-0.149** | 51% |
| SOL | 1h | 51 | **-0.265** | 0% | 57 | +0.148 | 0% |

### Cross-Correlation at Lag

| Lag | BTC-ALT relationship | ETH | BNB | SOL |
|---|---|---|---|---|
| -2h (ALT leads) | ALT leads BTC | 0.894 | 0.856 | 0.861 |
| 0 (same time) | Contemporaneous | 0.894 | 0.856 | 0.862 |
| +1h (BTC leads) | BTC leads ALT | **-0.014** | **-0.020** | **-0.023** |
| +2h (BTC leads) | BTC leads ALT | **-0.008** | **-0.016** | **-0.018** |

### H2 CONCLUSIE

**REJECT** - BTC leidt alts NIET op korte horizon:

1. **Contemporaneous correlation is extreem hoog** (0.86-0.89) maar dit is SIMULTANE beweging, niet predictive
2. **BTC leads produceert nagenoeg 0 correlatie** (r = -0.01 to +0.01) - er is geen predictive relationship
3. **Na BTC +1%: alts bewegen gemiddeld tegenstrijdig** - SOL daalt gemiddeld 0.27% na 1h
4. **Na BTC -1%: alts Bewegen zijwaarts** - zwakke gemiddelde richting
5. **30min window is enige met licht directional响应** (ETH +0.18%, SOL -0.15% na BTC events)

**Mechanisme:** BTC en alts bewegen samen door gedeelde macro sentiment, niet omdat BTC causaal voorafgaat.

**Mogelijke contrarian edge:**
- SOL gemiddeld -0.27% 1h NA BTC +1% events
- SOL gemiddeld +0.15% 1h NA BTC -1% events
- Dit is zwak en niet significant

---

## COMBINED VERDICT

| Hypothesis | Result | Edge |
|---|---|---|
| H1: Time-of-day volatility | **ACCEPTEER** | Long vol during US open (14-17 UTC) |
| H2: BTC leads alts | **REJECT** | Geen voorspellende relatie |

**H1 tradeable?** Mogelijk als volatility edge in combinatie met andere signalen. Long-gamma during US hours is een prakische toepassing.

**H2 actionable?** Nee. De correlatie is contemporaneous, niet predictief. BTC en alts bewegen samen, maar BTC gaat niet vooraf.

**Volgende stap:** Combineer H1 (US hour elevated vol) met H2 finding (geen BTC lead). Geen rationale voor BTC-directionele trades gebaseerd op alt bewegingen.
