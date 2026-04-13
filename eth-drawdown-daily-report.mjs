#!/usr/bin/env node
/**
 * ETH Drawdown Recovery — Daily Summary Generator
 * 
 * Run daily (or after each round) to print a formatted report.
 * Reads from logs/eth-drawdown/state.json
 * 
 * Usage:
 *   node eth-drawdown-daily-report.mjs
 *   node eth-drawdown-daily-report.mjs --watch  (continuous)
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'logs', 'eth-drawdown', 'state.json');
const IS_WATCH = process.argv.includes('--watch');

const CONFIG = {
  targetTrades: 20,
  backtestWR: 66,
  backtestNet: 1.139,
  backtestMAE: -1.4,
  backtestMFE: 3.9,
};

function loadState() {
  if (!existsSync(STATE_FILE)) {
    console.log('No state file found — run eth-drawdown-validator.mjs first');
    return null;
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function printReport(state) {
  const today = new Date().toISOString().slice(0, 10);
  const todayStats = state.dailyStats?.[today] || {};
  const progress = Math.min(state.totalTrades / CONFIG.targetTrades, 1);
  const bar = '█'.repeat(Math.floor(progress * 20)) + '░'.repeat(20 - Math.floor(progress * 20));
  
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   ETH DRAWDOWN RECOVERY — SHADOW VALIDATOR REPORT   ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Equity:        $${state.equity.toFixed(2).padStart(12)}              ║`);
  console.log(`║  Total Signals: ${String(state.totalSignals).padStart(4)}                               ║`);
  console.log(`║  Total Trades:  ${String(state.totalTrades).padStart(4)}                               ║`);
  console.log(`║  Open Trades:   ${String(state.openTrades.length).padStart(4)}                               ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  
  // Win rate
  let winRate = null, avgPnl = null, avgMae = null, avgMfe = null;
  if (state.trades.length > 0) {
    const winners = state.trades.filter(t => t.realizedPnlPct > 0);
    winRate = (winners.length / state.trades.length * 100).toFixed(1);
    avgPnl = (state.trades.reduce((s, t) => s + t.realizedPnlPct, 0) / state.trades.length).toFixed(3);
    avgMae = (state.trades.reduce((s, t) => s + t.maxAdverse, 0) / state.trades.length).toFixed(3);
    avgMfe = (state.trades.reduce((s, t) => s + t.maxFavorable, 0) / state.trades.length).toFixed(3);
  }
  
  console.log(`║  Win Rate:      ${winRate !== null ? winRate + '%'.padStart(9) : '  --'.padStart(13)}                   ║`);
  console.log(`║  Avg PnL/trade: ${avgPnl !== null ? avgPnl + '%'.padStart(10) : '  --'.padStart(14)}                  ║`);
  console.log(`║  Avg MAE:       ${avgMae !== null ? avgMae + '%'.padStart(10) : '  --'.padStart(14)}                  ║`);
  console.log(`║  Avg MFE:       ${avgMfe !== null ? avgMfe + '%'.padStart(10) : '  --'.padStart(14)}                  ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Backtest ref:  WR=${CONFIG.backtestWR}% | net=${CONFIG.backtestNet}% | MAE=${CONFIG.backtestMAE}%  ║`);
  
  // Validation verdict
  let verdict = '⏳ TOO EARLY';
  if (state.totalTrades >= 5) {
    const wrDiff = winRate !== null ? Math.abs(parseFloat(winRate) - CONFIG.backtestWR) : 999;
    const pnlDiff = avgPnl !== null ? Math.abs(parseFloat(avgPnl) - CONFIG.backtestNet) : 999;
    if (wrDiff <= 15 && pnlDiff <= 0.8) {
      verdict = '✅ IN LINE — ready for paper trading';
    } else if (wrDiff <= 25 && pnlDiff <= 1.5) {
      verdict = '⚠️ CAUTION — monitor closely';
    } else {
      verdict = '❌ DIVERGENT — check strategy';
    }
  }
  
  console.log(`║  Validation:   ${verdict.padStart(40)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  
  // Progress bar
  console.log(`\n  Progress: [${bar}] ${state.totalTrades}/${CONFIG.targetTrades} trades`);
  
  // Open trades detail
  if (state.openTrades.length > 0) {
    console.log('\n  ── Open Trades ──');
    for (const t of state.openTrades) {
      const elapsed = ((Date.now() - t.entryTime) / 3600000).toFixed(1);
      const curPnl = (((state.lastEthPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(2);
      const remaining = Math.max(0, 2 - parseFloat(elapsed)).toFixed(1);
      console.log(`  → entry@${t.entryPrice.toFixed(2)} | ${elapsed}h ago | cur ${curPnl >= 0 ? '+' : ''}${curPnl}% | `
        + `MAE=${t.maxAdverse.toFixed(2)}% MFE=${t.maxFavorable.toFixed(2)}% | ${remaining}h remaining`);
    }
  }
  
  // Recent closed trades
  if (state.trades.length > 0) {
    console.log('\n  ── Recent Trades ──');
    const recent = state.trades.slice(-5).reverse();
    for (const t of recent) {
      const exitTs = new Date(t.exitTime).toISOString().slice(0, 16);
      console.log(`  ${exitTs} | ${t.realizedPnlPct >= 0 ? '+' : ''}${t.realizedPnlPct.toFixed(3)}% | `
        + `entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} | `
        + `MAE=${t.maxAdverse.toFixed(2)}% MFE=${t.maxFavorable.toFixed(2)}%`);
    }
    
    // Overall equity curve
    console.log('\n  ── Equity vs Initial ──');
    const pct = ((state.equity - 10000) / 10000 * 100).toFixed(2);
    console.log(`  Initial: $10,000 → Current: $${state.equity.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct}%)`);
  }
}

function main() {
  const state = loadState();
  if (!state) return;
  
  printReport(state);
  
  if (IS_WATCH) {
    const ms = 60 * 1000;
    setInterval(() => {
      const refreshed = loadState();
      if (refreshed) printReport(refreshed);
    }, ms);
  }
}

main();