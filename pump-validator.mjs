#!/usr/bin/env node
/**
 * RO15 Live Validator — Paper Trading
 * Trail: 15% | Re-entry: 10d | Assets: BTC, ETH | Interval: 1h
 * 
 * Usage:
 *   node pump-validator.mjs                    # One-shot backtest (last 200 candles)
 *   node pump-validator.mjs --watch           # Live polling every 60 min
 *   node pump-validator.mjs --watch --interval 30  # Custom interval in minutes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, 'logs');
const STATE_FILE = join(__dirname, 'logs/state.json');
const ASSET_STATE_DIR = join(__dirname, 'logs/assets');

const ASSETS = ['BTC', 'ETH'];
const INTERVAL_MIN = parseInt(process.argv.find(a => a.startsWith('--interval'))?.split('=')[1] || '60');
const IS_WATCH = process.argv.includes('--watch');

const TRAIL_PCT = 0.15;
const REENTRY_DAYS = 10;
const MAX_CANDLES = 200;

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadAssetState(symbol) {
  const f = join(ASSET_STATE_DIR, `${symbol}-state.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

function saveAssetState(symbol, s) {
  mkdirSync(ASSET_STATE_DIR, { recursive: true });
  writeFileSync(join(ASSET_STATE_DIR, `${symbol}-state.json`), JSON.stringify(s, null, 2));
}

async function fetchCandles(symbol, interval = '1h', limit = MAX_CANDLES) {
  const pair = symbol === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance API ${r.status}`);
  const data = await r.json();
  return data.map(([o, h, l, c, , , , v]) => ({
    time: new Date(o).getTime(),
    open: parseFloat(o), high: parseFloat(h), low: parseFloat(l),
    close: parseFloat(c), volume: parseFloat(v)
  }));
}

function calcEquity(state, candles) {
  if (!state.position || !state.entryPrice || !candles.length) {
    return { equity: state.equity || 10000, closeNet: 0 };
  }
  const price = candles.at(-1).close;
  const closeNet = ((price - state.entryPrice) / state.entryPrice) * 100;
  const equity = state.equity * (1 + closeNet / 100);
  return { equity, closeNet };
}

// ── Core Strategy ─────────────────────────────────────────────────────────────

function checkSignal(candles, state) {
  if (!candles || candles.length < 2) return null;
  const cur = candles.at(-1);
  const prev = candles.at(-2);

  // Signal: pump > 0.8% in prev candle, follow-through in cur
  const pump = ((prev.close - prev.open) / prev.open) * 100;
  const followThrough = ((cur.close - prev.close) / prev.close) * 100;
  
  if (pump > 0.8 && followThrough > 0.3) {
    return { type: 'LONG', entryPrice: cur.close, entryTime: cur.time, pump, followThrough };
  }
  return null;
}

function shouldEnter(signal, state, candles) {
  if (!signal) return false;
  if (state.position) return false;
  // No recent exit
  if (state.lastExitTime) {
    const daysSince = (candles.at(-1).time - state.lastExitTime) / 86400000;
    if (daysSince < REENTRY_DAYS) return false;
  }
  return true;
}

function shouldTrailStop(state, cur) {
  if (!state.position || !state.peakPrice) return false;
  const drawdown = (state.peakPrice - cur.close) / state.peakPrice;
  const ageHours = (cur.time - state.entryTime) / 3600000;
  
  if (ageHours <= 2) {
    // Stop loss: -5% hard stop in first 2 hours
    if (drawdown >= 0.05) return 'STOP_LOSS';
  }
  
  // Trailing stop: 15% from peak
  if (drawdown >= TRAIL_PCT) return 'TRAIL_STOP';
  return null;
}

// ── Paper Trading Engine ───────────────────────────────────────────────────────

async function runRound(symbol) {
  const candles = await fetchCandles(symbol);
  let state = loadAssetState(symbol);
  
  // Init
  if (!state) {
    state = { equity: 10000, position: null, entryPrice: null, peakPrice: null, entryTime: null, lastExitTime: null, trades: [] };
  }

  const signal = checkSignal(candles);
  const cur = candles.at(-1);
  
  // Check exit first
  if (state.position) {
    const stopType = shouldTrailStop(state, cur);
    if (stopType) {
      const pnl = state.position === 'LONG' 
        ? ((cur.close - state.entryPrice) / state.entryPrice) * 100
        : 0;
      state.trades.push({ symbol, entryPrice: state.entryPrice, exitPrice: cur.close, pnl, exitType: stopType, exitTime: cur.time });
      state.lastExitTime = cur.time;
      state.position = null;
      state.entryPrice = null;
      state.peakPrice = null;
      state.entryTime = null;
      log(`[${symbol}] EXIT ${stopType} @ ${cur.close.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%)`);
    } else {
      // Update peak
      if (cur.close > state.peakPrice) state.peakPrice = cur.close;
    }
  }

  // Check entry
  if (!state.position && shouldEnter(signal, state, candles)) {
    state.position = 'LONG';
    state.entryPrice = cur.close;
    state.peakPrice = cur.close;
    state.entryTime = cur.time;
    log(`[${symbol}] ENTRY @ ${cur.close.toFixed(2)} (pump=${signal.pump.toFixed(2)}%, ft=${signal.followThrough.toFixed(2)}%)`);
  }

  const { equity, closeNet } = calcEquity(state, candles);
  state.equity = equity;
  saveAssetState(symbol, state);
  
  const pos = state.position ? `${state.position} @ ${state.entryPrice?.toFixed(2)}` : 'FLAT';
  const peak = state.peakPrice ? `peak=${state.peakPrice.toFixed(2)}` : '';
  log(`[${symbol}] price=${cur.close.toFixed(2)} | ${pos} | ${peak} | equity=$=${equity.toFixed(2)} (${closeNet >= 0 ? '+' : ''}${closeNet.toFixed(2)}%)`);

  return { symbol, equity, closeNet, position: state.position, state };
}

async function runAll() {
  log(`=== RO15 Validator (trail=${TRAIL_PCT*100}%, reentry=${REENTRY_DAYS}d) ===`);
  
  const results = [];
  for (const sym of ASSETS) {
    try {
      const r = await runRound(sym);
      results.push(r);
    } catch (e) {
      log(`[${sym}] ERROR: ${e.message}`);
    }
  }

  const totalEquity = results.reduce((s, r) => s + (r?.equity || 0), 0);
  const weights = results.map(r => ({ sym: r.symbol, w: ((r.equity / totalEquity) * 100).toFixed(1) }));
  
  log(`--- PORTFOLIO: $${totalEquity.toFixed(2)} | ${weights.map(w => `${w.sym}=${w.w}%`).join(' | ')} ---`);
  
  // Save combined state
  const s = loadState();
  s.lastRun = new Date().toISOString();
  s.totalEquity = totalEquity;
  s.assets = {};
  results.forEach(r => { if (r) s.assets[r.symbol] = { equity: r.equity, closeNet: r.closeNet, position: r.position }; });
  saveState(s);
  
  return { totalEquity, results };
}

// ── Watch Mode ────────────────────────────────────────────────────────────────

async function watch() {
  log(`Starting watch mode (poll every ${INTERVAL_MIN} min)...`);
  await runAll();
  
  const ms = INTERVAL_MIN * 60 * 1000;
  setInterval(async () => {
    try {
      log('---');
      await runAll();
    } catch (e) {
      log(`Watch error: ${e.message}`);
    }
  }, ms);
}

// ── Entry Point ───────────────────────────────────────────────────────────────

if (IS_WATCH) {
  watch();
} else {
  runAll().catch(e => log(`Fatal: ${e.message}`));
}
