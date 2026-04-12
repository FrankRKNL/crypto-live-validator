#!/usr/bin/env node
/**
 * MICROSTRUCTURE ROBUSTNESS VALIDATOR
 * 
 * Frank's 5-phase robustness framework for pump momentum edge:
 * Phase 1: Out-of-sample (pooled across sessions = different times)
 * Phase 2: Parameter stability (threshold, exit windows)
 * Phase 3: Cross-asset validation (BTC, ETH, SOL)
 * Phase 4: Distribution (avg win/loss, win rate, tail events, worst-case DD)
 * Phase 5: Trade frequency reality (fees, slippage, execution)
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, 'microstructure-data', 'event-research');

// ─── HELPERS ─────────────────────────────────────────────
function pctChange(a, b) { return ((a - b) / b) * 100; }
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length || 0; }
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1)) || 0;
}
function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.286496581, a3 = 1.26551223,
        a4 = -1.30417387e-5, a5 = 5.007579009e-4, a6 = -1.683885e-3;
  const t = 1 / (1 + a1 * Math.abs(x) + a2 * x * x + a3 * Math.pow(Math.abs(x), 3) +
        a4 * Math.pow(Math.abs(x), 4) + a5 * Math.pow(Math.abs(x), 5) + a6 * Math.pow(Math.abs(x), 6));
  return x >= 0 ? 1 - t * Math.exp(-x * x) : t * Math.exp(-x * x) - 1;
}
function tTest(arr) {
  if (!arr || arr.length < 3) return { t: 0, p: 1, sig: false };
  const m = mean(arr);
  const s = std(arr);
  if (s === 0) return { t: 0, p: 1, sig: false };
  const n = arr.length;
  const se = s / Math.sqrt(n);
  const z = Math.abs(m / se);
  const t2 = 1 / (1 + 0.254829592 * z + (-0.286496581) * z * z +
        1.26551223 * Math.pow(Math.abs(z), 3) + (-1.30417387e-5) * Math.pow(Math.abs(z), 4) +
        5.007579009e-4 * Math.pow(Math.abs(z), 5) + (-1.683885e-3) * Math.pow(Math.abs(z), 6));
  const p = 2 * (1 - 0.5 * (1 + t2 * Math.exp(-z * z)));
  return { t: m / se, p, sig: z > 1.96 && p < 0.05 };
}

// ─── DATA LOADING ─────────────────────────────────────────
function loadTrades(symbol, sessionDir) {
  const path = join(DATA_DIR, sessionDir, `${symbol}-trades.csv`);
  try {
    const content = readFileSync(path, 'utf8');
    const lines = content.trim().split('\n');
    if (lines.length < 2) return [];
    const header = lines[0].split(',');
    const hasTradeId = header.includes('trade_id');
    return lines.slice(1).map(line => {
      const vals = line.split(',');
      if (hasTradeId) {
        return {
          timestamp_ms: parseInt(vals[0]),
          trade_id: parseInt(vals[1]),
          price: parseFloat(vals[2]),
          size: parseFloat(vals[3]),
          side: vals[4],
          is_buyer_maker: vals[5] === 'true',
        };
      } else {
        return {
          timestamp_ms: parseInt(vals[0]),
          price: parseFloat(vals[1]),
          size: parseFloat(vals[2]),
          side: vals[3],
          is_buyer_maker: vals[4] === 'true',
        };
      }
    });
  } catch (e) { return []; }
}

function loadEvents(symbol, sessionDir) {
  const path = join(DATA_DIR, sessionDir, `events-${symbol}.jsonl`);
  try {
    const content = readFileSync(path, 'utf8');
    return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (e) { return []; }
}

function getSessions() {
  return readdirSync(DATA_DIR)
    .filter(f => f.startsWith('session-'))
    .sort();
}

// ─── POST-EVENT ANALYSIS ───────────────────────────────────
const WINDOWS = [100, 500, 1000, 5000];

function computePostEventReturns(trades, event, windowMs) {
  const eventTime = event.ts ? new Date(event.ts).getTime() : event.timestamp_ms;
  const eventPrice = event.price;
  
  const afterTrades = trades.filter(t => {
    const tTime = t.timestamp_ms || t.ts;
    return tTime > eventTime && tTime <= eventTime + windowMs;
  });
  
  if (afterTrades.length === 0) return null;
  
  // Direction: event side (BUY = upward pressure, SELL = downward)
  const direction = (event.side === 'BUY' || event.direction === 'BUY') ? 1 : -1;
  
  // Price change from event price to last trade in window
  const lastPrice = afterTrades[afterTrades.length - 1].price;
  const ret = pctChange(lastPrice, eventPrice); // % change
  
  // Continuation: price moved in same direction as event
  // Reversal: price moved in opposite direction
  const continuation = (direction > 0 && ret > 0) || (direction < 0 && ret < 0);
  
  return { ret, continuation, nTrades: afterTrades.length };
}

function analyzeSession(symbol, session) {
  const trades = loadTrades(symbol, session);
  const events = loadEvents(symbol, session);
  
  if (trades.length === 0 || events.length === 0) return null;
  
  // Filter to LARGE_TRADE events
  const largeTradeEvents = events.filter(e => e.type === 'LARGE_TRADE');
  if (largeTradeEvents.length < 5) return null;
  
  const results = {};
  
  for (const win of WINDOWS) {
    const rets = [];
    const continuations = [];
    
    for (const event of largeTradeEvents) {
      const r = computePostEventReturns(trades, event, win);
      if (r !== null) {
        rets.push(r.ret);
        continuations.push(r.continuation ? 1 : 0);
      }
    }
    
    if (rets.length < 3) { results[win] = null; continue; }
    
    const avg = mean(rets);
    const revRate = mean(continuations) * 100; // % of events that continued
    const stat = tTest(rets);
    
    // SELL and BUY separately
    const sellRets = [], buyRets = [];
    for (let i = 0; i < largeTradeEvents.length; i++) {
      const r = computePostEventReturns(trades, largeTradeEvents[i], win);
      if (r === null) continue;
      if (largeTradeEvents[i].side === 'SELL') sellRets.push(r.ret);
      else if (largeTradeEvents[i].side === 'BUY') buyRets.push(r.ret);
    }
    
    results[win] = {
      n: rets.length,
      avg,
      std: std(rets),
      median: median(rets),
      revRate,
      t: stat.t,
      p: stat.p,
      sig: stat.sig,
      sell: sellRets.length >= 3 ? { ...tTest(sellRets), n: sellRets.length, avg: mean(sellRets) } : null,
      buy: buyRets.length >= 3 ? { ...tTest(buyRets), n: buyRets.length, avg: mean(buyRets) } : null,
      wins: rets.filter(r => r > 0).length,
      losses: rets.filter(r => r < 0).length,
      bigWins: rets.filter(r => r > 0.01).length,  // > 1bp
      bigLosses: rets.filter(r => r < -0.01).length,
    };
  }
  
  return results;
}

// ─── PARAMETER STABILITY ───────────────────────────────────
function runThresholdAnalysis() {
  console.log('\n### PHASE 2: PARAMETER STABILITY ###\n');
  console.log('Testing: threshold sensitivity (3x, 5x, 10x multiple)\n');
  
  // Use the latest session's detailed data for threshold variation
  const sessions = getSessions();
  const lastSession = sessions[sessions.length - 1];
  const trades = loadTrades('btcusdt', lastSession);
  
  if (!trades.length) { console.log('No trade data'); return; }
  
  // Compute average trade size
  const sizes = trades.map(t => t.size);
  const avgSize = mean(sizes);
  
  console.log(`Average trade size: ${(avgSize * 1000).toFixed(4)} mBTC`);
  
  for (const mult of [3, 5, 10]) {
    const threshold = avgSize * mult;
    const largeTrades = trades.filter(t => t.size > threshold);
    
    if (largeTrades.length < 5) continue;
    
    const rets = [];
    for (const lt of largeTrades) {
      const after = trades.filter(t => 
        t.timestamp_ms > lt.timestamp_ms && 
        t.timestamp_ms <= lt.timestamp_ms + 1000
      );
      if (after.length > 0) {
        rets.push(pctChange(after[after.length - 1].price, lt.price));
      }
    }
    
    if (rets.length < 3) continue;
    const stat = tTest(rets);
    console.log(`  ${mult}x threshold: n=${rets.length}, avg=${mean(rets).toFixed(4)}%, t=${stat.t.toFixed(2)}, sig=${stat.sig}`);
  }
}

// ─── DISTRIBUTION ANALYSIS ─────────────────────────────────
function runDistributionAnalysis(symbol, session) {
  console.log('\n### PHASE 4: DISTRIBUTION ANALYSIS ###\n');
  
  const trades = loadTrades(symbol, session);
  const events = loadEvents(symbol, session);
  
  if (!trades.length || !events.length) return;
  
  const largeTradeEvents = events.filter(e => e.type === 'LARGE_TRADE');
  const rets = [], sellRets = [], buyRets = [];
  
  for (const event of largeTradeEvents) {
    const r = computePostEventReturns(trades, event, 1000);
    if (r === null) continue;
    rets.push(r.ret);
    if (event.side === 'SELL') sellRets.push(r.ret);
    else if (event.side === 'BUY') buyRets.push(r.ret);
  }
  
  if (!rets.length) return;
  
  const avg = mean(rets);
  const sdev = std(rets);
  const med = median(rets);
  
  console.log(`Distribution for ${symbol.toUpperCase()}:`);
  console.log(`  n = ${rets.length}`);
  console.log(`  mean = ${avg.toFixed(4)}%`);
  console.log(`  median = ${med.toFixed(4)}%`);
  console.log(`  std = ${sdev.toFixed(4)}%`);
  console.log(`  min = ${Math.min(...rets).toFixed(4)}%`);
  console.log(`  max = ${Math.max(...rets).toFixed(4)}%`);
  console.log(`  win rate = ${(rets.filter(r => r > 0).length / rets.length * 100).toFixed(1)}%`);
  console.log(`  avg win = ${mean(rets.filter(r => r > 0)).toFixed(4)}%`);
  console.log(`  avg loss = ${mean(rets.filter(r => r < 0)).toFixed(4)}%`);
  console.log(`  best = ${Math.max(...rets).toFixed(4)}% | worst = ${Math.min(...rets).toFixed(4)}%`);
  
  // Percentile distribution
  const sorted = [...rets].sort((a, b) => a - b);
  const p5 = sorted[Math.floor(sorted.length * 0.05)].toFixed(4);
  const p95 = sorted[Math.floor(sorted.length * 0.95)].toFixed(4);
  console.log(`  5th percentile = ${p5}% | 95th = ${p95}%`);
  
  // Big wins vs small gains
  const bigWins = rets.filter(r => r > 0.01).length;
  const smallWins = rets.filter(r => r > 0 && r <= 0.01).length;
  console.log(`  big wins (>1bp) = ${bigWins} | small wins (<=1bp) = ${smallWins}`);
  
  return { rets, avg, med, sdev, winRate: rets.filter(r => r > 0).length / rets.length };
}

// ─── TRADE FREQUENCY REALITY ───────────────────────────────
function runFrequencyRealityCheck(sessions) {
  console.log('\n### PHASE 5: TRADE FREQUENCY REALITY ###\n');
  
  let totalTrades = 0, totalEvents = 0, totalSessions = 0;
  
  for (const session of sessions) {
    const trades = loadTrades('btcusdt', session);
    const events = loadEvents('btcusdt', session);
    if (trades.length > 0) {
      totalTrades += trades.length;
      totalEvents += events.filter(e => e.type === 'LARGE_TRADE').length;
      totalSessions++;
    }
  }
  
  if (totalSessions === 0) return;
  
  const avgTradesPerSession = totalTrades / totalSessions;
  const avgEventsPerSession = totalEvents / totalSessions;
  const avgDurationMin = avgTradesPerSession > 0 ? avgTradesPerSession / 20 : 0; // ~20 trades/sec
  
  console.log(`Sessions analyzed: ${totalSessions}`);
  console.log(`Avg trades/session: ${avgTradesPerSession.toFixed(0)} (${avgDurationMin.toFixed(1)} min session)`);
  console.log(`Avg large events/session: ${avgEventsPerSession.toFixed(1)}`);
  
  // Fee impact calculation
  const feePerTrade = 0.06; // 0.04% maker + 0.02% taker estimate
  const signalSize = 0.016; // max signal from research (0.016% at 30s)
  
  console.log(`\nFee impact:`);
  console.log(`  Signal magnitude: ${signalSize.toFixed(4)}%`);
  console.log(`  Fee per trade: ${feePerTrade.toFixed(4)}%`);
  console.log(`  Net after fees: ${(signalSize - feePerTrade).toFixed(4)}%`);
  console.log(`  Break-even win rate: ${(feePerTrade / signalSize * 100).toFixed(1)}%`);
  
  // Annualized projection
  const eventsPerHour = avgEventsPerSession / avgDurationMin * 60;
  const eventsPerDay = eventsPerHour * 24;
  const expectedDailyNet = eventsPerDay * (signalSize - feePerTrade) / 100;
  console.log(`\nProjected daily events: ${eventsPerDay.toFixed(0)}`);
  console.log(`Expected daily PnL: ${expectedDailyNet.toFixed(4)}% of equity`);
  console.log(`Annualized (compounded): ${(((1 + expectedDailyNet / 100) ** 365 - 1) * 100).toFixed(1)}%`);
}

// ─── MAIN ─────────────────────────────────────────────────
console.log('+=====================================================================+');
console.log('|  PUMP MOMENTUM ROBUSTNESS VALIDATION                              |');
console.log('+=====================================================================+');

const sessions = getSessions();
console.log(`\nFound ${sessions.length} data sessions\n`);

// PHASE 1: OUT-OF-SAMPLE — pool sessions to simulate different time periods
console.log('### PHASE 1: OUT-OF-SAMPLE VALIDATION ###\n');
console.log('Pooling all sessions across different time windows...\n');

const poolByWindow = { 100: { SELL: [], BUY: [] }, 500: { SELL: [], BUY: [] }, 1000: { SELL: [], BUY: [] }, 5000: { SELL: [], BUY: [] } };

let validSessions = 0;
for (const session of sessions) {
  const btcResult = analyzeSession('btcusdt', session);
  const ethResult = analyzeSession('ethusdt', session);
  
  if (!btcResult && !ethResult) continue;
  validSessions++;
  
  console.log(`Session: ${session.slice(-17)} — ${btcResult ? `BTC n=${btcResult[1000]?.n || 0}` : 'no data'}, ${ethResult ? `ETH n=${ethResult[1000]?.n || 0}` : 'no data'}`);
  
  for (const win of [100, 500, 1000, 5000]) {
    if (btcResult?.[win]?.sell?.n >= 3) {
      poolByWindow[win].SELL.push(...Array(btcResult[win].sell.n).fill(btcResult[win].sell.avg));
    }
    if (btcResult?.[win]?.buy?.n >= 3) {
      poolByWindow[win].BUY.push(...Array(btcResult[win].buy.n).fill(btcResult[win].buy.avg));
    }
  }
}

console.log(`\nValid sessions: ${validSessions}/${sessions.length}\n`);
console.log('### POOLED RESULTS (across all sessions) ###\n');

for (const win of [100, 500, 1000, 5000]) {
  const sell = poolByWindow[win].SELL;
  const buy = poolByWindow[win].BUY;
  if (sell.length >= 3) {
    const stat = tTest(sell);
    console.log(`[${win}ms] SELL: n=${sell.length}, avg=${mean(sell).toFixed(4)}%, t=${stat.t.toFixed(2)}, sig=${stat.sig}`);
  }
  if (buy.length >= 3) {
    const stat = tTest(buy);
    console.log(`[${win}ms] BUY: n=${buy.length}, avg=${mean(buy).toFixed(4)}%, t=${stat.t.toFixed(2)}, sig=${stat.sig}`);
  }
}

// PHASE 2: PARAMETER STABILITY
runThresholdAnalysis();

// PHASE 3: CROSS-ASSET
console.log('\n### PHASE 3: CROSS-ASSET VALIDATION ###\n');
for (const symbol of ['btcusdt', 'ethusdt']) {
  const results = {};
  for (const session of sessions) {
    const r = analyzeSession(symbol, session);
    if (r && r[1000]) results[session] = r[1000];
  }
  
  if (Object.keys(results).length > 0) {
    console.log(`${symbol.toUpperCase()} — sessions with data: ${Object.keys(results).length}`);
    for (const [s, r] of Object.entries(results)) {
      console.log(`  ${s.slice(-17)}: n=${r.n}, avg=${r.avg.toFixed(4)}%, t=${r.t.toFixed(2)}, sell=${r.sell ? `n=${r.sell.n} avg=${r.sell.avg.toFixed(4)}%` : 'N/A'}, buy=${r.buy ? `n=${r.buy.n} avg=${r.buy.avg.toFixed(4)}%` : 'N/A'}`);
    }
  }
}

// PHASE 4: DISTRIBUTION
console.log('\n');
runDistributionAnalysis('btcusdt', sessions[sessions.length - 1]);

// PHASE 5: FREQUENCY REALITY
runFrequencyRealityCheck(sessions);

// ─── FINAL VERDICT ─────────────────────────────────────────
console.log('\n+=====================================================================+');
console.log('|  ROBUSTNESS VERDICT                                                  |');
console.log('+=====================================================================+');