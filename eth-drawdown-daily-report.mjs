#!/usr/bin/env node
/**
 * ETH Drawdown Recovery — Daily Summary Generator
 * 
 * Reads from logs/eth-drawdown/state.json
 * Outputs: terminal report + daily CSV + daily JSON
 * 
 * Usage:
 *   node eth-drawdown-daily-report.mjs          # single report
 *   node eth-drawdown-daily-report.mjs --watch   # continuous (1min)
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_BASE   = join(__dirname, 'logs', 'eth-drawdown');
const STATE_FILE = join(LOG_BASE, 'state.json');
const REPORTS_DIR = join(LOG_BASE, 'reports');
const IS_WATCH = process.argv.includes('--watch');

const CONFIG = {
  targetTrades: 20,
  backtestWR: 66,
  backtestNet: 1.139,
  backtestMAE: -1.4,
  backtestMFE: 3.9,
  backtestMedian: 0.730,
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) {
    console.log('No state file — run eth-drawdown-validator.mjs first');
    return null;
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── terminal report ──────────────────────────────────────────────────────────

function printReport(state) {
  const today = new Date().toISOString().slice(0, 10);
  const todayStats = state.dailyStats?.[today] || {};
  const progress = Math.min((state.totalTrades || 0) / CONFIG.targetTrades, 1);
  const bar = '█'.repeat(Math.floor(progress * 20)) + '░'.repeat(20 - Math.floor(progress * 20));
  
  const trades   = state.trades   || [];
  const openT    = state.openTrades || [];
  
  // Win rate + metrics
  let winRate = null, avgPnl = null, avgMae = null, avgMfe = null, medPnl = null;
  if (trades.length > 0) {
    const winners = trades.filter(t => t.realizedPnlPct > 0);
    winRate = (winners.length / trades.length * 100).toFixed(1);
    avgPnl  = (trades.reduce((s, t) => s + t.realizedPnlPct, 0) / trades.length).toFixed(3);
    medPnl  = [...trades].sort((a,b) => a.realizedPnlPct - b.realizedPnlPct)[Math.floor(trades.length/2)].realizedPnlPct.toFixed(3);
    avgMae  = (trades.reduce((s, t) => s + (t.maxAdverse || 0), 0) / trades.length).toFixed(3);
    avgMfe  = (trades.reduce((s, t) => s + (t.maxFavorable || 0), 0) / trades.length).toFixed(3);
  }
  
  // Status verdict
  let status = 'NORMAL';
  let verdict = '⏳ TOO EARLY';
  
  if (state.totalTrades >= 3) {
    const wrDiff  = winRate  ? Math.abs(parseFloat(winRate)  - CONFIG.backtestWR)  : 999;
    const pnlDiff = avgPnl   ? Math.abs(parseFloat(avgPnl)    - CONFIG.backtestNet)  : 999;
    if (wrDiff <= 12 && pnlDiff <= 0.8) {
      status  = 'NORMAL';
      verdict = '✅ IN LINE — strategy behaving as expected';
    } else if (wrDiff <= 20 && pnlDiff <= 1.5) {
      status  = 'WARNING';
      verdict = '⚠️ CAUTION — small divergence, monitor closely';
    } else {
      status  = 'WARNING';
      verdict = '❌ DIVERGENT — results deviate from backtest';
    }
  }
  
  if (state.lastError) {
    status = 'ERROR';
    verdict = '❌ ERROR — check logs: ' + state.lastError;
  }
  
  if (state.totalTrades === 0 && state.totalSignals === 0) {
    status  = 'NO SIGNALS';
    verdict = '📡 No signals detected yet — market may be in low-vol regime';
  }

  // Avg trade duration
  let avgDuration = null;
  if (trades.length > 0) {
    const totalMs = trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0);
    avgDuration = (totalMs / trades.length / 3600000).toFixed(2);
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   ETH DRAWDOWN RECOVERY — SHADOW VALIDATOR REPORT   ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Generated:   ${new Date().toISOString().slice(0,19).replace('T',' ')} UTC     ║`);
  console.log(`║  Status:      ${status.padStart(40)}║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Equity:        $${state.equity.toFixed(2).padStart(12)}              ║`);
  console.log(`║  Signals:       ${String(state.totalSignals || 0).padStart(4)}  (today: ${todayStats.signals || 0})         ║`);
  console.log(`║  Closed Trades:${String(trades.length).padStart(4)}  (today: ${todayStats.trades || 0})         ║`);
  console.log(`║  Open Trades:   ${String(openT.length).padStart(4)}                               ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Win Rate:      ${winRate  !== null ? winRate + '%'.padStart(9)  : '  --'.padStart(13)}                   ║`);
  console.log(`║  Avg PnL/trade: ${avgPnl   !== null ? avgPnl + '%'.padStart(10) : '  --'.padStart(14)}                  ║`);
  console.log(`║  Median PnL:    ${medPnl   !== null ? medPnl + '%'.padStart(10) : '  --'.padStart(14)}                  ║`);
  console.log(`║  Avg Duration:  ${avgDuration !== null ? avgDuration + 'h'.padStart(10) : '  --'.padStart(14)}                  ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Avg MAE:       ${avgMae !== null ? avgMae + '%'.padStart(10) : '  --'.padStart(14)}                  ║`);
  console.log(`║  Avg MFE:       ${avgMfe !== null ? avgMfe + '%'.padStart(10) : '  --'.padStart(14)}                  ║`);
  console.log(`║  Max MAE (all): ${state.maxAdverseExcursion != null ? state.maxAdverseExcursion.toFixed(2) + '%'.padStart(10) : '  --'.padStart(14)}                  ║`);
  console.log(`║  Max MFE (all): ${state.maxFavorableExcursion != null ? state.maxFavorableExcursion.toFixed(2) + '%'.padStart(10) : '  --'.padStart(14)}                  ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Backtest ref:  WR=${CONFIG.backtestWR}% | net=${CONFIG.backtestNet}% | MAE=${CONFIG.backtestMAE}%  ║`);
  console.log(`║  ${verdict.padStart(50)}    ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`\n  Progress: [${bar}] ${state.totalTrades || 0}/${CONFIG.targetTrades} trades`);

  // Open trades
  if (openT.length > 0) {
    console.log('\n  ── Open Trades ──');
    for (const t of openT) {
      const elapsed   = ((Date.now() - t.entryTime) / 3600000).toFixed(1);
      const curPnl    = (((state.lastEthPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(2);
      const remaining = Math.max(0, 2 - parseFloat(elapsed)).toFixed(1);
      console.log(`  → entry@${t.entryPrice.toFixed(2)} | ${elapsed}h ago | PnL ${curPnl >= 0 ? '+' : ''}${curPnl}% | `
        + `MAE=${(t.maxAdverse||0).toFixed(2)}% MFE=${(t.maxFavorable||0).toFixed(2)}% | ${remaining}h left`);
    }
  }

  // Recent closed trades
  if (trades.length > 0) {
    console.log('\n  ── Recent Closed Trades ──');
    const recent = trades.slice(-5).reverse();
    for (const t of recent) {
      const exitTs = new Date(t.exitTime).toISOString().slice(0,16).replace('T',' ');
      const dur    = ((t.exitTime - t.entryTime) / 3600000).toFixed(2);
      console.log(`  ${exitTs} | ${t.realizedPnlPct >= 0 ? '+' : ''}${t.realizedPnlPct.toFixed(3)}% | `
        + `entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} | `
        + `dur=${dur}h | MAE=${(t.maxAdverse||0).toFixed(2)}% MFE=${(t.maxFavorable||0).toFixed(2)}%`);
    }
    const pct = ((state.equity - 10000) / 10000 * 100).toFixed(2);
    console.log(`\n  ── Equity ──`);
    console.log(`  $10,000 → $${state.equity.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct}%)`);
  }

  // Errors
  if (state.lastError) {
    console.log(`\n  ⚠️  Last error: ${state.lastError}`);
  }
  
  return { status, trades, openT, winRate, avgPnl, medPnl, avgMae, avgMfe, avgDuration };
}

// ─── CSV output ───────────────────────────────────────────────────────────────

function writeCsv(state, reportData) {
  ensureDir(REPORTS_DIR);
  const today    = new Date().toISOString().slice(0, 10);
  const csvPath  = join(REPORTS_DIR, `summary-${today}.csv`);
  const trades   = state.trades || [];
  
  const header = 'timestamp,asset,position,entryPrice,exitPrice,realizedPct,realizedEUR,durationHours,maxAdverse,maxFavorable,exitReason,signalStrength';
  
  // Daily summary line (one per day)
  const dailyLine = [
    new Date().toISOString(),
    'ETH',
    trades.length > 0 ? 'CLOSED' : 'FLAT',
    '',
    '',
    trades.length > 0 ? (trades.reduce((s,t) => s + t.realizedPnlPct, 0) / trades.length).toFixed(4) : '0',
    state.equity - 10000,
    reportData?.avgDuration || '',
    state.maxAdverseExcursion || '',
    state.maxFavorableExcursion || '',
    '',
    state.totalSignals || 0
  ].join(',');

  // Trade lines (if any)
  let tradeLines = '';
  if (trades.length > 0) {
    const todayIso = today; // dynamic date
    const todayTrades = trades.filter(t => new Date(t.exitTime).toISOString().slice(0,10) === todayIso);
    tradeLines = '\n' + todayTrades.map(t => {
      return [
        new Date(t.exitTime).toISOString(),
        'ETH',
        'CLOSED',
        t.entryPrice.toFixed(4),
        t.exitPrice.toFixed(4),
        t.realizedPnlPct.toFixed(4),
        (t.realizedPnlEUR || 0).toFixed(2),
        ((t.exitTime - t.entryTime) / 3600000).toFixed(2),
        (t.maxAdverse || 0).toFixed(4),
        (t.maxFavorable || 0).toFixed(4),
        t.exitReason || '',
        t.signalStrength || ''
      ].join(',');
    }).join('\n');
  }

  const content = header + '\n' + dailyLine + tradeLines + '\n';
  appendFileSync(csvPath, content);
  console.log(`\n  📄 CSV: ${csvPath}`);
}

// ─── JSON output ──────────────────────────────────────────────────────────────

function writeJson(state, reportData) {
  ensureDir(REPORTS_DIR);
  const today   = new Date().toISOString().slice(0, 10);
  const jsonPath = join(REPORTS_DIR, `summary-${today}.json`);
  
  const trades  = state.trades || [];
  const openT   = state.openTrades || [];
  
  const report = {
    generatedAt: new Date().toISOString(),
    date: today,
    status: reportData?.status || 'UNKNOWN',
    equity: state.equity,
    equityChangePct: parseFloat(((state.equity - 10000) / 10000 * 100).toFixed(4)),
    totalSignals: state.totalSignals || 0,
    totalTrades: trades.length,
    openTrades: openT.length,
    winRate: reportData?.winRate ? parseFloat(reportData.winRate) : null,
    avgPnlPct: reportData?.avgPnl ? parseFloat(reportData.avgPnl) : null,
    medianPnlPct: reportData?.medPnl ? parseFloat(reportData.medPnl) : null,
    avgDurationHours: reportData?.avgDuration ? parseFloat(reportData.avgDuration) : null,
    avgMae: reportData?.avgMae ? parseFloat(reportData.avgMae) : null,
    avgMfe: reportData?.avgMfe ? parseFloat(reportData.avgMfe) : null,
    maxAdverseExcursion: state.maxAdverseExcursion || null,
    maxFavorableExcursion: state.maxFavorableExcursion || null,
    lastError: state.lastError || null,
    lastEthPrice: state.lastEthPrice || null,
    lastBtcPrice: state.lastBtcPrice || null,
    backtestRef: CONFIG,
    trades: trades.map(t => ({
      entryTime: new Date(t.entryTime).toISOString(),
      exitTime:  new Date(t.exitTime).toISOString(),
      entryPrice: t.entryPrice,
      exitPrice:  t.exitPrice,
      realizedPnlPct: parseFloat(t.realizedPnlPct.toFixed(4)),
      realizedPnlEUR: t.realizedPnlEUR || 0,
      durationHours: parseFloat(((t.exitTime - t.entryTime) / 3600000).toFixed(2)),
      maxAdverse: parseFloat((t.maxAdverse || 0).toFixed(4)),
      maxFavorable: parseFloat((t.maxFavorable || 0).toFixed(4)),
      exitReason: t.exitReason || '',
      signalStrength: t.signalStrength || null,
    })),
    openTrades: openT.map(t => ({
      entryTime: new Date(t.entryTime).toISOString(),
      entryPrice: t.entryPrice,
      currentAgeHours: parseFloat(((Date.now() - t.entryTime) / 3600000).toFixed(2)),
      currentPnlPct: parseFloat((((state.lastEthPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(4)),
      maxAdverse: parseFloat((t.maxAdverse || 0).toFixed(4)),
      maxFavorable: parseFloat((t.maxFavorable || 0).toFixed(4)),
    })),
  };

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`  📋 JSON: ${jsonPath}`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

function main() {
  const state = loadState();
  if (!state) return;

  const reportData = printReport(state);
  writeCsv(state, reportData);
  writeJson(state, reportData);

  if (IS_WATCH) {
    setInterval(() => {
      const refreshed = loadState();
      if (refreshed) {
        console.log('\n\n--- refresh ' + new Date().toISOString().slice(11,19) + ' ---');
        printReport(refreshed);
      }
    }, 60 * 1000);
  }
}

main();