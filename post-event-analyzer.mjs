#!/usr/bin/env node
/**
 * POST-EVENT ANALYSIS - Event-Driven Microstructure
 * 
 * For each detected LARGE_TRADE event, measure price behavior in windows after.
 * Continuation vs Reversal classification.
 * 
 * Also runs sequence analysis: Event A followed by Event B.
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, 'microstructure-data', 'event-research');

// ─── HELPERS ─────────────────────────────────────────────
function pctChange(a, b) { return ((a - b) / b) * 100; }
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function normalCDF(x) {
  const a1=0.254829592, a2=-0.286496581, a3=1.26551223,
        a4=-1.30417387e-5, a5=5.007579009e-4, a6=-1.683885e-3;
  const t = 1/(1+a1*Math.abs(x)+a2*x*x+a3*Math.pow(Math.abs(x),3)+
        a4*Math.pow(Math.abs(x),4)+a5*Math.pow(Math.abs(x),5)+a6*Math.pow(Math.abs(x),6));
  return x >= 0 ? 1 - t*Math.exp(-x*x) : t*Math.exp(-x*x) - 1;
}

function tTestVsZero(arr) {
  if (!arr || arr.length < 3) return { t: 0, p: 1, sig: false };
  const m = mean(arr);
  const s = std(arr);
  if (s === 0) return { t: 0, p: 1, sig: false };
  const n = arr.length;
  const se = s / Math.sqrt(n);
  const t = m / se;
  const z = Math.abs(t);
  const p = Math.max(0.0001, Math.min(1, 2 * (1 - normalCDF(z))));
  return { t, p, sig: Math.abs(t) > 1.96 && p < 0.05 };
}

// ─── DATA LOADING ─────────────────────────────────────────
function getLatestSession() {
  const sessions = readdirSync(DATA_DIR)
    .filter(f => f.startsWith('session-'))
    .sort()
    .reverse();
  return sessions[0];
}

function loadTrades(symbol, sessionDir) {
  const path = join(DATA_DIR, sessionDir, `${symbol}-trades.csv`);
  try {
    const content = readFileSync(path, 'utf8');
    const lines = content.trim().split('\n');
    const header = lines[0].split(',');
    const hasTradeId = header[1] === 'trade_id';
    
    const trades = lines.slice(1).map(line => {
      const vals = line.split(',');
      if (hasTradeId) {
        return {
          ts: parseInt(vals[0]),  // actual trade timestamp (ms)
          trade_id: parseInt(vals[1]),
          price: parseFloat(vals[2]),
          size: parseFloat(vals[3]),
          side: vals[4],
          isBuyerMaker: vals[5] === 'true',
        };
      } else {
        return {
          ts: parseInt(vals[0]),
          price: parseFloat(vals[1]),
          size: parseFloat(vals[2]),
          side: vals[3],
          isBuyerMaker: vals[4] === 'true',
        };
      }
    });
    
    // Sort by timestamp
    trades.sort((a, b) => a.ts - b.ts);
    return trades;
  } catch (e) {
    return [];
  }
}

function loadEvents(symbol, sessionDir) {
  const path = join(DATA_DIR, sessionDir, `events-${symbol}.jsonl`);
  try {
    const content = readFileSync(path, 'utf8');
    return content.trim().split('\n').map(line => JSON.parse(line));
  } catch (e) {
    return [];
  }
}

// ─── POST-EVENT ANALYSIS ───────────────────────────────────
const WINDOWS = [100, 500, 1000, 5000];  // ms

function analyzeLargeTradeEvents(trades, events) {
  const largeTrades = events.filter(e => e.type === 'LARGE_TRADE');
  if (largeTrades.length === 0) return null;
  
  const sellEvents = largeTrades.filter(e => e.side === 'SELL');
  const buyEvents = largeTrades.filter(e => e.side === 'BUY');
  
  console.log(`\n  LARGE_TRADE events: ${largeTrades.length} total (${sellEvents.length} SELL, ${buyEvents.length} BUY)`);
  
  // For each window, calculate post-event returns
  const results = {};
  
  for (const win of WINDOWS) {
    results[win] = { sell: [], buy: [] };
    
    for (const event of largeTrades) {
      const eventMs = new Date(event.ts).getTime();
      
      // Find trades strictly AFTER the event (event timestamp = trade timestamp)
      const after = trades.filter(t => t.ts > eventMs && t.ts <= eventMs + win);
      
      if (after.length === 0) continue;
      
      const lastPrice = after[after.length - 1].price;
      const priceChange = pctChange(lastPrice, event.price);
      
      const bucket = event.side === 'SELL' ? 'sell' : 'buy';
      results[win][bucket].push({
        eventPrice: event.price,
        lastPrice,
        size: event.size,
        ratio: event.ratio,
        change: priceChange,
        // Reversal: SELL followed by price UP = bullish reversal
        //          BUY followed by price DOWN = bearish reversal
        isReversal: (event.side === 'SELL' && priceChange > 0) ||
                    (event.side === 'BUY' && priceChange < 0),
      });
    }
  }
  
  return results;
}

function printWindowResults(results, win) {
  const winLabel = win === 100 ? '100ms' : win === 500 ? '500ms' : win === 1000 ? '1s' : '5s';
  const r = results[win];
  
  console.log(`\n  [${winLabel} window]`);
  
  for (const side of ['sell', 'buy']) {
    const changes = r[side].map(e => e.change);
    const reversals = r[side].filter(e => e.isReversal).length;
    const n = changes.length;
    if (n < 3) {
      console.log(`    ${side.toUpperCase()}: n=${n} (need 3+ for stats)`);
      continue;
    }
    
    const avg = mean(changes);
    const revRate = reversals / n;
    const stats = tTestVsZero(changes);
    
    console.log(`    ${side.toUpperCase()}: n=${n}, avg=${avg.toFixed(4)}%, revRate=${(revRate*100).toFixed(1)}%, t=${stats.t.toFixed(2)}, p=${stats.p.toFixed(4)} ${stats.sig ? '**SIG**' : ''}`);
    
    // Size bins
    const small = r[side].filter(e => e.ratio < 5);
    const medium = r[side].filter(e => e.ratio >= 5 && e.ratio < 10);
    const large = r[side].filter(e => e.ratio >= 10);
    
    if (small.length >= 3) {
      const s = tTestVsZero(small.map(e => e.change));
      console.log(`      3-5x: n=${small.length}, avg=${mean(small.map(e=>e.change)).toFixed(4)}%, t=${s.t.toFixed(2)} ${s.sig ? '**' : ''}`);
    }
    if (medium.length >= 3) {
      const s = tTestVsZero(medium.map(e => e.change));
      console.log(`      5-10x: n=${medium.length}, avg=${mean(medium.map(e=>e.change)).toFixed(4)}%, t=${s.t.toFixed(2)} ${s.sig ? '**' : ''}`);
    }
    if (large.length >= 3) {
      const s = tTestVsZero(large.map(e => e.change));
      console.log(`      >10x: n=${large.length}, avg=${mean(large.map(e=>e.change)).toFixed(4)}%, t=${s.t.toFixed(2)} ${s.sig ? '**' : ''}`);
    }
  }
}

// ─── MAIN ANALYSIS ────────────────────────────────────────
async function main() {
  console.log('+=====================================================================+');
  console.log('|  POST-EVENT ANALYSIS - Event-Driven Microstructure                |');
  console.log('+=====================================================================+\n');
  
  const session = getLatestSession();
  if (!session) {
    console.log('No session found');
    return;
  }
  console.log(`Session: ${session}\n`);
  
  const SYMBOLS = ['btcusdt', 'ethusdt'];
  const allResults = {};
  
  for (const symbol of SYMBOLS) {
    console.log(`=== ${symbol.toUpperCase()} ===`);
    
    const trades = loadTrades(symbol, session);
    const events = loadEvents(symbol, session);
    
    console.log(`  Trades: ${trades.length}, Events: ${events.length}`);
    
    if (trades.length === 0 || events.length === 0) {
      console.log('  No data\n');
      continue;
    }
    
    // Show trade timestamp range
    console.log(`  Trade timestamps: ${new Date(trades[0].ts).toISOString().slice(11, 23)} → ${new Date(trades[trades.length-1].ts).toISOString().slice(11, 23)}`);
    console.log(`  Duration: ${((trades[trades.length-1].ts - trades[0].ts) / 1000 / 60).toFixed(1)} min`);
    
    const results = analyzeLargeTradeEvents(trades, events);
    
    if (results) {
      for (const win of WINDOWS) {
        printWindowResults(results, win);
      }
    }
    
    // Sequence analysis
    console.log('\n  [SEQUENCES] Event patterns within 30s:');
    const sortedEvents = [...events].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    
    const sequences = {};
    
    for (let i = 0; i < sortedEvents.length - 1; i++) {
      const curr = sortedEvents[i];
      const next = sortedEvents[i + 1];
      const dt = new Date(next.ts).getTime() - new Date(curr.ts).getTime();
      if (dt > 30000 || dt < 0) continue;
      
      const key = `${curr.type}_${curr.side || curr.direction || 'NA'}→${next.type}_${next.side || next.direction || 'NA'}`;
      if (!sequences[key]) sequences[key] = { count: 0, pattern: key };
      sequences[key].count++;
    }
    
    // Print most common sequences
    const sortedSeqs = Object.values(sequences).sort((a, b) => b.count - a.count);
    sortedSeqs.slice(0, 8).forEach(s => {
      console.log(`    ${s.pattern}: ${s.count}x`);
    });
    
    allResults[symbol] = results;
    console.log('');
  }
  
  // ─── CROSS-ASSET SUMMARY ──────────────────────────────────
  console.log('+=====================================================================+');
  console.log('|  CROSS-ASSET SUMMARY                                                  |');
  console.log('+=====================================================================+');
  
  let hasAnyResults = false;
  for (const symbol of SYMBOLS) {
    if (!allResults[symbol]) continue;
    hasAnyResults = true;
    const r = allResults[symbol];
    
    console.log(`\n  ${symbol.toUpperCase()} at 1s:`);
    if (r[1000]) {
      const sellStats = tTestVsZero(r[1000].sell.map(e => e.change));
      const buyStats = tTestVsZero(r[1000].buy.map(e => e.change));
      console.log(`    SELL: n=${r[1000].sell.length}, avg=${mean(r[1000].sell.map(e=>e.change)).toFixed(4)}%, revRate=${(r[1000].sell.filter(e=>e.isReversal).length/r[1000].sell.length*100).toFixed(1)}%, t=${sellStats.t.toFixed(2)} ${sellStats.sig ? '**' : ''}`);
      console.log(`    BUY: n=${r[1000].buy.length}, avg=${mean(r[1000].buy.map(e=>e.change)).toFixed(4)}%, revRate=${(r[1000].buy.filter(e=>e.isReversal).length/r[1000].buy.length*100).toFixed(1)}%, t=${buyStats.t.toFixed(2)} ${buyStats.sig ? '**' : ''}`);
    }
  }
  
  if (!hasAnyResults) {
    console.log('\n  No results yet. Need longer data collection.');
  }
  
  console.log('\n+=====================================================================+');
  console.log('|  INTERPRETATION                                                       |');
  console.log('+=====================================================================+');
  console.log('  Reversal Rate > 50%: Large trade tends to reverse (price goes opposite direction)');
  console.log('  Reversal Rate < 50%: Large trade tends to continue (price goes same direction)');
  console.log('  t > 1.96: Statistically significant at 95% confidence');
  console.log('  **SIG**: Statistically significant edge detected');
  console.log('\n  Note: Results from ~10 min session. Need longer runs across market conditions.');
  console.log('  Edge may be stronger in trending vs ranging markets, or at specific times.');
  
  // Save results to file
  const reportPath = join(DATA_DIR, session, 'POST-EVENT-REPORT.md');
  let report = `# Post-Event Analysis Report\n\nSession: ${session}\n\n`;
  
  for (const symbol of SYMBOLS) {
    if (!allResults[symbol]) continue;
    report += `\n## ${symbol.toUpperCase()}\n\n`;
    if (allResults[symbol][1000]) {
      const r = allResults[symbol][1000];
      report += `### 1s Window\n\n`;
      report += `| Side | n | Avg Return | Rev Rate | t-stat |\n`;
      report += `|------|---|-----------|----------|--------|\n`;
      const sellAvg = mean(r.sell.map(e => e.change));
      const buyAvg = mean(r.buy.map(e => e.change));
      const sellRevRate = r.sell.filter(e => e.isReversal).length / r.sell.length * 100;
      const buyRevRate = r.buy.filter(e => e.isReversal).length / r.buy.length * 100;
      const sellStats = tTestVsZero(r.sell.map(e => e.change));
      const buyStats = tTestVsZero(r.buy.map(e => e.change));
      report += `| SELL | ${r.sell.length} | ${sellAvg.toFixed(4)}% | ${sellRevRate.toFixed(1)}% | ${sellStats.t.toFixed(2)} |\n`;
      report += `| BUY | ${r.buy.length} | ${buyAvg.toFixed(4)}% | ${buyRevRate.toFixed(1)}% | ${buyStats.t.toFixed(2)} |\n`;
    }
  }
  
  writeFileSync(reportPath, report);
  console.log('\n  Report saved to:', reportPath);
}

main().catch(console.error);
