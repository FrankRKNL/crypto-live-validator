#!/usr/bin/env node
/**
 * RO15 Live Shadow-Mode Validator (Production)
 * 
 * Strategy (exact research spec):
 * - Always IN position at start
 * - Track peak price since entry
 * - Exit: price < peak * (1 - 0.15) = peak * 0.85 (15% trailing stop)
 * - Re-entry: price > 10-day high (after exit)
 * - Fee: 0.15% | Slippage: 0%
 * - Signals ONLY evaluated at daily candle closes
 * 
 * Polling: hourly, but signals only on daily closes (no intraday pseudo-signals)
 * Mode: SHADOW ONLY — no real orders, only signals + logging
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR   = path.join(__dirname, 'logs');
const STATE_PATH    = path.join(LOG_DIR, 'state.json');
const DAILY_DIR     = path.join(LOG_DIR, 'daily');
const ALERTS_DIR    = path.join(LOG_DIR, 'alerts');
const ASSET_LOG_DIR = path.join(LOG_DIR, 'assets');

// ─────────────────────────────────────────────────────────────
// Configuration (RESEARCH-SPEC VERIFIED)
// ─────────────────────────────────────────────────────────────

const CONFIG = {
  assets: ['BTC', 'ETH'],
  
  // RO15 Research Spec (DO NOT CHANGE without research re-validation)
  trailPct:       0.15,       // 15% trailing stop
  reentryLookback: 10,       // 10 trading days for re-entry high
  feePct:         0.15,      // 0.15% fee (research spec)
  slippagePct:    0,         // 0% slippage (research spec)
  
  // Runtime
  pollIntervalMs: 60 * 60 * 1000,   // 1 hour between polls
  dailyCloseHour: 23,       // UTC hour when daily candle closes (Binance closes at 00:00 UTC)
  
  // Paper capital (per asset, independent)
  initialCapital: 10000,   // EUR paper money per asset
  
  // Data
  lookbackDays: 30,         // Fetch 30 days of 1h candles for daily aggregation
  
  // Paths (relative to script dir)
  logDir: LOG_DIR,
  statePath: STATE_PATH,
};

for (const d of [LOG_DIR, DAILY_DIR, ALERTS_DIR, ASSET_LOG_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ─────────────────────────────────────────────────────────────
// Logging Utilities
// ─────────────────────────────────────────────────────────────

const PAD = 22;
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.padEnd(5)}] ${msg}`;
  console.log(line);
  fs.appendFileSync(
    path.join(LOG_DIR, `validator-${new Date().toISOString().slice(0,10)}.log`),
    line + '\n'
  );
}

function logAlert(asset, event, details) {
  const alertLine = `[${new Date().toISOString()}] [ALERT] ${asset}: ${event} — ${details}`;
  console.log(alertLine);
  const alertFile = path.join(ALERTS_DIR, `${asset}-alerts.log`);
  fs.appendFileSync(alertFile, alertLine + '\n');
}

// ─────────────────────────────────────────────────────────────
// API Client
// ─────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} on ${url}`));
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`JSON parse error: ${e.message} | Data: ${data.slice(0,200)}`)); }
      });
    }).on('error', e => reject(new Error(`Network error: ${e.message}`)));
  });
}

/**
 * Fetch 1h klines and aggregate to daily candles.
 * Binance 1h kline openTime is the start of the interval.
 * A "daily candle" closes at 00:00 UTC the next day.
 */
async function fetchDailyCandles(symbol, days = 30) {
  const limit = Math.min(days * 24 + 2, 500);  // Binance max 500
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=${limit}`;
  
  let raw;
  try {
    raw = await fetchJSON(url);
  } catch(e) {
    throw new Error(`Failed to fetch ${symbol}: ${e.message}`);
  }
  
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Empty response for ${symbol}`);
  }
  
  // Aggregate 1h candles into daily (UTC days)
  // Binance kline: [openTime, open, high, low, close, volume, closeTime, ...]
  const dailyMap = new Map();
  
  for (const k of raw) {
    const openTime  = Number(k[0]);
    const open      = parseFloat(k[1]);
    const high      = parseFloat(k[2]);
    const low       = parseFloat(k[3]);
    const close     = parseFloat(k[4]);
    const volume    = parseFloat(k[5]);
    
    // UTC day key: midnight UTC of the day this hour belongs to
    const d = new Date(openTime);
    const dayKey = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
    
    if (!dailyMap.has(dayKey)) {
      dailyMap.set(dayKey, {
        date: new Date(dayKey * 1000).toISOString().slice(0,10),  // YYYY-MM-DD
        open,
        high,
        low,
        close,
        volume,
        trades: 1,
      });
    } else {
      const existing = dailyMap.get(dayKey);
      existing.high   = Math.max(existing.high, high);
      existing.low    = Math.min(existing.low, low);
      existing.close = close;       // last close of the day
      existing.volume += volume;
      existing.trades++;
    }
  }
  
  const daily = Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date));
  
  log(`  ${symbol}: ${daily.length} daily candles (${daily[0]?.date} -> ${daily[daily.length-1]?.date})`);
  return daily;
}

// ─────────────────────────────────────────────────────────────
// State Persistence
// ─────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf8');
      const state = JSON.parse(raw);
      log(`State loaded from ${STATE_PATH}`);
      return state;
    }
  } catch (e) {
    log(`State load error: ${e.message}`, 'WARN');
  }
  return null;
}

function saveState(state) {
  try {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) {
    log(`State save error: ${e.message}`, 'ERROR');
  }
}

// Per-asset state snapshot (restart-safe)
function loadAssetState(asset) {
  const p = path.join(ASSET_LOG_DIR, `${asset}-state.json`);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(e) {}
  return null;
}

function saveAssetState(asset, state) {
  const p = path.join(ASSET_LOG_DIR, `${asset}-state.json`);
  try {
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
  } catch (e) {
    log(`Asset state save error (${asset}): ${e.message}`, 'ERROR');
  }
}

// ─────────────────────────────────────────────────────────────
// RO15 Strategy Engine (RESEARCH SPEC EXACT)
// ─────────────────────────────────────────────────────────────

class RO15Strategy {
  constructor(asset, config = {}) {
    this.asset = asset;
    this.trailPct      = config.trailPct      ?? CONFIG.trailPct;
    this.reentryLookback = config.reentryLookback ?? CONFIG.reentryLookback;
    this.feePct        = config.feePct        ?? CONFIG.feePct;
    this.slippagePct   = config.slippagePct   ?? CONFIG.slippagePct;
    this.initialCapital = config.initialCapital ?? CONFIG.initialCapital;
    
    // Trading state
    this.inPosition  = false;
    this.peakPrice   = 0;
    this.entryPrice  = 0;
    this.trades      = 0;
    this.realizedPnL = 0;
    this.cumFees     = 0;
    this.lastEvent   = 'INIT';
    
    // Re-entry tracking: price must exceed 10d high after exit
    this.tenDayHigh  = 0;
    this.tenDayPrices = [];  // rolling 10d close prices for high calculation
    this.daysSinceExit = 0;
    
    // Alert cooldown (don't spam the same event)
    this.lastAlertEvent = null;
    this.alertCooldown = 0;
  }
  
  /**
   * Hydrate from persisted state (restart-safe)
   */
  hydrate(state) {
    this.inPosition  = state.inPosition  ?? false;
    this.peakPrice   = state.peakPrice   ?? 0;
    this.entryPrice  = state.entryPrice  ?? 0;
    this.trades      = state.trades      ?? 0;
    this.realizedPnL = state.realizedPnL ?? 0;
    this.cumFees     = state.cumFees     ?? 0;
    this.lastEvent   = state.lastEvent   ?? 'INIT';
    this.tenDayHigh  = state.tenDayHigh  ?? 0;
    this.tenDayPrices = state.tenDayPrices ?? [];
    this.daysSinceExit = state.daysSinceExit ?? 0;
  }
  
  /**
   * Serialize state for persistence
   */
  dehydrate() {
    return {
      inPosition:  this.inPosition,
      peakPrice:   this.peakPrice,
      entryPrice:  this.entryPrice,
      trades:      this.trades,
      realizedPnL: this.realizedPnL,
      cumFees:     this.cumFees,
      lastEvent:   this.lastEvent,
      tenDayHigh:  this.tenDayHigh,
      tenDayPrices: this.tenDayPrices.slice(-this.reentryLookback),
      daysSinceExit: this.daysSinceExit,
    };
  }
  
  /**
   * Process a daily candle — signals only evaluated HERE.
   * Returns { signal, state } or null.
   */
  processDailyCandle(candle) {
    const close = candle.close;
    const date   = candle.date;
    
    // ── Update 10-day rolling high (always, even when flat) ──
    this.tenDayPrices.push(close);
    if (this.tenDayPrices.length > this.reentryLookback) {
      this.tenDayPrices.shift();
    }
    const current10dHigh = Math.max(...this.tenDayPrices);
    
    // Update trailing 10d high (for re-entry condition after exit)
    if (this.daysSinceExit > 0) {
      this.tenDayHigh = Math.max(this.tenDayHigh, close);
    }
    
    if (!this.inPosition) {
      // ── FLAT: check re-entry condition ──
      // Re-entry when: price > 10d high AND at least 1 day since exit
      const canReenter = this.daysSinceExit > 0 && close > this.tenDayHigh;
      
      if (canReenter) {
        // ENTRY
        this.inPosition = true;
        this.entryPrice = close;
        this.peakPrice  = close;
        this.trades++;
        this.lastEvent  = 'ENTRY';
        this.daysSinceExit = 0;
        this.tenDayHigh  = 0;
        
        const signal = { action: 'BUY', price: close, date, return: null, reason: `re-entry (>${this.reentryLookback}d high ${this.tenDayHigh.toFixed(2)})` };
        this._alert('ENTRY', signal);
        return signal;
      } else {
        this.daysSinceExit++;
        this.lastEvent = 'FLAT';
        return null;
      }
      
    } else {
      // ── IN POSITION: update peak + check trailing stop ──
      this.peakPrice = Math.max(this.peakPrice, close);
      const trailLevel = this.peakPrice * (1 - this.trailPct);
      
      if (close < trailLevel) {
        // EXIT — trailing stop triggered
        const grossReturn = (close - this.entryPrice) / this.entryPrice;
        const fee         = close * (this.feePct / 100);
        const slippage    = close * (this.slippagePct / 100);
        const netReturn   = grossReturn - (fee + slippage) / this.entryPrice;
        
        this.realizedPnL += netReturn;
        this.cumFees     += fee + slippage;
        this.inPosition   = false;
        this.lastEvent    = 'EXIT';
        this.daysSinceExit = 0;
        this.tenDayHigh   = current10dHigh;  // start tracking 10d high from tomorrow
        
        // Reset peak
        const exitedPeak = this.peakPrice;
        this.peakPrice   = 0;
        this.entryPrice  = 0;
        
        const signal = { 
          action: 'SELL', 
          price: close, 
          date, 
          return: netReturn,
          reason: `trailing stop (peak ${exitedPeak.toFixed(2)}, trail ${trailLevel.toFixed(2)})`
        };
        this._alert('EXIT', signal);
        return signal;
        
      } else {
        // HOLD
        this.lastEvent = 'HOLD';
        return null;
      }
    }
  }
  
  _alert(eventType, signal) {
    // Avoid spamming repeated alerts
    if (this.lastAlertEvent === eventType && this.alertCooldown > 0) return;
    this.lastAlertEvent = eventType;
    this.alertCooldown = 2;  // skip next 2 evaluations
    
    const emoji = signal.action === 'BUY' ? '🟢' : '🔴';
    const pnlStr = signal.return !== null ? ` | PnL: ${(signal.return * 100).toFixed(2)}% | Total: ${(this.realizedPnL * 100).toFixed(2)}%` : '';
    logAlert(this.asset, `${emoji} ${signal.action}`, `${signal.date} @ ${signal.price.toFixed(4)} | ${signal.reason}${pnlStr}`);
  }
  
  // ── Monitoring getters ──
  getTrailLevel() {
    return this.inPosition ? this.peakPrice * (1 - this.trailPct) : 0;
  }
  
  distanceToStop() {
    if (!this.inPosition || this.peakPrice === 0) return null;
    const trail = this.getTrailLevel();
    return ((this.peakPrice - trail) / this.peakPrice) * 100;  // should always be exactly trailPct%
  }
  
  unrealizedPnLEUR() {
    if (!this.inPosition) return 0;
    return (this.peakPrice - this.entryPrice) / this.entryPrice;
  }
  
  currentEquity() {
    return this.initialCapital * (1 + this.realizedPnL + this.unrealizedPnLEUR());
  }
  
  /** Compact daily status row */
  statusRow() {
    const equity = this.currentEquity();
    const unreal  = this.unrealizedPnLEUR();
    const unrealEUR = unreal * this.initialCapital;
    const trail   = this.getTrailLevel();
    const dist    = this.distanceToStop();
    const posStr  = this.inPosition ? 'LONG' : 'FLAT ';
    
    return {
      asset:    this.asset,
      position: posStr,
      price:    this.peakPrice > 0 ? (this.inPosition ? '—' : '—') : '—',  // price tracked separately
      peakPrice: this.peakPrice > 0 ? this.peakPrice : 0,
      trailLevel: trail,
      distToStop: dist,
      equity:   equity,
      unrealizedEUR: unrealEUR,
      realizedPnL:  this.realizedPnL * 100,
      realizedEUR:  this.realizedPnL * this.initialCapital,
      lastEvent: this.lastEvent,
      trades:   this.trades,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Paper Trading Engine
// ─────────────────────────────────────────────────────────────

class PaperEngine {
  constructor() {
    this.strategies  = {};
    this.assetData   = {};   // daily candles per asset
    this.lastPrices  = {};   // latest close per asset
    this.peakTracker = {};  // tracks peak per asset for monitoring
    this.startedAt   = new Date().toISOString();
    this.lastDailyDate = {};  // last fully-closed daily candle date
    
    for (const asset of CONFIG.assets) {
      this.strategies[asset] = new RO15Strategy(asset);
      this.lastPrices[asset] = 0;
      this.peakTracker[asset] = 0;
      this.lastDailyDate[asset] = null;
    }
  }
  
  /**
   * Load historical data + hydrate from saved state
   */
  async initialize() {
    log('=== RO15 Live Validator initializing ===');
    log(`Assets: ${CONFIG.assets.join(', ')}`);
    log(`Trail: ${CONFIG.trailPct*100}% | Fee: ${CONFIG.feePct}% | Slippage: ${CONFIG.slippagePct}%`);
    log(`Re-entry: price > ${CONFIG.reentryLookback}d high | Mode: SHADOW ONLY`);
    
    // Load global state
    const globalState = loadState();
    
    for (const asset of CONFIG.assets) {
      const symbol = asset;  // BTC, ETH
      
      // Fetch daily candles
      let daily;
      try {
        daily = await fetchDailyCandles(symbol, CONFIG.lookbackDays);
      } catch(e) {
        log(`FATAL: Cannot fetch ${asset}: ${e.message}`, 'ERROR');
        throw e;
      }
      this.assetData[asset] = daily;
      this.lastPrices[asset] = daily[daily.length - 1].close;
      
      // Load persisted asset state
      const saved = loadAssetState(asset);
      if (saved) {
        log(`  ${asset}: restoring state from disk`);
        this.strategies[asset].hydrate(saved);
        this.peakTracker[asset] = saved.peakPrice ?? 0;
      } else {
        // Cold start: process all historical candles
        log(`  ${asset}: cold start — processing ${daily.length} daily candles`);
        for (const candle of daily) {
          this.strategies[asset].processDailyCandle(candle);
        }
        // Start IN position (research spec)
        if (!this.strategies[asset].inPosition && daily.length > 0) {
          // Force entry on most recent candle if flat
          const last = daily[daily.length - 1];
          this.strategies[asset].inPosition = true;
          this.strategies[asset].entryPrice  = last.close;
          this.strategies[asset].peakPrice   = last.close;
          this.strategies[asset].trades++;
          this.strategies[asset].lastEvent    = 'ENTRY';
        }
      }
      
      // Save initialized state
      saveAssetState(asset, this.strategies[asset].dehydrate());
      this.lastDailyDate[asset] = daily[daily.length - 1].date;
    }
    
    this.printDailySummary();
    
    // Save global state
    saveState({
      assets: CONFIG.assets,
      trailPct: CONFIG.trailPct,
      startedAt: this.startedAt,
      lastUpdate: new Date().toISOString(),
      lastPrices: this.lastPrices,
    });
    
    log('Initialization complete. Live polling active in SHADOW MODE.');
    log(`Poll interval: ${CONFIG.pollIntervalMs / 1000 / 60} min | Signals: DAILY CANDLE ONLY`);
  }
  
  /**
   * Called every poll interval
   */
  async poll() {
    const now = new Date();
    log(`\n=== Poll @ ${now.toISOString()} ===`);
    
    for (const asset of CONFIG.assets) {
      const symbol = asset;
      try {
        // Fetch latest daily candles (always fetch fresh for last 2 days)
        const daily = await fetchDailyCandles(symbol, 3);
        const latestCandle = daily[daily.length - 1];
        const prevCandle   = daily[daily.length - 2];
        
        const latestDate = latestCandle.date;
        const lastKnown  = this.lastDailyDate[asset];
        
        // ── Only evaluate on NEW daily candle close ──
        if (latestDate !== lastKnown) {
          log(`  ${asset}: new daily candle ${latestDate} (last known: ${lastKnown})`);
          
          // Process the fully-closed candle (yesterday's close)
          if (prevCandle) {
            const signal = this.strategies[asset].processDailyCandle(prevCandle);
            this.lastDailyDate[asset] = prevCandle.date;
            this.lastPrices[asset] = prevCandle.close;
            
            if (signal) {
              log(`  ${asset}: ${signal.action} signal | ${signal.reason}`);
            }
          }
          
          // Also process today's candle (not yet closed, but for peak tracking)
          // Use it only for peak/10d-high updates, NOT for signals
          const todaySignal = this.strategies[asset].processDailyCandle(latestCandle);
          this.lastPrices[asset] = latestCandle.close;
          this.lastDailyDate[asset] = latestDate;
          
        } else {
          // Same day — just update last price for monitoring
          this.lastPrices[asset] = latestCandle.close;
          log(`  ${asset}: ${latestCandle.date} (no new candle yet) | price: ${latestCandle.close}`);
        }
        
      } catch(e) {
        log(`  ${asset}: poll error — ${e.message}`, 'ERROR');
      }
      
      // Persist state after each poll
      saveAssetState(asset, this.strategies[asset].dehydrate());
    }
    
    // Global state update
    saveState({
      assets: CONFIG.assets,
      trailPct: CONFIG.trailPct,
      startedAt: this.startedAt,
      lastUpdate: new Date().toISOString(),
      lastPrices: this.lastPrices,
    });
    
    this.printDailySummary();
    this.writeDailyLog();
  }
  
  /** Print compact daily monitoring row */
  printDailySummary() {
    log('\n┌─────────────────────────────────────────────────────────────────────────┐');
    log('│  RO15 SHADOW MONITOR                                            │');
    log('├──────────┬────────┬──────────┬──────────┬───────────┬────────────────┤');
    log('│ ASSET    │ POS    │ PEAK     │ TRAIL    │ EQUITY    │ LAST EVENT    │');
    log('├──────────┼────────┼──────────┼──────────┼───────────┼────────────────┤');
    
    for (const asset of CONFIG.assets) {
      const s = this.strategies[asset];
      const price = this.lastPrices[asset];
      const equity = s.currentEquity();
      const trail  = s.getTrailLevel();
      const dist   = s.distanceToStop();
      const unreal = s.unrealizedPnLEUR();
      const realized = s.realizedPnL;
      
      const pos    = s.inPosition ? 'LONG ' : 'FLAT ';
      const peak   = s.peakPrice > 0 ? s.peakPrice.toFixed(2) : '—';
      const trailS = trail > 0 ? trail.toFixed(2) : '—';
      const distS  = dist !== null ? `${dist.toFixed(1)}%` : '—';
      const event  = s.lastEvent.padEnd(14);
      
      log(`│ ${asset.padEnd(8)} │ ${pos} │ ${peak.padEnd(8)} │ ${trailS.padEnd(8)} │ ${equity.toFixed(2).padStart(9)} € │ ${event} │`);
      
      // Detail line
      const detail = s.inPosition
        ? `  unrealized: ${(unreal*100).toFixed(2)}% | realized: ${(realized*100).toFixed(2)}% | trades: ${s.trades}`
        : `  realized: ${(realized*100).toFixed(2)}% | trades: ${s.trades} | 10d high tracking: ${s.tenDayHigh > 0 ? 'yes' : 'no'}`;
      log(`│          │ ${detail.padEnd(72)} │`);
    }
    
    log('└──────────┴────────┴──────────┴──────────┴───────────┴────────────────┘');
    
    // Total portfolio
    const totalEquity = CONFIG.assets.reduce((sum, a) => sum + this.strategies[a].currentEquity(), 0);
    log(`  TOTAL PORTFOLIO: ${totalEquity.toFixed(2)} € | started: ${this.startedAt.slice(0,10)}`);
  }
  
  /** Append a daily snapshot to daily CSV log */
  writeDailyLog() {
    const date = new Date().toISOString().slice(0,10);
    const dailyFile = path.join(DAILY_DIR, `summary-${date}.csv`);
    
    const headers = ['timestamp','asset','position','price','peakPrice','trailLevel','distToStopPct','equityEUR','unrealizedEUR','realizedEUR','realizedPct','lastEvent','trades','cumFees'];
    
    let rows = CONFIG.assets.map(asset => {
      const s = this.strategies[asset];
      const price = this.lastPrices[asset];
      const equity = s.currentEquity();
      const trail = s.getTrailLevel();
      const dist  = s.distanceToStop();
      const unreal = s.unrealizedPnLEUR();
      
      return [
        new Date().toISOString(),
        asset,
        s.inPosition ? 'LONG' : 'FLAT',
        price.toFixed(4),
        s.peakPrice.toFixed(4),
        trail.toFixed(4),
        dist !== null ? dist.toFixed(4) : '',
        equity.toFixed(2),
        (unreal * CONFIG.initialCapital).toFixed(2),
        (s.realizedPnL * CONFIG.initialCapital).toFixed(2),
        (s.realizedPnL * 100).toFixed(4),
        s.lastEvent,
        s.trades,
        s.cumFees.toFixed(4),
      ].join(',');
    });
    
    const content = rows.map(r => headers.join(',') + '\n' + r).join('\n');
    if (!fs.existsSync(dailyFile)) {
      fs.writeFileSync(dailyFile, headers.join(',') + '\n');
    }
    fs.appendFileSync(dailyFile, rows.join('\n') + '\n');
  }
  
  /**
   * Start live polling loop
   */
  startLive() {
    log(`\n=== Live polling started (SHADOW MODE) ===`);
    log(`Interval: every ${CONFIG.pollIntervalMs / 1000 / 60} minutes`);
    log(`Signals: evaluated ONLY at daily candle closes`);
    
    // Immediate first poll
    this.poll().catch(e => log(`Poll error: ${e.message}`, 'ERROR'));
    
    setInterval(() => {
      this.poll().catch(e => log(`Poll error: ${e.message}`, 'ERROR'));
    }, CONFIG.pollIntervalMs);
  }
}

// ─────────────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  
  const engine = new PaperEngine();
  
  try {
    await engine.initialize();
    
    if (args.includes('--live')) {
      engine.startLive();
    } else {
      // One-shot daily check (for cron/systemd)
      log('One-shot mode. Daily check complete.');
      process.exit(0);
    }
  } catch(e) {
    log(`FATAL: ${e.message}`, 'ERROR');
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
RO15 Live Shadow Validator

Usage:
  node ro15-live-validator.mjs [--live]
  
Options:
  --live     Start continuous hourly polling
  --help     Show this help

Shadow Mode:
  No real orders are placed. Only signals, state, and logging.
  All signals evaluated at daily candle closes only.

State Recovery:
  State persists in logs/state.json and logs/assets/*.json
  Restart safe — picks up from last known state.

Logs:
  logs/                    — main log dir
  logs/validator-YYYY-MM-DD.log   — daily console log
  logs/assets/BTC-state.json     — BTC trading state
  logs/assets/ETH-state.json     — ETH trading state
  logs/daily/summary-YYYY-MM-DD.csv — daily equity snapshots
  logs/alerts/BTC-alerts.log      — BTC entry/exit alerts
  logs/alerts/ETH-alerts.log      — ETH entry/exit alerts
`);
}

main();
