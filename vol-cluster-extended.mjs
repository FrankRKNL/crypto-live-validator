/**
 * BTC VOLUME CLUSTER REVERSAL - EXTENDED BACKTEST
 * Tests: High-volume bearish candles (>2.5x avg vol, >0.5% down) → buy → hold 1h
 * Extended from Phase 5 (n=9) to full 5-year dataset
 */

import Binance from 'binance-api-node';
import { writeFileSync } from 'fs';

const client = Binance();
const symbol = 'BTCUSDT';
const interval = '1h';
const startTime = Date.now() - (5 * 365 * 24 * 60 * 60 * 1000);

// Fetch candles
const candles = await client.candles({ symbol, interval, startTime, limit: 10000 });
console.log(`Loaded ${candles.length} candles from ${new Date(candles[0].openTime).toISOString()}`);

// Calculate volume stats (rolling 24h)
function getAvgVol(candles, i, window = 24) {
  if (i < window) return candles.slice(0, i+1).reduce((s, c) => s + Number(c.volume), 0) / (i+1);
  return candles.slice(i-window, i).reduce((s, c) => s + Number(c.volume), 0) / window;
}

// Test different configs
const configs = [
  { volMult: 2.0, priceDrop: 0.3, hold: 1, name: 'Vol2.0_PDrop0.3_Hold1h' },
  { volMult: 2.5, priceDrop: 0.5, hold: 1, name: 'Vol2.5_PDrop0.5_Hold1h' },
  { volMult: 3.0, priceDrop: 0.5, hold: 1, name: 'Vol3.0_PDrop0.5_Hold1h' },
  { volMult: 2.5, priceDrop: 0.5, hold: 2, name: 'Vol2.5_PDrop0.5_Hold2h' },
  { volMult: 2.5, priceDrop: 1.0, hold: 1, name: 'Vol2.5_PDrop1.0_Hold1h' },
  { volMult: 2.0, priceDrop: 0.5, hold: 1, name: 'Vol2.0_PDrop0.5_Hold1h' },
];

const results = {};

for (const cfg of configs) {
  const trades = [];
  let inTrade = false;
  let entryPrice = 0;
  let entryIdx = 0;
  
  for (let i = 24; i < candles.length - cfg.hold; i++) {
    const c = candles[i];
    const avgVol = getAvgVol(candles, i);
    const vol = Number(c.volume);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const open = Number(c.open);
    const priceDrop = ((open - close) / open) * 100;
    
    if (!inTrade && vol > avgVol * cfg.volMult && priceDrop > cfg.priceDrop) {
      // Signal: high volume bearish candle
      entryPrice = close;
      entryIdx = i;
      inTrade = true;
    } else if (inTrade) {
      const holdCandles = candles.slice(entryIdx + 1, entryIdx + 1 + cfg.hold);
      const exitPrice = Number(holdCandles[holdCandles.length - 1].close);
      const ret = ((exitPrice - entryPrice) / entryPrice) * 100;
      
      trades.push({
        entry: new Date(candles[entryIdx].openTime).toISOString(),
        entryPrice,
        exit: new Date(holdCandles[holdCandles.length - 1].openTime).toISOString(),
        exitPrice,
        return: ret,
        win: ret > 0
      });
      inTrade = false;
    }
  }
  
  if (trades.length === 0) continue;
  
  const returns = trades.map(t => t.return);
  const wins = returns.filter(r => r > 0).length;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const tstat = mean / (std / Math.sqrt(returns.length));
  
  // Sort by return for equity curve
  const sorted = [...returns].sort();
  let equity = 1;
  const equityCurve = [1];
  for (const r of sorted) {
    equity *= (1 + r/100);
    equityCurve.push(equity);
  }
  
  // Drawdown
  let maxDD = 0;
  let peak = 1;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  results[cfg.name] = {
    n: trades.length,
    mean: mean.toFixed(3),
    std: std.toFixed(3),
    t: tstat.toFixed(2),
    wr: `${((wins/trades.length)*100).toFixed(0)}%`,
    wins: wins,
    losses: trades.length - wins,
    maxDD: `${(maxDD*100).toFixed(1)}%`,
    equity: equity.toFixed(3),
    best: Math.max(...returns).toFixed(2),
    worst: Math.min(...returns).toFixed(2),
  };
  
  console.log(`${cfg.name}: n=${trades.length}, mean=${mean.toFixed(3)}%, t=${tstat.toFixed(2)}, WR=${((wins/trades.length)*100).toFixed(0)}%, equity=${equity.toFixed(3)}`);
}

writeFileSync('/home/node/.openclaw/workspace/crypto-daytrader/results/vol-cluster-extended.json', JSON.stringify(results, null, 2));
console.log('\nResults saved. Best configs:');
const best = Object.entries(results).sort((a, b) => parseFloat(b[1].mean) - parseFloat(a[1].mean));
best.slice(0, 3).forEach(([k, v]) => console.log(`  ${k}: mean=${v.mean}%`));
