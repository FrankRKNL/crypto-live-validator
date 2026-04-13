#!/usr/bin/env node
/**
 * ETH Drawdown Recovery — Daily Summary Report
 * 
 * Generates a compact daily report from logs/state for quick health assessment.
 * 
 * Usage:
 *   node eth-drawdown-daily-report.mjs              # Today's report
 *   node eth-drawdown-daily-report.mjs --date 2026-04-12   # Specific date
 *   node eth-drawdown-daily-report.mjs --all              # All days
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, 'logs', 'eth-drawdown');
const STATE_FILE = join(LOG_DIR, 'state.json');
const TRADES_FILE = join(LOG_DIR, 'trades.csv');
const DAILY_DIR = join(LOG_DIR, 'daily');
const REPORT_DIR = join(LOG_DIR, 'reports');

// ── Config ───────────────────────────────────────────────────────────────────
const TARGET_TRADES = 20;
const MIN_TRADES_FOR_ASSESSMENT = 5;
const BACKTEST_WIN_RATE = 66;     // %
const BACKTEST_AVG_PNL = 1.139;  // % per trade
const BACKTEST_AVG_MAE = -1.4;   // % max adverse
const BACKTEST_AVG_MFE = 2.77;   // % max favorable

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function loadJSON(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadCSV(file) {
  if (!existsSync(file)) return [];
  try {
    const content = readFileSync(file, 'utf8').trim();
    if (!content) return [];
    const lines = content.split('\n');
    const headers = lines[0].split(',');
    return lines.slice(1).map(line => {
      const vals = line.split(',');
      const row = {};
      headers.forEach((h, i) => row[h] = vals[i]);
      return row;
    });
  } catch { return []; }
}

function loadTrades() {
  return loadCSV(TRADES_FILE);
}

function loadState() {
  return loadJSON(STATE_FILE, null);
}

function loadDailySummaries() {
  const dir = DAILY_DIR;
  if (!existsSync(dir)) return {};
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const result = {};
  for (const file of files) {
    const date = file.replace('.json', '');
    result[date] = loadJSON(join(dir, file), {});
  }
  return result;
}

function calcStats(trades) {
  if (!trades || trades.length === 0) {
    return {
      count: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      avgDuration: 0,
      maxAdverse: 0,
      maxFavorable: 0,
      winRate: 0,
      avgPnlPerTrade: 0,
      avgMae: 0,
      avgMfe: 0,
    };
  }
  
  const realizedPnl = trades.reduce((s, t) => s + parseFloat(t.realizedPnlPct || 0), 0);
  const durations = trades.map(t => parseInt(t.durationMin || 0));
  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  const maeValues = trades.map(t => parseFloat(t.maxAdverse || 0));
  const mfeValues = trades.map(t => parseFloat(t.maxFavorable || 0));
  const avgMae = maeValues.reduce((a, b) => a + b, 0) / maeValues.length;
  const avgMfe = mfeValues.reduce((a, b) => a + b, 0) / mfeValues.length;
  const winners = trades.filter(t => parseFloat(t.realizedPnlPct || 0) > 0).length;
  const winRate = (winners / trades.length) * 100;
  const avgPnlPerTrade = realizedPnl / trades.length;
  
  return {
    count: trades.length,
    realizedPnl,
    avgDuration,
    maxAdverse: Math.min(...maeValues),
    maxFavorable: Math.max(...mfeValues),
    winRate,
    avgPnlPerTrade,
    avgMae,
    avgMfe,
  };
}

function assessStatus(stats, state, date) {
  const { count, winRate, avgPnlPerTrade, avgMae, avgMfe } = stats;
  
  // No trades yet
  if (count === 0) {
    return state?.totalSignals > 0 ? 'NO_SIGNALS' : 'NORMAL';
  }
  
  // Errors (would be logged separately)
  if (state?.errors?.length > 0) {
    return 'ERROR';
  }
  
  // Small sample
  if (count < MIN_TRADES_FOR_ASSESSMENT) {
    return 'NORMAL';
  }
  
  // Compare to backtest expectations
  const wrDeviation = Math.abs(winRate - BACKTEST_WIN_RATE);
  const maeDeviation = Math.abs(avgMae - BACKTEST_AVG_MAE);
  
  // WARNING if significantly off backtest
  if (wrDeviation > 20 || avgPnlPerTrade < 0) {
    return 'WARNING';
  }
  
  return 'NORMAL';
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ── Report Generation ───────────────────────────────────────────────────────────

function generateReport(date, state, trades) {
  const isToday = date === new Date().toISOString().slice(0, 10);
  const stats = calcStats(trades);
  
  // Unrealized PnL from open trades
  let unrealizedPnl = 0;
  if (state?.openTrades?.length > 0 && state?.lastEthPrice) {
    unrealizedPnl = state.openTrades.reduce((sum, t) => {
      const pnl = (state.lastEthPrice - t.entryPrice) / t.entryPrice * 100;
      return sum + pnl;
    }, 0);
  }
  
  const status = assessStatus(stats, state, date);
  const statusEmoji = { NORMAL: '✅', NO_SIGNALS: '🔭', WARNING: '⚠️', ERROR: '❌' }[status];
  
  // Compare to backtest
  const vsBacktest = stats.count > 0 ? {
    wrDiff: stats.winRate - BACKTEST_WIN_RATE,
    pnlDiff: stats.avgPnlPerTrade - BACKTEST_AVG_PNL,
    maeDiff: stats.avgMae - BACKTEST_AVG_MAE,
  } : null;
  
  return {
    date,
    generatedAt: new Date().toISOString(),
    validator: {
      equity: state?.equity || 10000,
      totalSignals: state?.totalSignals || 0,
      totalTrades: state?.totalTrades || 0,
      openTrades: state?.openTrades?.length || 0,
      closedTrades: stats.count,
    },
    today: {
      signals: state?.dailyStats?.[date]?.signals || 0,
      trades: state?.dailyStats?.[date]?.trades || 0,
      pnl: state?.dailyStats?.[date]?.pnl || 0,
    },
    performance: {
      realizedPnl: stats.realizedPnl,
      unrealizedPnl,
      avgDuration: stats.avgDuration,
      maxAdverse: stats.maxAdverse,
      maxFavorable: stats.maxFavorable,
      winRate: stats.winRate,
      avgPnlPerTrade: stats.avgPnlPerTrade,
    },
    backtestComparison: vsBacktest,
    status,
  };
}

function printReportTerminal(report) {
  const { date, validator, today, performance, backtestComparison, status } = report;
  const statusEmoji = { NORMAL: '✅', NO_SIGNALS: '🔭', WARNING: '⚠️', ERROR: '❌' }[status];
  
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║      ETH DRAWDOWN SHADOW — DAILY REPORT  ${date}            ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  
  // Equity & counts
  const equityStr = `$${validator.equity.toFixed(2)}`;
  console.log(`║  Equity:        ${equityStr.padStart(14)}                            ║`);
  console.log(`║  Signals:      ${String(validator.totalSignals).padStart(6)}  Open: ${String(validator.openTrades).padStart(3)}  Closed: ${String(validator.closedTrades).padStart(3)}     ║`);
  
  // Format PnL strings
  const todayPnlStr = (today.pnl >= 0 ? '+' : '') + today.pnl.toFixed(2) + '%';
  
  // Today's stats
  console.log('╠────────────────────────────────────────────────────────────────╣');
  console.log(`║  Today Signals:   ${String(today.signals).padStart(4)}                                  ║`);
  console.log(`║  Today Trades:   ${String(today.trades).padStart(4)}                                  ║`);
  console.log(`║  Today PnL:       ${todayPnlStr.padStart(12)}                            ║`);
  
  // Closed trades stats
  if (performance.count > 0) {
    const rpStr = (performance.realizedPnl >= 0 ? '+' : '') + performance.realizedPnl.toFixed(2) + '%';
    const upStr = (performance.unrealizedPnl >= 0 ? '+' : '') + performance.unrealizedPnl.toFixed(2) + '%';
    const apStr = (performance.avgPnlPerTrade >= 0 ? '+' : '') + performance.avgPnlPerTrade.toFixed(3) + '%';
    const mfStr = (performance.maxFavorable >= 0 ? '+' : '') + performance.maxFavorable.toFixed(2) + '%';
    
    console.log('╠────────────────────────────────────────────────────────────────╣');
    console.log(`║  ── Closed Trades Stats (${performance.count}) ──                        ║`);
    console.log(`║  Realized PnL:    ${rpStr.padStart(12)}                            ║`);
    console.log(`║  Unrealized PnL:  ${upStr.padStart(12)}                            ║`);
    console.log(`║  Win Rate:         ${performance.winRate.toFixed(1).padStart(6)}%                             ║`);
    console.log(`║  Avg PnL/trade:    ${apStr.padStart(12)}                            ║`);
    console.log(`║  Avg Duration:    ${formatDuration(performance.avgDuration).padStart(8)}                             ║`);
    console.log(`║  Max Adverse:      ${performance.maxAdverse.toFixed(2).padStart(8)}%                             ║`);
    console.log(`║  Max Favorable:    ${mfStr.padStart(12)}%                             ║`);
    
    // Backtest comparison
    if (backtestComparison) {
      const wrStr = (backtestComparison.wrDiff >= 0 ? '+' : '') + backtestComparison.wrDiff.toFixed(1) + '%';
      const pnlStr = (backtestComparison.pnlDiff >= 0 ? '+' : '') + backtestComparison.pnlDiff.toFixed(3) + '%';
      const maeStr = (backtestComparison.maeDiff >= 0 ? '+' : '') + backtestComparison.maeDiff.toFixed(2) + '%';
      console.log('╠────────────────────────────────────────────────────────────────╣');
      console.log(`║  ── vs Backtest (WR=${BACKTEST_WIN_RATE}%, PnL=+${BACKTEST_AVG_PNL}%, MAE=${BACKTEST_AVG_MAE}%) ──      ║`);
      console.log(`║  WR delta:    ${wrStr.padStart(8)}   PnL delta: ${pnlStr.padStart(8)}             ║`);
      console.log(`║  MAE delta:   ${maeStr.padStart(8)}                               ║`);
    }
  }
  
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  STATUS: ${statusEmoji} ${status.padStart(10)}                                    ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  // Validation progress
  const progress = Math.min(100, Math.round((validator.totalTrades / TARGET_TRADES) * 100));
  console.log(`\n  Validation progress: ${validator.totalTrades}/${TARGET_TRADES} trades (${progress}% of target)`);
  
  if (validator.totalTrades >= 10) {
    const wrNote = backtestComparison ? (backtestComparison.wrDiff >= 0 ? '+' : '') + backtestComparison.wrDiff.toFixed(1) + 'pp' : 'n/a';
    const pnlNote = backtestComparison ? (backtestComparison.pnlDiff >= 0 ? '+' : '') + backtestComparison.pnlDiff.toFixed(3) + '%' : 'n/a';
    console.log(`  → Live edge assessment available (n=${performance.count}) | WR ${wrNote} | PnL ${pnlNote}`);
  }
}

function saveReportJSON(report) {
  const dir = REPORT_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.date}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  log(`Report saved: ${file}`);
}

function saveReportCSV(report) {
  const dir = REPORT_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.date}.csv`);
  
  const header = 'date,equity,totalSignals,totalTrades,openTrades,closedTrades,todaySignals,todayTrades,todayPnl,realizedPnl,unrealizedPnl,winRate,avgPnlPerTrade,avgDurationMin,maxAdverse,maxFavorable,status';
  const row = [
    report.date,
    report.validator.equity.toFixed(2),
    report.validator.totalSignals,
    report.validator.totalTrades,
    report.validator.openTrades,
    report.performance.count,
    report.today.signals,
    report.today.trades,
    report.today.pnl.toFixed(4),
    report.performance.realizedPnl.toFixed(4),
    report.performance.unrealizedPnl.toFixed(4),
    report.performance.winRate.toFixed(2),
    report.performance.avgPnlPerTrade.toFixed(4),
    report.performance.avgDuration.toFixed(1),
    report.performance.maxAdverse.toFixed(4),
    report.performance.maxFavorable.toFixed(4),
    report.status,
  ].join(',');
  
  if (!existsSync(file)) {
    writeFileSync(file, header + '\n');
  }
  appendFileSync(file, row + '\n');
  log(`CSV saved: ${file}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv;
  const dateArg = args.find(a => a.startsWith('--date='));
  const showAll = args.includes('--all');
  
  const state = loadState();
  const allTrades = loadTrades();
  const dailySummaries = loadDailySummaries();
  
  if (showAll) {
    // Show all days with reports
    const dates = [...new Set([
      ...Object.keys(dailySummaries),
      ...allTrades.map(t => t.exitTime?.slice(0, 10) || t.timestamp?.slice(0, 10)),
      new Date().toISOString().slice(0, 10),
    ])].sort();
    
    console.log('\n📊 ETH Drawdown Shadow — All Days Summary');
    console.log('═'.repeat(70));
    
    for (const date of dates) {
      const dayTrades = allTrades.filter(t => 
        (t.exitTime?.slice(0, 10) === date) || (t.timestamp?.slice(0, 10) === date)
      );
      const report = generateReport(date, { ...state, dailyStats: { [date]: dailySummaries[date] } }, dayTrades);
      printReportTerminal(report);
      console.log('');
    }
    return;
  }
  
  // Default: today's report
  const today = dateArg ? dateArg.split('=')[1] : new Date().toISOString().slice(0, 10);
  
  // Filter trades for this date
  const dayTrades = allTrades.filter(t => 
    (t.exitTime?.slice(0, 10) === today) || (t.timestamp?.slice(0, 10) === today)
  );
  
  // Also get open trades from state
  const stateWithDate = { 
    ...state, 
    dailyStats: { [today]: dailySummaries[today] || {} } 
  };
  
  const report = generateReport(today, stateWithDate, dayTrades);
  printReportTerminal(report);
  
  // Save reports
  try {
    saveReportJSON(report);
    saveReportCSV(report);
  } catch (e) {
    log(`Warning: could not save report files: ${e.message}`);
  }
  
  // List recent reports
  const reportDir = REPORT_DIR;
  if (existsSync(reportDir)) {
    const files = readdirSync(reportDir).filter(f => f.endsWith('.json')).sort().slice(-7);
    if (files.length > 0) {
      console.log('\nRecent reports:');
      for (const f of files) {
        console.log(`  ${f}`);
      }
    }
  }
}

main().catch(e => log(`Error: ${e.message}`));
