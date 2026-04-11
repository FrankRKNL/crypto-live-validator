#!/usr/bin/env node
/**
 * RO15 Live Shadow-Mode Validator (Production)
 * 
 * Strategy (exact research spec — DO NOT CHANGE):
 * - Always IN position at start (market entry)
 * - Track peak price since entry
 * - Exit: price < peak × (1 − 0.15) = peak × 0.85  (15% trailing stop)
 * - Re-entry: price > 10-trading-day high (after exit)
 * - Fee: 0.15% | Slippage: 0%
 * - Signals ONLY evaluated at daily candle closes (no intraday pseudo-signals)
 * 
 * Mode: SHADOW ONLY — no real orders, no exchange execution.
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR      = path.join(__dirname, 'logs');
const STATE_PATH   = path.join(LOG_DIR, 'state.json');
const DAILY_DIR    = path.join(LOG_DIR, 'daily');
const ALERTS_DIR   = path.join(LOG_DIR, 'alerts');
const ASSET_LOG_DIR = path.join(LOG_DIR, 'assets');

// ─────────────────────────────────────────────────────────────
// Configuration — EXACT research spec (do not change)
// ─────────────────────────────────────────────────────────────

const CONFIG = {
  assets: ['BTC', 'ETH'],
  
  // RO15 Research Spec
  trailPct:        0.15,      // 15% trailing stop
  reentryLookback: 10,        // 10 trading days for re-entry high
  feePct:          0.15,      // 0.15% fee per trade (research spec)
  slippagePct:     0,         // 0% slippage (research spec)
  
  // Runtime
  pollIntervalMs:  60 * 60 * 1000,  // 1 hour between polls
  lookbackDays:    30,              // Fetch 30 days of 1h candles
  
  // Paper capital (per asset, independent)
  initialCapital:  10000,   // EUR per asset
  
  // Retry on API failure
  apiRetries:      3,
  apiRetryDelayMs: 5000,
  
  // Paths
  logDir:          LOG_DIR,
  statePath:       STATE_PATH,
};

for (const d of [LOG_DIR, DAILY_DIR, ALERTS_DIR, ASSET_LOG_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ─────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${(level||'INFO').padEnd(5)}] ${msg}`;
  // Deduplicate duplicate lines (happens when multiple instances run)
  const logFile = path.join(LOG_DIR, `validator-${new Date().toISOString().slice(0,10)}.log`);
  try {
    const existing = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const lastLine = existing.split('\n').filter(Boolean).pop();
    if (lastLine !== line) {
      console.log(line);
      fs.appendFileSync(logFile, line + '\n');
    }
  } catch(e) {
    console.log(line);
  }
}

function logAlert(asset, event, details) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [ALERT] ${asset}: ${event} — ${details}`;
  console.log(line);
  const alertFile = path.join(ALERTS_DIR, `${asset}-alerts.log`);
  fs.appendFileSync(alertFile, line + '\n');
}

// ─────────────────────────────────────────────────────────────
// API Client with retry
// ─────────────────────────────────────────────────────────────

function fetchJSON(url, retries = CONFIG.apiRetries) {
  return new Promise((resolve, reject) => {
    const doFetch = (attempt) => {
      log(`API attempt ${attempt}/${retries}: ${url.slice(0,80)}...`);
      https.get(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode === 429) {
          // Rate limited — wait and retry
          if (attempt < retries) {
            log(`Rate limited, waiting ${CONFIG.apiRetryDelayMs}ms before retry`, 'WARN');
            setTimeout(() => doFetch(attempt + 1), CONFIG.apiRetryDelayMs);
            return;
          }
          reject(new Error('HTTP 429 Rate Limited'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        });
      }).on('error', e => {
        if (attempt < retries) {
          log(`Network error (attempt ${attempt}), retrying in ${CONFIG.apiRetryDelayMs}ms: ${e.message}`, 'WARN');
          setTimeout(() => doFetch(attempt + 1), CONFIG.apiRetryDelayMs);
        } else {
          reject(new Error(`Network error after ${retries} attempts: ${e.message}`));
        }
      }).on('timeout', () => {
        if (attempt < retries) {
          log(`Timeout (attempt ${attempt}), retrying`, 'WARN');
          setTimeout(() => doFetch(attempt + 1), CONFIG.apiRetryDelayMs);
        } else {
          reject(new Error('Timeout after retries'));
        }
      });
    };
    doFetch(1);
  });
}

/**
 * Fetch 1h klines and aggregate to daily candles.
 * Binance 1h kline: [openTime, open, high, low, close, volume, closeTime, ...]
 * A "daily candle" closes at 00:00 UTC the next day.
 */
async function fetchDailyCandles(symbol, days = 30) {
  const limit = Math.min(days * 24 + 2, 500); // Binance max 500
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
  
  // Aggregate 1h → daily (UTC days)
  const dailyMap = new Map();
  
  for (const k of raw) {
    const openTime = Number(k[0]);
    const open     = parseFloat(k[1]);
    const high     = parseFloat(k[2]);
    const low      = parseFloat(k[3]);
    const close    = parseFloat(k[4]);
    const volume   = parseFloat(k[5]);
    
    // UTC day key: midnight UTC of the day this hour belongs to
    const d = new Date(openTime);
    const dayKey = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
    
    if (!dailyMap.has(dayKey)) {
      dailyMap.set(dayKey, {
        date:   new Date(dayKey * 1000).toISOString().slice(0,10), // YYYY-MM-DD
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
      existing.close  = close;    // last close of the UTC day
      existing.volume += volume;
      existing.trades++;
    }
  }
  
  const daily = Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date));
  
  log(`  ${symbol}: ${daily.length} daily candles (${daily[0]?.date} → ${daily[daily.length-1]?.date})`);
  return daily;
}

// ─────────────────────────────────────────────────────────────
// State Persistence
// ─────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf8');
      return JSON.parse(raw);
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
// RO15 Strategy Engine — EXACT research spec
// ─────────────────────────────────────────────────────────────

class RO15Strategy {
  constructor(asset) {
    this.asset           = asset;
    this.trailPct        = CONFIG.trailPct;
    this.reentryLookback = CONFIG.reentryLookback;
    this.feePct          = CONFIG.feePct;
    this.slippagePct    = CONFIG.slippagePct;
    this.initialCapital  = CONFIG.initialCapital;
    
    // Trading state
    this.inPosition   = false;
    this.entryPrice   = 0;
    this.peakPrice    = 0;
    this.trades       = 0;
    this.realizedPnL  = 0;
    this.cumFees      = 0;
    this.lastEvent    = 'INIT';
    
    // Current market price (for unrealized PnL — tracked separately from peak)
    this.currentPrice = 0;
    
    // Re-entry tracking
    this.tenDayHigh   = 0;    // rolling 10d high tracker (used after exit)
    this.tenDayPrices = [];   // rolling window of closes
    this.daysSinceExit = 0;
    
    // Alert cooldown (avoid duplicate alerts)
    this._lastAlertEvent = null;
    this._alertSilence   = 0;
  }
  
  hydrate(state) {
    this.inPosition   = state.inPosition   ?? false;
    this.entryPrice   = state.entryPrice   ?? 0;
    this.peakPrice    = state.peakPrice    ?? 0;
    this.trades        = state.trades       ?? 0;
    this.realizedPnL  = state.realizedPnL  ?? 0;
    this.cumFees      = state.cumFees      ?? 0;
    this.lastEvent    = state.lastEvent    ?? 'INIT';
    this.tenDayHigh   = state.tenDayHigh   ?? 0;
    this.tenDayPrices = state.tenDayPrices  ?? [];
    this.daysSinceExit = state.daysSinceExit ?? 0;
    this.currentPrice = state.currentPrice  ?? 0;
  }
  
  dehydrate() {
    return {
      inPosition:   this.inPosition,
      entryPrice:   this.entryPrice,
      peakPrice:    this.peakPrice,
      trades:       this.trades,
      realizedPnL:  this.realizedPnL,
      cumFees:      this.cumFees,
      lastEvent:    this.lastEvent,
      tenDayHigh:   this.tenDayHigh,
      tenDayPrices: this.tenDayPrices.slice(-this.reentryLookback),
      daysSinceExit: this.daysSinceExit,
      currentPrice: this.currentPrice,
    };
  }
  
  /**
   * Update current price — called every poll for equity tracking.
   * Does NOT generate signals.
   */
  updateCurrentPrice(price) {
    this.currentPrice = price;
  }
  
  /**
   * Process a CLOSED daily candle — signals ONLY evaluated here.
   * Returns signal object or null (no signal).
   */
  processClosedCandle(candle) {
    const close = candle.close;
    const date  = candle.date;
    
    // Update rolling 10d window (always, regardless of position)
    this.tenDayPrices.push(close);
    if (this.tenDayPrices.length > this.reentryLookback) {
      this.tenDayPrices.shift();
    }
    
    // 10d high from the rolling window (used for re-entry)
    const window10dHigh = Math.max(...this.tenDayPrices);
    
    if (!this.inPosition) {
      // ── FLAT: check re-entry condition ──
      // Re-entry when: price > 10d high (AND at least 1 day since exit)
      if (this.daysSinceExit > 0 && close > this.tenDayHigh) {
        // ENTRY
        const entryFee = close * (this.feePct / 100);
        this.inPosition = true;
        this.entryPrice = close;
        this.peakPrice  = close;   // peak starts at entry
        this.trades++;
        this.lastEvent   = 'ENTRY';
        this.daysSinceExit = 0;
        this.tenDayHigh   = 0;      // reset until next exit
        this.tenDayPrices = [close]; // fresh window from entry
        
        const signal = {
          action:  'BUY',
          price:   close,
          date,
          return:  null,
          reason:  `re-entry (>${this.reentryLookback}d high ${this.tenDayHigh.toFixed(2)})`,
        };
        this._alert(signal);
        return signal;
      } else {
        // Still flat
        this.daysSinceExit++;
        // Keep tracking tenDayHigh for re-entry condition
        this.tenDayHigh = Math.max(this.tenDayHigh || 0, close);
        this.lastEvent = 'FLAT';
        return null;
      }
      
    } else {
      // ── IN POSITION: update peak + trailing stop check ──
      this.peakPrice = Math.max(this.peakPrice, close);
      const trailLevel = this.peakPrice * (1 - this.trailPct);
      
      if (close < trailLevel) {
        // EXIT — trailing stop triggered
        const grossReturn  = (close - this.entryPrice) / this.entryPrice;
        const fee          = close * (this.feePct / 100);
        const slippage     = close * (this.slippagePct / 100);
        const netReturn    = grossReturn - (fee + slippage) / this.entryPrice;
        
        this.realizedPnL += netReturn;
        this.cumFees     += fee + slippage;
        this.inPosition   = false;
        this.lastEvent    = 'EXIT';
        this.daysSinceExit = 0;
        this.tenDayHigh   = window10dHigh; // start tracking from current window
        this.tenDayPrices = [];            // fresh 10d window after exit
        const exitedPeak   = this.peakPrice;
        this.peakPrice     = 0;
        this.entryPrice    = 0;
        
        const signal = {
          action:  'SELL',
          price:   close,
          date,
          return:  netReturn,
          reason:  `trailing stop (peak ${exitedPeak.toFixed(2)}, trail ${trailLevel.toFixed(2)})`,
        };
        this._alert(signal);
        return signal;
      } else {
        // HOLD — no signal
        this.lastEvent = 'HOLD';
        return null;
      }
    }
  }
  
  _alert(signal) {
    // Silence duplicate alerts for 2 evaluation cycles
    if (this._alertSilence > 0) {
      this._alertSilence--;
      return;
    }
    if (this._lastAlertEvent === signal.action) {
      this._alertSilence = 2;
      return;
    }
    this._lastAlertEvent = signal.action;
    
    const emoji   = signal.action === 'BUY' ? '🟢' : '🔴';
    const pnlStr  = signal.return !== null
      ? ` | PnL: ${(signal.return*100).toFixed(2)}% | Total: ${(this.realizedPnL*100).toFixed(2)}%`
      : '';
    logAlert(this.asset, `${emoji} ${signal.action}`, `${signal.date} @ ${signal.price.toFixed(4)} | ${signal.reason}${pnlStr}`);
  }
  
  // ── Monitoring getters ──
  
  getTrailLevel() {
    return this.inPosition ? this.peakPrice * (1 - this.trailPct) : 0;
  }
  
  /** Distance from current price to stop level (% of current price) */
  distanceToStopPct() {
    if (!this.inPosition || this.currentPrice === 0) return null;
    const trail = this.getTrailLevel();
    return ((this.currentPrice - trail) / this.currentPrice) * 100;
  }
  
  /** Unrealized PnL: current vs entry (NOT peak vs entry) */
  unrealizedPnL() {
    if (!this.inPosition || this.currentPrice === 0 || this.entryPrice === 0) return 0;
    return (this.currentPrice - this.entryPrice) / this.entryPrice;
  }
  
  /** Paper equity in EUR */
  currentEquity() {
    const unreal = this.unrealizedPnL();
    return this.initialCapital * (1 + this.realizedPnL + unreal);
  }
  
  /** Human-readable status row for monitoring table */
  statusRow() {
    const equity     = this.currentEquity();
    const unreal      = this.unrealizedPnL();
    const unrealEUR   = unreal * this.initialCapital;
    const realizedEUR = this.realizedPnL * this.initialCapital;
    const trail       = this.getTrailLevel();
    const distPct     = this.distanceToStopPct();
    const posStr      = this.inPosition ? 'LONG' : 'FLAT';
    const tenDayStr   = (!this.inPosition && this.tenDayHigh > 0)
      ? ` | 10d high: ${this.tenDayHigh.toFixed(2)}`
      : '';
    
    return {
      asset:          this.asset,
      position:       posStr,
      currentPrice:   this.currentPrice,
      peakPrice:      this.peakPrice,
      trailLevel:     trail,
      distToStopPct:  distPct,
      equity:         equity,
      unrealizedPct:  unreal * 100,
      unrealizedEUR:  unrealEUR,
      realizedPct:    this.realizedPnL * 100,
      realizedEUR:    realizedEUR,
      lastEvent:      this.lastEvent,
      trades:         this.trades,
      cumFees:        this.cumFees,
      tenDayInfo:     tenDayStr,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Paper Trading Engine
// ─────────────────────────────────────────────────────────────

class PaperEngine {
  constructor() {
    this.strategies     = {};
    this.lastPrices     = {};
    this.lastDailyDate  = {};
    this.startedAt      = new Date().toISOString();
    
    for (const asset of CONFIG.assets) {
      this.strategies[asset]   = new RO15Strategy(asset);
      this.lastPrices[asset]   = 0;
      this.lastDailyDate[asset] = null;
    }
  }
  
  async initialize() {
    log('═'.repeat(78));
    log('RO15 LIVE SHADOW VALIDATOR — initializing');
    log(`Assets: ${CONFIG.assets.join(', ')}`);
    log(`Spec: trail=${CONFIG.trailPct*100}% | fee=${CONFIG.feePct}% | slippage=${CONFIG.slippagePct}%`);
    log(`Re-entry: price > ${CONFIG.reentryLookback}d high | Mode: SHADOW ONLY (no real orders)`);
    log(`Poll interval: ${CONFIG.pollIntervalMs/1000/60} min | Signals: DAILY CANDLE CLOSES ONLY`);
    log('═'.repeat(78));
    
    const globalState = loadState();
    
    for (const asset of CONFIG.assets) {
      let daily;
      try {
        daily = await fetchDailyCandles(asset, CONFIG.lookbackDays);
      } catch(e) {
        log(`FATAL: Cannot fetch ${asset}: ${e.message}`, 'ERROR');
        throw e;
      }
      
      const latestCandle  = daily[daily.length - 1];
      const latestPrice   = latestCandle.close;
      this.lastPrices[asset]   = latestPrice;
      this.lastDailyDate[asset] = latestCandle.date;
      
      // Restore or cold start
      const saved = loadAssetState(asset);
      if (saved) {
        log(`  ${asset}: restoring state from disk`);
        this.strategies[asset].hydrate(saved);
        this.strategies[asset].updateCurrentPrice(latestPrice);
        
        // If we're still in position, update peak with any new highs in recent candles
        if (this.strategies[asset].inPosition) {
          const s = this.strategies[asset];
          for (const c of daily.slice(-5)) {
            s.peakPrice = Math.max(s.peakPrice, c.close);
          }
        }
      } else {
        log(`  ${asset}: cold start — processing ${daily.length} daily candles`);
        
        // Process all historical daily candles
        for (const candle of daily) {
          this.strategies[asset].processClosedCandle(candle);
        }
        
        // Force entry at most recent close (research spec: always start IN position)
        const s = this.strategies[asset];
        if (!s.inPosition && daily.length > 0) {
          s.inPosition   = true;
          s.entryPrice    = latestPrice;
          s.peakPrice     = latestPrice;
          s.currentPrice  = latestPrice;
          s.tenDayPrices  = daily.slice(-CONFIG.reentryLookback).map(c => c.close);
          s.tenDayHigh    = Math.max(...s.tenDayPrices);
          s.trades++;
          s.lastEvent     = 'ENTRY';
          logAlert(asset, '🟢 BUY (cold start)', `forced entry @ ${latestPrice.toFixed(4)}`);
        } else {
          s.currentPrice = latestPrice;
        }
      }
      
      saveAssetState(asset, this.strategies[asset].dehydrate());
    }
    
    saveState({
      assets:      CONFIG.assets,
      trailPct:    CONFIG.trailPct,
      startedAt:   this.startedAt,
      lastUpdate:  new Date().toISOString(),
      lastPrices:  this.lastPrices,
    });
    
    this.printDailySummary();
    log('Initialization complete. Live polling active in SHADOW MODE.');
  }
  
  /**
   * Called every poll interval.
   * Signals evaluated ONLY on new daily candle closes.
   */
  async poll() {
    const now = new Date();
    log(`\n${'─'.repeat(78)}`);
    log(`POLL @ ${now.toISOString()}`);
    
    let anyNewCandle = false;
    
    for (const asset of CONFIG.assets) {
      let daily;
      try {
        daily = await fetchDailyCandles(asset, 3);
      } catch(e) {
        log(`  ${asset}: API error — ${e.message}`, 'ERROR');
        // Update current price from last known if API fails
        if (this.strategies[asset].currentPrice === 0) {
          this.strategies[asset].currentPrice = this.lastPrices[asset];
        }
        continue;
      }
      
      const latestCandle = daily[daily.length - 1];
      const prevCandle   = daily[daily.length - 2];
      const latestDate   = latestCandle.date;
      const lastKnown    = this.lastDailyDate[asset];
      
      if (latestDate !== lastKnown) {
        // New closed candle!
        anyNewCandle = true;
        log(`  ${asset}: 📅 new closed candle ${prevCandle.date} (was ${lastKnown})`);
        
        // Process the fully-closed candle (yesterday's close) for signals
        const signal = this.strategies[asset].processClosedCandle(prevCandle);
        this.lastDailyDate[asset] = prevCandle.date;
        this.lastPrices[asset]    = prevCandle.close;
        this.strategies[asset].currentPrice = prevCandle.close;
        
        if (signal) {
          log(`  ${asset}: ⚡ SIGNAL → ${signal.action} | ${signal.reason}`);
        }
        
        // Also track today's ongoing candle price (peak updates only, no signal)
        if (latestCandle.close !== prevCandle.close) {
          const s = this.strategies[asset];
          s.peakPrice = Math.max(s.peakPrice, latestCandle.close);
          s.currentPrice = latestCandle.close;
          this.lastPrices[asset] = latestCandle.close;
        }
      } else {
        // Same day — just update current price for equity monitoring
        this.strategies[asset].currentPrice = latestCandle.close;
        this.lastPrices[asset]              = latestCandle.close;
        log(`  ${asset}: ⏳ ${latestDate} (no new candle yet) | price: ${latestCandle.close.toFixed(4)}`);
      }
      
      saveAssetState(asset, this.strategies[asset].dehydrate());
    }
    
    saveState({
      assets:      CONFIG.assets,
      trailPct:    CONFIG.trailPct,
      startedAt:   this.startedAt,
      lastUpdate:  new Date().toISOString(),
      lastPrices:  this.lastPrices,
    });
    
    if (!anyNewCandle) {
      log(`  (no new closed candles this poll — signals skipped)`);
    }
    
    this.printDailySummary();
    this.writeDailySnapshot();
  }
  
  /** Print the compact monitoring table */
  printDailySummary() {
    const totalEquity = CONFIG.assets.reduce((s, a) => s + this.strategies[a].currentEquity(), 0);
    
    log('\n┌──────────────────────────────────────────────────────────────────────────────────────────────┐');
    log('│  RO15 SHADOW MONITOR  |  2026-04-11  |  SHADOW MODE                                            │');
    log('├──────────┬────────┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────────────────┤');
    log('│ ASSET    │ POS    │ PRICE    │ PEAK     │ TRAIL    │ DIST     │ EQUITY   │ LAST EVENT          │');
    log('├──────────┼────────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────────────────┤');
    
    for (const asset of CONFIG.assets) {
      const s     = this.strategies[asset];
      const price = s.currentPrice;
      const row   = s.statusRow();
      const pos    = row.position;
      const priceStr = price > 0 ? price.toFixed(2) : '—';
      const peakStr  = row.peakPrice > 0 ? row.peakPrice.toFixed(2) : '—';
      const trailStr = row.trailLevel > 0 ? row.trailLevel.toFixed(2) : '—';
      const distStr  = row.distToStopPct !== null ? `${row.distToStopPct.toFixed(1)}%` : '—';
      
      log(`│ ${asset.padEnd(8)} │ ${pos} │ ${priceStr.padEnd(8)} │ ${peakStr.padEnd(8)} │ ${trailStr.padEnd(8)} │ ${distStr.padEnd(8)} │ ${row.equity.toFixed(2).padStart(8)} € │ ${(row.lastEvent + row.tenDayInfo).padEnd(19)} │`);
      
      const detail = s.inPosition
        ? `unrealized: ${row.unrealizedPct >= 0 ? '+' : ''}${row.unrealizedPct.toFixed(2)}% (${row.unrealizedEUR >= 0 ? '+' : ''}${row.unrealizedEUR.toFixed(2)} €) | realized: ${row.realizedPct >= 0 ? '+' : ''}${row.realizedPct.toFixed(2)}% | trades: ${row.trades}`
        : `realized: ${row.realizedPct >= 0 ? '+' : ''}${row.realizedPct.toFixed(2)}% (${row.realizedEUR >= 0 ? '+' : ''}${row.realizedEUR.toFixed(2)} €) | trades: ${row.trades}${row.tenDayInfo}`;
      log(`│          │ ${detail.padEnd(90)} │`);
    }
    
    log('├──────────┴────────┴──────────┴──────────┴──────────┴──────────┴──────────┴─────────────────────┤');
    log(`│  TOTAL PORTFOLIO: ${totalEquity.toFixed(2)} €  |  started: ${this.startedAt.slice(0,10)}  |  validation period: 2–4 weeks  │`);
    log('└────────────────────────────────────────────────────────────────────────────────────────────────────┘');
  }
  
  /** Append a daily snapshot to CSV (header only written once) */
  writeDailySnapshot() {
    const date     = new Date().toISOString().slice(0,10);
    const dailyCsv = path.join(DAILY_DIR, `summary-${date}.csv`);
    const headers  = ['timestamp','asset','position','currentPrice','peakPrice','trailLevel',
                      'distToStopPct','equityEUR','unrealizedPct','unrealizedEUR','realizedPct',
                      'realizedEUR','lastEvent','trades','cumFees'];
    
    const rows = CONFIG.assets.map(asset => {
      const s = this.strategies[asset];
      const r = s.statusRow();
      return [
        new Date().toISOString(),
        asset,
        r.position,
        r.currentPrice.toFixed(4),
        r.peakPrice.toFixed(4),
        r.trailLevel.toFixed(4),
        r.distToStopPct !== null ? r.distToStopPct.toFixed(4) : '',
        r.equity.toFixed(2),
        r.unrealizedPct.toFixed(4),
        r.unrealizedEUR.toFixed(2),
        r.realizedPct.toFixed(4),
        r.realizedEUR.toFixed(2),
        r.lastEvent,
        r.trades,
        s.cumFees.toFixed(4),
      ].join(',');
    });
    
    const headerLine = headers.join(',');
    const content    = rows.map(r => headerLine + '\n' + r).join('\n');
    
    if (!fs.existsSync(dailyCsv)) {
      fs.writeFileSync(dailyCsv, headerLine + '\n');
    }
    fs.appendFileSync(dailyCsv, rows.join('\n') + '\n');
  }
  
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

function printHelp() {
  console.log(`
RO15 Live Shadow-Mode Validator

Usage:
  node ro15-live-validator.mjs [--live]
  node ro15-live-validator.mjs           # one-shot
  node ro15-live-validator.mjs --help    # this help

Options:
  --live     Start continuous hourly polling (for PM2/systemd)
  --once     Run a single poll and exit (for cron)

Mode:
  SHADOW ONLY — no real orders placed. Only signals, state, and logging.
  All signals evaluated at DAILY CANDLE CLOSES only.

State Recovery:
  Restart-safe. State persists in:
    logs/state.json
    logs/assets/{BTC,ETH}-state.json

Logs:
  logs/validator-YYYY-MM-DD.log    — console log per day
  logs/assets/{ASSET}-state.json    — full trading state per asset
  logs/daily/summary-YYYY-MM-DD.csv — daily equity snapshots
  logs/alerts/{ASSET}-alerts.log    — entry/exit events only

PM2:
  pm2 start ro15-live-validator.mjs --name ro15-live -- --live
  pm2 save
  pm2 logs ro15-live

Systemd:
  sudo systemctl enable /path/to/ro15-live.service
  sudo systemctl start ro15-live
  journalctl -u ro15-live -f

Cron (one-shot hourly):
  0 * * * * node /path/to/ro15-live-validator.mjs --once
`);
}

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
      // One-shot
      log('One-shot mode. Daily check complete.');
      process.exit(0);
    }
  } catch(e) {
    log(`FATAL: ${e.message}`, 'ERROR');
    process.exit(1);
  }
}

main();
