#!/usr/bin/env node
/**
 * ETH Drawdown Recovery - Shadow Validator
 *
 * Strategy (from FALSIFICATION-REPORT):
 * - Entry: ETH drawdown >= 3% in 4 consecutive 1h candles, last candle RED
 * - Filters: ATR 4h > 1.0%, BTC trend <= -2% in last 4h
 * - Exit: Exactly 2h after entry (no SL/TP/trailing)
 *
 * Usage:
 *   node eth-drawdown-validator.mjs              # One-shot
 *   node eth-drawdown-validator.mjs --watch     # Live polling (every 15 min)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, 'logs', 'eth-drawdown');
const STATE_FILE = join(LOG_DIR, 'state.json');
const TRADES_FILE = join(LOG_DIR, 'trades.csv');
const DAILY_DIR = join(LOG_DIR, 'daily');

const IS_WATCH = process.argv.includes('--watch');
const POLL_MIN = parseInt(process.argv.find(a => a.startsWith('--interval'))?.split('=')[1] || '15');

// ── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  minDrawdown: 0.03,      // 3% ETH drawdown
  lookbackCandles: 4,     // 4 consecutive candles
  minATR: 0.8,           // ATR must be > 0.8% (Frank spec: tussen 0.8% en 2.0%)
  maxATR: 2.0,            // ATR cap at 2.0%
  btcTrendMax: -0.02,     // BTC must be down >= 2% in last 4h
  holdHours: 2,           // Exit exactly 2h after entry
  feePct: 0.10,           // 10 bps per trade (entry+exit)
  slippagePct: 0.05,      // 5 bps simulated slippage
  initialCapital: 10000,
  maxAdversePct: -0.03,   // -3% max adverse for reporting
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
}

function loadJSON(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveJSON(file, data) {
  mkdirp(dirname(file));
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadState() {
  return loadJSON(STATE_FILE, {
    equity: CONFIG.initialCapital,
    trades: [],
    openTrades: [],
    dailyStats: {},
    lastRun: null,
    totalSignals: 0,
    totalTrades: 0,
  });
}

function saveState(state) {
  saveJSON(STATE_FILE, state);
}

function appendTradeToCSV(trade) {
  const header = 'timestamp,entryTime,exitTime,symbol,entryPrice,exitPrice,atrPct,btcTrendPct,drawdownPct,maxAdverse,maxFavorable,realizedPnlPct,feePct,slippagePct,exitReason,durationMin';
  const row = [
    new Date().toISOString(),
    new Date(trade.entryTime).toISOString(),
    new Date(trade.exitTime).toISOString(),
    'ETHUSDT',
    trade.entryPrice.toFixed(4),
    trade.exitPrice.toFixed(4),
    trade.atrPct.toFixed(4),
    trade.btcTrendPct.toFixed(4),
    trade.drawdownPct.toFixed(4),
    trade.maxAdverse.toFixed(4),
    trade.maxFavorable.toFixed(4),
    trade.realizedPnlPct.toFixed(4),
    CONFIG.feePct.toFixed(4),
    CONFIG.slippagePct.toFixed(4),
    trade.exitReason || 'TIMEOUT',
    trade.durationMin,
  ].join(',');

  if (!existsSync(TRADES_FILE)) {
    appendFileSync(TRADES_FILE, header + '\n');
  }
  appendFileSync(TRADES_FILE, row + '\n');
}

function saveDailySummary(date, stats) {
  mkdirp(DAILY_DIR);
  const file = join(DAILY_DIR, `${date}.json`);
  const existing = loadJSON(file, {});
  const merged = { ...existing, ...stats, updatedAt: new Date().toISOString() };
  saveJSON(file, merged);
}

// ── ATR Calculation ────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval = '1h', limit = 500) {
  const pair = symbol === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${r.status}`);
  const data = await r.json();
  // Binance kline: [0]opentime,[1]open,[2]high,[3]low,[4]close,[5]volume,[6]closetime,[7]quote
  return data.map(k => ({
    time: new Date(k[0]).getTime(),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trueRanges.push(tr);
  }
  const atr = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  const price = candles.at(-1).close;
  return (atr / price) * 100; // as percentage
}

function calcBTCTrend(candles, lookback = 4) {
  if (candles.length < lookback) return 0;
  const start = candles.slice(-lookback)[0];
  const end = candles.at(-1);
  return (end.close - start.open) / start.open;
}

// ── Strategy Signal Detection ───────────────────────────────────────────────────

function checkDrawdownSignal(ethCandles, btcCandles) {
  if (ethCandles.length < CONFIG.lookbackCandles + 1) return null;

  // Get last N candles
  const window = ethCandles.slice(-CONFIG.lookbackCandles);
  const entryCandle = ethCandles.at(-1); // entry is AFTER the drawdown event
  const prevCandle = ethCandles.at(-2);

  // 1. Check drawdown: from open of first candle to low of last candle in window
  const windowStartOpen = window[0].open;
  const windowLow = Math.min(...window.map(c => c.low));
  const drawdownPct = (windowStartOpen - windowLow) / windowStartOpen;

  if (drawdownPct < CONFIG.minDrawdown) return null;

  // 2. Last candle must be RED (close < open)
  const lastCandle = window.at(-1);
  if (lastCandle.close >= lastCandle.open) return null;

  // 3. ATR filter (4h = 4 candles of 1h)
  const atr = calcATR(ethCandles.slice(-20)); // 20 candles for stable ATR
  if (atr === null || atr < CONFIG.minATR || atr > CONFIG.maxATR) {
    return { filtered: 'ATR', atr };
  }

  // 4. BTC trend filter
  const btcTrend = calcBTCTrend(btcCandles, 4); // 4h lookback
  if (btcTrend > CONFIG.btcTrendMax) {
    return { filtered: 'BTC', btcTrend };
  }

  // Signal! Entry price is the close of the "entry candle" (the candle AFTER the drawdown window)
  // But since we check at the close of entryCandle, we simulate entry at entryCandle.close
  const entryPrice = entryCandle.close;
  const entryTime = entryCandle.time;

  return {
    signal: true,
    entryPrice,
    entryTime,
    drawdownPct,
    atr,
    btcTrend,
    ethPrice: entryCandle.close,
    btcPrice: btcCandles.at(-1).close,
  };
}

// ── Shadow Trading Engine ─────────────────────────────────────────────────────

async function runRound() {
  const state = loadState();

  log('Fetching candles...');
  const [ethCandles, btcCandles] = await Promise.all([
    fetchCandles('ETH', '1h', 500),
    fetchCandles('BTC', '1h', 500),
  ]);

  const now = Date.now();
  const curEth = ethCandles.at(-1);
  const curBtc = btcCandles.at(-1);

  log(`ETH=${curEth.close.toFixed(2)} | BTC=${curBtc.close.toFixed(2)}`);

  // Check for exit of open trades
  const closedTrades = [];
  state.openTrades = state.openTrades.filter(trade => {
    const elapsedHours = (curEth.time - trade.entryTime) / 3600000;

    if (elapsedHours >= CONFIG.holdHours) {
      // Exit!
      const exitPrice = curEth.close;
      const grossPnl = (exitPrice - trade.entryPrice) / trade.entryPrice;
      const netPnl = grossPnl - CONFIG.feePct / 100 - CONFIG.slippagePct / 100;
      const maxAdverse = trade.maxAdverse || 0;
      const maxFavorable = trade.maxFavorable || 0;

      const completedTrade = {
        ...trade,
        exitPrice,
        exitTime: curEth.time,
        realizedPnlPct: netPnl * 100,
        grossPnlPct: grossPnl * 100,
        maxAdverse,
        maxFavorable,
        exitReason: 'TIMEOUT',
        durationMin: Math.round(elapsedHours * 60),
        atrPct: trade.atrPct,
        btcTrendPct: trade.btcTrendPct,
        drawdownPct: trade.drawdownPct,
      };

      state.equity *= (1 + netPnl);
      completedTrade.realizedPnlEUR = state.equity - CONFIG.initialCapital;
      state.trades.push(completedTrade);
      closedTrades.push(completedTrade);
      appendTradeToCSV(completedTrade);
      state.totalTrades++;

      // Update global max adverse/favorable excursion
      if (state.maxAdverseExcursion === null || state.maxAdverseExcursion === undefined) {
        state.maxAdverseExcursion = completedTrade.maxAdverse;
        state.maxFavorableExcursion = completedTrade.maxFavorable;
      } else {
        state.maxAdverseExcursion = Math.min(state.maxAdverseExcursion, completedTrade.maxAdverse);
        state.maxFavorableExcursion = Math.max(state.maxFavorableExcursion, completedTrade.maxFavorable);
      }

      log(`[EXIT] ${(netPnl * 100) >= 0 ? '+' : ''}${(netPnl * 100).toFixed(2)}% | `
        + `entry=${trade.entryPrice.toFixed(2)} exit=${exitPrice.toFixed(2)} | `
        + `MFE=${maxFavorable.toFixed(2)}% MAE=${maxAdverse.toFixed(2)}% | `
        + `equity=$${state.equity.toFixed(2)}`);

      return false; // remove from open
    }

    // Update MFE/MAE
    const curPnl = (curEth.close - trade.entryPrice) / trade.entryPrice;
    const adverse = Math.min(trade.maxAdverse || 0, curPnl);
    const favorable = Math.max(trade.maxFavorable || 0, curPnl);
    trade.maxAdverse = adverse;
    trade.maxFavorable = favorable;

    // Also track the lowest price during the trade for MAE
    if (!trade.minLow || curEth.low < trade.minLow) {
      trade.minLow = curEth.low;
    }

    const remainingMin = Math.round((CONFIG.holdHours * 60) - (elapsedHours * 60));
    return true; // keep open
  });

  // Check for new signal (only if no open trades)
  if (state.openTrades.length === 0) {
    const sig = checkDrawdownSignal(ethCandles, btcCandles);

    if (sig && sig.signal) {
      // Open new shadow trade
      const shadowTrade = {
        id: `${Date.now()}`,
        entryPrice: sig.entryPrice,
        entryTime: sig.entryTime,
        ethPrice: sig.ethPrice,
        btcPrice: sig.btcPrice,
        atrPct: sig.atr,
        btcTrendPct: sig.btcTrend,
        drawdownPct: sig.drawdownPct,
        maxAdverse: 0,
        maxFavorable: 0,
        minLow: sig.entryPrice,
      };

      state.openTrades.push(shadowTrade);
      state.totalSignals++;

      log(`[SIGNAL] DRAWDOWN detected! drawdown=${(sig.drawdownPct * 100).toFixed(1)}% | `
        + `ATR=${sig.atr.toFixed(2)}% | BTC=${(sig.btcTrend * 100).toFixed(1)}% | `
        + `entry@${sig.entryPrice.toFixed(2)}`);
    } else if (sig && sig.filtered) {
      // Signal was filtered
      if (Math.random() < 0.02) { // log filtered signals ~2% of the time (too noisy otherwise)
        log(`[FILTERED] ${sig.filtered} | drawdown=${((sig.drawdownPct || 0) * 100).toFixed(1)}% | atr=${(sig.atr || 0).toFixed(2)}% | btc=${((sig.btcTrend || 0) * 100).toFixed(1)}%`);
      }
    }
  }

  // Update state
  state.lastRun = new Date().toISOString();
  state.lastEthPrice = curEth.close;
  state.lastBtcPrice = curBtc.close;

  // Persist global max adverse/favorable excursion
  if (state.trades.length > 0) {
    state.maxAdverseExcursion = Math.min(...state.trades.map(t => t.maxAdverse || 0));
    state.maxFavorableExcursion = Math.max(...state.trades.map(t => t.maxFavorable || 0));
  }

  saveState(state);

  // Daily summary
  const today = new Date().toISOString().slice(0, 10);
  const closedToday = closedTrades.length;
  const dailyStats = state.dailyStats[today] || { signals: 0, trades: 0, pnl: 0 };
  // Only count new signals, not closed trades
  // signals are counted at detection time in the signal block above
  dailyStats.trades = (dailyStats.trades || 0) + closedToday;
  dailyStats.pnl = (dailyStats.pnl || 0) + closedTrades.reduce((s, t) => s + t.realizedPnlPct, 0);
  dailyStats.equity = state.equity;
  dailyStats.openTrades = state.openTrades.length;
  state.dailyStats[today] = dailyStats;
  saveState(state);

  // Daily summary log
  if (closedToday > 0 || state.openTrades.length > 0) {
    const openPnl = state.openTrades.reduce((s, t) => {
      const curPnl = (curEth.close - t.entryPrice) / t.entryPrice;
      return s + curPnl;
    }, 0) / Math.max(state.openTrades.length, 1);

    log(`[SUMMARY] ${today} | signals=${state.totalSignals} | trades=${state.totalTrades} | `
      + `open=${state.openTrades.length} | equity=$${state.equity.toFixed(2)} | todayPnl=${closedTrades.reduce((s, t) => s + t.realizedPnlPct, 0).toFixed(2)}%`);
  }

  return { state, closedTrades, ethCandles, btcCandles };
}

// ── Status Report ─────────────────────────────────────────────────────────────

async function printReport() {
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  const todayStats = state.dailyStats[today] || {};

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   ETH DRAWDOWN RECOVERY - SHADOW VALIDATOR    ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Equity:        $${state.equity.toFixed(2).padStart(12)}         ║`);
  console.log(`║  Total Signals: ${String(state.totalSignals).padStart(4)}                           ║`);
  console.log(`║  Total Trades:  ${String(state.totalTrades).padStart(4)}                           ║`);
  console.log(`║  Open Trades:   ${String(state.openTrades.length).padStart(4)}                           ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Today Signals:  ${String(todayStats.signals || 0).padStart(4)}                           ║`);
  console.log(`║  Today Trades:  ${String(todayStats.trades || 0).padStart(4)}                           ║`);
  console.log(`║  Today PnL:      ${String((todayStats.pnl || 0).toFixed(2) + '%').padStart(13)}         ║`);
  console.log(`║  Last Run:      ${(state.lastRun || 'never').slice(11, 19).padStart(8)}                       ║`);
  console.log('╚══════════════════════════════════════════════╝');

  if (state.openTrades.length > 0) {
    console.log('\n── Open Trades ──');
    for (const t of state.openTrades) {
      const elapsed = (Date.now() - t.entryTime) / 3600000;
      const curPnl = ((state.lastEthPrice - t.entryPrice) / t.entryPrice) * 100;
      const remaining = Math.max(0, CONFIG.holdHours - elapsed);
      console.log(`  ID=${t.id.slice(-6)} entry@${t.entryPrice.toFixed(2)} `
        + `MFE=${t.maxFavorable.toFixed(2)}% MAE=${t.maxAdverse.toFixed(2)}% `
        + `elapsed=${elapsed.toFixed(1)}h remaining=${remaining.toFixed(1)}h curPnL=${curPnl >= 0 ? '+' : ''}${curPnl.toFixed(2)}%`);
    }
  }

  // Recent trades
  if (state.trades.length > 0) {
    console.log('\n── Recent Trades ──');
    const recent = state.trades.slice(-5);
    for (const t of recent) {
      console.log(`  ${new Date(t.exitTime).toISOString().slice(0,16)} | `
        + `${t.realizedPnlPct >= 0 ? '+' : ''}${t.realizedPnlPct.toFixed(2)}% | `
        + `entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} | `
        + `MAE=${t.maxAdverse.toFixed(2)}% MFE=${t.maxFavorable.toFixed(2)}%`);
    }
  }

  // Stop criterion check
  console.log(`\n── Validation Progress: ${state.totalTrades}/20 target trades ──`);
  if (state.totalTrades >= 10) {
    const winners = state.trades.filter(t => t.realizedPnlPct > 0);
    const winRate = (winners.length / state.totalTrades * 100).toFixed(1);
    const avgPnl = (state.trades.reduce((s, t) => s + t.realizedPnlPct, 0) / state.totalTrades).toFixed(2);
    const avgMae = (state.trades.reduce((s, t) => s + t.maxAdverse, 0) / state.totalTrades).toFixed(2);
    console.log(`  Win rate: ${winRate}% | Avg PnL: ${avgPnl}% | Avg MAE: ${avgMae}%`);
    console.log(`  → Compare with backtest: WR=66%, net=+1.139%, MAE~-1.4%`);
  }
}

// ── Watch Mode ────────────────────────────────────────────────────────────────

async function watch() {
  log(`Starting ETH Drawdown Shadow Validator in WATCH mode (poll every ${POLL_MIN} min)`);
  await runRound();
  await printReport();

  const ms = POLL_MIN * 60 * 1000;
  setInterval(async () => {
    try {
      log('───');
      await runRound();
      await printReport();
    } catch (e) {
      log(`ERROR: ${e.message}`);
    }
  }, ms);
}

// ── Entry Point ────────────────────────────────────────────────────────────────

if (IS_WATCH) {
  watch();
} else {
  runRound()
    .then(() => printReport())
    .catch(e => log(`Fatal: ${e.message}`));
}
