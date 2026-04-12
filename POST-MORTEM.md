# PUMP STRATEGY — POST-MORTEM
**Datum:** 2026-04-12  
**Status:** REJECTED voor autonome day trading

---

## 1. Samenvatting Validatie

| Test | Resultaat | Portefeuille |
|------|-----------|--------------|
| Cross-Asset BTC | -0.26%/trade, 32% win | Weigeren |
| Cross-Asset ETH | -0.15%/trade, 36% win | Weigeren |
| Cross-Asset BNB | -0.05%/trade | Weigeren |
| Cross-Asset SOL | -0.16%/trade | Weigeren |
| Subperiodes | Faalt 5/6 periodes | Weigeren |
| Parameter robustness | 0/13 variaties positief | Weigeren |
| Fee sensitivity | Faalt bij alle niveaus | Weigeren |

**Conclusie: Strategy rejected. Geen verdere optimalisatie.**

---

## 2. Post-Mortem: Waarom BTC Wel Werkte

### BTC
- **Gedrag:** "Buy the dip" mentaliteit — na sterke pump dalen kopers wieder in
- **Mechanisme:** Safe haven narrative, historische precedenten
- **Statistisch:** +0.97%/trade (p=0.0017), 76% win rate, 2.88 WL ratio
- **Maar:** 32% win rate in live validatie (kleine sample, mogelijk geluk)

### ETH
- **Gedrag:** Altcoin momentum — pumps worden verkocht, niet gekocht
- **Mechanisme:** Risico-on gedrag, verschillende marktparticipantprofiel
- **Statistisch:** +1.84% in backtest (p<0.0001), maar live faalde ETH door andere correlatie-structuur
- **Root cause:** Altcoin risk-on/sentiment cycle is fundamenteel anders dan BTC

### Meest Plausibele Verklaring: Asset Class Effect

| | BTC | ETH |
|--|-----|-----|
| **Marktgedrag** | Safe haven, koop-dip reflex | Altcoin momentum |
| **Sentimentkarakter** | Tegen-cyclisch | Pro-cyclisch |
| **Backtest sample** | 3 jaar | 3 jaar |
| **Live validatie** | 32% win (klein) | 36% win (klein) |
| **Conclusie** | Kleine edge mogelijk | Geen edge |

**BTC-only backtest is misleidend:** Wat werkt voor BTC werkt niet voor altcoins. De "crypto markt" is niet homogeneous.

---

## 3. Formele Les

### ❌ NIET DOEN
- Single-asset validatie als bewijs voor strategiwerkzaamheid
- Parameters tunen na mislukte validatie ("reddingspoging")
- Ex-post optimalisatie op validatieset

### ✅ WEL DOEN
- **Cross-asset validatie is VERPLICHT**
- Ten minste 3 assets testen (BTC + ETH + 1 altcoin)
- Pas accepteren als 2/3 assets positief zijn
- Hypothese moet mechanisme uitleggen, niet alleen parameter fit

---

## 4. Nieuwe Hypothesen Shortlist

### Hypothese 1: Cross-Asset Sentiment Transfer
**Mechanisme:** BTC sentiment leidt ETH sentiment (niet prijs)  
**Anders dan eerder:** Lead-lag tests faalden voor PRIJS, maar SENTIMENT transfer is ander mechanisme  
**Data:** BTC 1h candles + ETH funding rate + ETH orderbook imbalance  
**Kans:** Middelmatig (BTC→ETH is aangetoond in literatuur, maar transfer naar tradebaar signaal onbewezen)

### Hypothese 2: Funding Rate Second Derivative
**Mechanisme:** Acceleration van funding rate (niet level) voorspelt correctie  
**Anders dan eerder:** A1 (funding extremes) faalde — level gebaseerd. Acceleration = totaal ander signaal.  
**Data:** 4-uurs funding rate time series, bereken derivative, vergelijk met price response  
**Kans:** Zwak (maar fundamenteel ander mechanisme dan funding extremes)

### Hypothese 3: Liquidity Void Reversal
**Mechanisme:** Prijs valt in "gap" in orderbook liquidity — reversal verwacht  
**Anders dan eerder:** Volume spike continuation faalde. Orderbook microstructure is fundamenteal ander mechanisme.  
**Data:** Binance depth snapshots (of proxy via candlestick volume distributie)  
**Kans:** Middelmatig ( microstructure literature ondersteunt, maar trading complexity hoog)

---

## 5. Aanbevolen Volgende Stap

**Start met Hypothese 1** (Cross-Asset Sentiment Transfer)
- Data beschikbaar (Binance public API)
- Fundamenteel ander mechanisme dan candle/EMA/volume patronen
- Geen overlap met eerdere tests
- BTC→ETH causaal verband literatuur-ondersteund

**Niet starten met Hypothese 2 of 3** — deze hebben hoge complexiteit en lagere prioriteit.

---

## 6. Formele Afsluiting PUMP

```
STRATEGIE: PUMP-REVERSAL (EMA100 + 0.8% threshold + 1.5% TS)
STATUS: REJECTED
REDE: Cross-asset validatie gefaald (0/5 assets positief)
LESSEN: 
  - Single-asset validatie is onvoldoende
  - BTC-only backtest is misleidend voor crypto markt
  - Geen reddingspogingen na rigoreuze rejectie
DOOR: FrankRKNL/crypto-live-validator
DATUM: 2026-04-12
```