#!/usr/bin/env node
/**
 * RO15 Live Shadow-Mode Validator — Production Build v3
 * 
 * Strategy (exact research spec):
 * - Always IN position at start
 * - Exit: price < peak × 0.85 (15% trailing stop)
 * - Re-entry: price > 10-trading-day high
 * - Fee: 0.15% | Slippage: 0%
 * - Signals ONLY evaluated at daily candle closes
 * 
 * Mode: SHADOW ONLY — no real orders.
 * 
 * Quick start:
 *   node ro15-live-validator.mjs --live   # live polling (PM2/systemd)
 *   node ro15-live-validator.mjs --once   # one-shot (cron)
 * 
 * Map structure:
 *   crypto-live-validator/
 *   ├── ro15-live-validator.mjs   ← this file
 *   ├── package.json
 *   ├── README.md
 *   └── logs/
 *       ├── state.json                   ← global restart state
 *       ├── validator-YYYY-MM-DD.log    ← per-day console log
 *       ├── VALIDATION-TRACKER.md        ← trade log + monitoring
 *       ├── signals.csv                  ← structured signal log
 *       ├── daily/
 *       │   └── summary-YYYY-MM-DD.csv   ← daily equity snapshots
 *       ├── assets/
 *       │   ├── BTC-state.json           ← BTC full trading state
 *       │   └── ETH-state.json           ← ETH full trading state
 *       └── alerts/
 *           ├── BTC-alerts.log            ← BTC entry/exit events
 *           └── ETH-alerts.log            ← ETH entry/exit events
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname       = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR         = path.join(__dirname, 'logs');
const STATE_PATH      = path.join(LOG_DIR, 'state.json');
const DAILY_DIR       = path.join(LOG_DIR, 'daily');
const ALERTS_DIR      = path.join(LOG_DIR, 'alerts');
const ASSET_LOG_DIR   = path.join(LOG_DIR, 'assets');
const SIGNAL_LOG      = path.join(LOG_DIR, 'signals.csv');

const CONFIG = {
  assets: ['BTC', 'ETH'],
  trailPct:        0.15,
  reentryLookback: 10,
  feePct:          0.15,        // 0.15% per trade (Binance realistic)
  slippagePct:     0,
  pollIntervalMs:  60 * 60 * 1000, // 1 hour between polls
  lookbackDays:    30,            // Fetch 30 days of 1h candles
  initialCapital:  10000,        // EUR per asset
  apiRetries:      3,
  apiRetryDelayMs: 5000,
  // Rolling logs
  logRetentionDays: 14,          // Delete logs older than this
  signalLogMaxLines: 500,        // Rotate signal log if too long
};

for (const d of [LOG_DIR, DAILY_DIR, ALERTS_DIR, ASSET_LOG_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ─────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────

function log(msg, level = 'INFO') {
  const ts      = new Date().toISOString();
  const line    = `[${ts}] [${(level||'INFO').padEnd(5)}] ${msg}`;
  const logFile = path.join(LOG_DIR, `validator-${new Date().toISOString().slice(0,10)}.log`);
  try { fs.appendFileSync(logFile, line + '\n'); } catch(e) {}
  console.log(line);
}

function logAlert(asset, event, details) {
  const ts    = new Date().toISOString();
  const line  = `[${ts}] [ALERT] ${asset}: ${event} — ${details}`;
  console.log(`  ${line}`);
  const alertFile = path.join(ALERTS_DIR, `${asset}-alerts.log`);
  fs.appendFileSync(alertFile, line + '\n');
}

function logSignal(asset, signal) {
  // Structured: timestamp,asset,action,price,candleDate,returnPct,reason,equityEUR,realizedPct,trades
  const row = [
    new Date().toISOString(),
    asset,
    signal.action,
    signal.price.toFixed(4),
    signal.date,
    signal.return !== null ? (signal.return * 100).toFixed(4) : '',
    signal.reason,
    '', // equityEUR — filled by caller
    '', // realizedPct — filled by caller
    '', // trades — filled by caller
  ].join(',');
  const header = 'timestamp,asset,action,price,candleDate,returnPct,reason,equityEUR,realizedPct,trades';
  if (!fs.existsSync(SIGNAL_LOG)) {
    fs.writeFileSync(SIGNAL_LOG, header + '\n');
  }
  fs.appendFileSync(SIGNAL_LOG, row + '\n');
}

// ─────────────────────────────────────────────────────────────
// API Client
// ─────────────────────────────────────────────────────────────

function fetchJSON(url, retries = CONFIG.apiRetries) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      log(`API attempt ${n}/${retries}: ${url.slice(0,70)}...`);
      https.get(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode === 429) {
          if (n < retries) {
            log(`Rate limited — retry in ${CONFIG.apiRetryDelayMs}ms`, 'WARN');
            setTimeout(() => attempt(n + 1), CONFIG.apiRetryDelayMs); return;
          }
          reject(new Error('HTTP 429'));
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('JSON parse error')); } });
      }).on('error', e => {
        if (n < retries) {
          log(`Network error — retry in ${CONFIG.apiRetryDelayMs}ms: ${e.message}`, 'WARN');
          setTimeout(() => attempt(n + 1), CONFIG.apiRetryDelayMs);
        } else reject(new Error(`Network error after ${retries} attempts`));
      }).on('timeout', () => {
        if (n < retries) setTimeout(() => attempt(n + 1), CONFIG.apiRetryDelayMs);
        else reject(new Error('Timeout'));
      });
    };
    attempt(1);
  });
}

/**
 * Aggregate 1h Binance klines → daily candles (UTC midnight to midnight).
 */
async function fetchDailyCandles(symbol, days = 30) {
  const limit = Math.min(days * 24 + 2, 500);
  const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=${limit}`;
  const raw   = await fetchJSON(url);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`Empty response for ${symbol}`);

  const dailyMap = new Map();
  for (const k of raw) {
    const openTime = Number(k[0]);
    const open     = parseFloat(k[1]);
    const high     = parseFloat(k[2]);
    const low      = parseFloat(k[3]);
    const close    = parseFloat(k[4]);
    const volume   = parseFloat(k[5]);
    const d        = new Date(openTime);
    const dayKey   = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;

    if (!dailyMap.has(dayKey)) {
      dailyMap.set(dayKey, { date: new Date(dayKey * 1000).toISOString().slice(0,10), open, high, low, close, volume, trades: 1 });
    } else {
      const e = dailyMap.get(dayKey);
      e.high   = Math.max(e.high, high);
      e.low    = Math.min(e.low, low);
      e.close  = close;
      e.volume += volume;
      e.trades++;
    }
  }

  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  log(`  ${symbol}: ${daily.length} daily candles (${daily[0]?.date} → ${daily[daily.length-1]?.date})`);
  return daily;
}

// ─────────────────────────────────────────────────────────────
// State Persistence
// ─────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) { log(`State load error: ${e.message}`, 'WARN'); }
  return null;
}

function saveState(state) {
  try {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) { log(`State save error: ${e.message}`, 'ERROR'); }
}

function loadAssetState(asset) {
  const p = path.join(ASSET_LOG_DIR, `${asset}-state.json`);
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {}
  return null;
}

function saveAssetState(asset, state) {
  const p = path.join(ASSET_LOG_DIR, `${asset}-state.json`);
  try { fs.writeFileSync(p, JSON.stringify(state, null, 2)); } catch (e) { log(`Asset state save error (${asset}): ${e.message}`, 'ERROR'); }
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
    this.initialCapital  = CONFIG.initialCapital;
    
    // Trading state
    this.inPosition    = false;
    this.entryPrice    = 0;
    this.peakPrice     = 0;
    this.trades        = 0;
    this.realizedPnL   = 0;
    this.cumFees       = 0;
    this.lastEvent     = 'INIT';
    
    // Current market price for equity tracking
    this.currentPrice  = 0;
    
    // Re-entry tracking
    this.tenDayHigh    = 0;
    this.tenDayPrices  = [];
    this.daysSinceExit = 0;
    
    // Alert deduplication
    this._lastAlertEvent = null;
    this._alertSilence   = 0;
  }
  
  hydrate(state) {
    this.inPosition    = state.inPosition    ?? false;
    this.entryPrice   = state.entryPrice    ?? 0;
    this.peakPrice    = state.peakPrice     ?? 0;
    this.trades        = state.trades        ?? 0;
    this.realizedPnL  = state.realizedPnL  ?? 0;
    this.cumFees      = state.cumFees       ?? 0;
    this.lastEvent    = state.lastEvent     ?? 'INIT';
    this.tenDayHigh   = state.tenDayHigh    ?? 0;
    this.tenDayPrices = state.tenDayPrices  ?? [];
    this.daysSinceExit = state.daysSinceExit ?? 0;
    this.currentPrice = state.currentPrice  ?? 0;
  }
  
  dehydrate() {
    return {
      inPosition:    this.inPosition,
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
  
  updateCurrentPrice(price) { this.currentPrice = price; }
  
  /**
   * Process a CLOSED daily candle. Signals ONLY evaluated here.
   * Returns signal object or null.
   */
  processClosedCandle(candle) {
    const close = candle.close;
    const date  = candle.date;
    
    // Always update rolling 10d window
    this.tenDayPrices.push(close);
    if (this.tenDayPrices.length > this.reentryLookback) this.tenDayPrices.shift();
    const window10dHigh = Math.max(...this.tenDayPrices);
    
    if (!this.inPosition) {
      // ── FLAT: check re-entry ──
      if (this.daysSinceExit > 0 && close > this.tenDayHigh) {
        // ENTRY
        this.inPosition    = true;
        this.entryPrice    = close;
        this.peakPrice     = close;
        this.trades++;
        this.lastEvent     = 'ENTRY';
        this.daysSinceExit = 0;
        this.tenDayHigh    = 0;
        this.tenDayPrices  = [close];
        
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
        this.daysSinceExit++;
        this.tenDayHigh = Math.max(this.tenDayHigh || 0, close);
        this.lastEvent  = 'FLAT';
        return null;
      }
    } else {
      // ── IN POSITION: update peak + trailing stop ──
      this.peakPrice = Math.max(this.peakPrice, close);
      const trailLevel = this.peakPrice * (1 - this.trailPct);
      
      if (close < trailLevel) {
        // EXIT — trailing stop triggered
        const grossReturn = (close - this.entryPrice) / this.entryPrice;
        const fee         = close * (this.feePct / 100);
        const netReturn   = grossReturn - fee / this.entryPrice;
        
        this.realizedPnL += netReturn;
        this.cumFees     += fee;
        this.inPosition    = false;
        this.lastEvent     = 'EXIT';
        this.daysSinceExit = 0;
        this.tenDayHigh    = window10dHigh;
        this.tenDayPrices  = [];
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
        this.lastEvent = 'HOLD';
        return null;
      }
    }
  }
  
  _alert(signal) {
    if (this._alertSilence > 0) { this._alertSilence--; return; }
    if (this._lastAlertEvent === signal.action) { this._alertSilence = 2; return; }
    this._lastAlertEvent = signal.action;
    
    const pnlStr = signal.return !== null
      ? ` | PnL: ${(signal.return*100).toFixed(2)}% | Total: ${(this.realizedPnL*100).toFixed(2)}%`
      : '';
    logAlert(this.asset, `${signal.action === 'BUY' ? '🟢 BUY' : '🔴 SELL'}`, 
      `${signal.date} @ ${signal.price.toFixed(4)} | ${signal.reason}${pnlStr}`);
    
    // Structured signal log
    logSignal(this.asset, {
      ...signal,
      realizedPct: this.realizedPnL,
      trades: this.trades,
    });
  }
  
  getTrailLevel() { return this.inPosition ? this.peakPrice * (1 - this.trailPct) : 0; }
  
  distanceToStopPct() {
    if (!this.inPosition || this.currentPrice === 0) return null;
    return ((this.currentPrice - this.getTrailLevel()) / this.currentPrice) * 100;
  }
  
  unrealizedPnL() {
    if (!this.inPosition || this.currentPrice === 0 || this.entryPrice === 0) return 0;
    return (this.currentPrice - this.entryPrice) / this.entryPrice;
  }
  
  currentEquity() {
    return this.initialCapital * (1 + this.realizedPnL + this.unrealizedPnL());
  }
  
  statusRow() {
    const unreal       = this.unrealizedPnL();
    const unrealPct    = unreal * 100;
    const unrealEUR    = unreal * this.initialCapital;
    const realizedPct  = this.realizedPnL * 100;
    const realizedEUR  = this.realizedPnL * this.initialCapital;
    const trail        = this.getTrailLevel();
    const distPct      = this.distanceToStopPct();
    const tenDayStr    = (!this.inPosition && this.tenDayHigh > 0)
      ? ` | 10d high: ${this.tenDayHigh.toFixed(2)}`
      : '';
    
    return {
      asset:         this.asset,
      position:      this.inPosition ? 'LONG' : 'FLAT',
      currentPrice:  this.currentPrice,
      peakPrice:     this.peakPrice,
      trailLevel:    trail,
      distToStopPct: distPct,
      equity:        this.currentEquity(),
      unrealizedPct,
      unrealizedEUR,
      realizedPct,
      realizedEUR,
      lastEvent:     this.lastEvent,
      trades:        this.trades,
      cumFees:       this.cumFees,
      tenDayInfo:    tenDayStr,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Paper Trading Engine
// ─────────────────────────────────────────────────────────────

class PaperEngine {
  constructor() {
    this.strategies    = {};
    this.lastPrices    = {};
    this.lastDailyDate = {};
    this.startedAt     = new Date().toISOString();
    
    for (const asset of CONFIG.assets) {
      this.strategies[asset]    = new RO15Strategy(asset);
      this.lastPrices[asset]    = 0;
      this.lastDailyDate[asset] = null;
    }
  }
  
  async initialize() {
    log('═'.repeat(78));
    log('RO15 LIVE SHADOW VALIDATOR — v3 initializing');
    log(`Assets: ${CONFIG.assets.join(', ')}`);
    log(`Spec: trail=${CONFIG.trailPct*100}% | fee=${CONFIG.feePct}% | slippage=0%`);
    log(`Re-entry: price > ${CONFIG.reentryLookback}d high | Mode: SHADOW ONLY (no real orders)`);
    log(`Poll interval: ${CONFIG.pollIntervalMs/1000/60}min | Signals: DAILY CANDLE CLOSES ONLY`);
    log(`Log retention: ${CONFIG.logRetentionDays} days | Signal log max: ${CONFIG.signalLogMaxLines} lines`);
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
      
      const latestCandle        = daily[daily.length - 1];
      const latestPrice         = latestCandle.close;
      this.lastPrices[asset]    = latestPrice;
      this.lastDailyDate[asset] = latestCandle.date;
      
      const saved = loadAssetState(asset);
      if (saved) {
        log(`  ${asset}: restoring state from disk`);
        this.strategies[asset].hydrate(saved);
        this.strategies[asset].updateCurrentPrice(latestPrice);
        
        // If still in position, update peak with any recent new highs
        if (this.strategies[asset].inPosition) {
          for (const c of daily.slice(-5)) {
            this.strategies[asset].peakPrice = Math.max(
              this.strategies[asset].peakPrice, c.close
            );
          }
        }
      } else {
        log(`  ${asset}: cold start — processing ${daily.length} historical daily candles`);
        
        for (const candle of daily) {
          this.strategies[asset].processClosedCandle(candle);
        }
        
        // Research spec: always start IN position
        const s = this.strategies[asset];
        if (!s.inPosition && daily.length > 0) {
          s.inPosition   = true;
          s.entryPrice   = latestPrice;
          s.peakPrice    = latestPrice;
          s.currentPrice = latestPrice;
          s.tenDayPrices = daily.slice(-CONFIG.reentryLookback).map(c => c.close);
          s.tenDayHigh   = Math.max(...s.tenDayPrices);
          s.trades++;
          s.lastEvent    = 'ENTRY';
          logAlert(asset, '🟢 BUY (cold start)', `forced entry @ ${latestPrice.toFixed(4)}`);
        } else {
          s.currentPrice = latestPrice;
        }
      }
      
      saveAssetState(asset, this.strategies[asset].dehydrate());
    }
    
    saveState({
      assets:     CONFIG.assets,
      trailPct:   CONFIG.trailPct,
      startedAt:  this.startedAt,
      lastUpdate: new Date().toISOString(),
      lastPrices: this.lastPrices,
    });
    
    this.rollingCleanup();
    this.printDailySummary();
    log('Initialization complete. Live polling active in SHADOW MODE.');
  }
  
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
        if (this.strategies[asset].currentPrice === 0) {
          this.strategies[asset].currentPrice = this.lastPrices[asset];
        }
        continue;
      }
      
      const latestCandle = daily[daily.length - 1];
      const prevCandle   = daily[daily.length - 2];
      const latestDate   = latestCandle.date;
      const lastKnown    = this.lastDailyDate[asset];
      
      if (latestDate !== lastKnown && prevCandle) {
        // New closed candle!
        anyNewCandle = true;
        log(`  ${asset}: 📅 new closed candle ${prevCandle.date} (was ${lastKnown})`);
        
        const signal = this.strategies[asset].processClosedCandle(prevCandle);
        this.lastDailyDate[asset] = prevCandle.date;
        this.lastPrices[asset]   = prevCandle.close;
        this.strategies[asset].currentPrice = prevCandle.close;
        
        if (signal) {
          log(`  ${asset}: ⚡ SIGNAL → ${signal.action} | ${signal.reason}`);
        }
        
        // Track today's ongoing candle for peak updates (no signal)
        if (latestCandle.close !== prevCandle.close) {
          this.strategies[asset].peakPrice = Math.max(
            this.strategies[asset].peakPrice, latestCandle.close
          );
          this.strategies[asset].currentPrice = latestCandle.close;
          this.lastPrices[asset] = latestCandle.close;
        }
      } else {
        // Same day — just update current price
        this.strategies[asset].currentPrice = latestCandle.close;
        this.lastPrices[asset]             = latestCandle.close;
        log(`  ${asset}: ⏳ ${latestDate} (no new candle yet) | price: ${latestCandle.close.toFixed(4)}`);
      }
      
      saveAssetState(asset, this.strategies[asset].dehydrate());
    }
    
    this.rollingCleanup();
    
    saveState({
      assets:     CONFIG.assets,
      trailPct:   CONFIG.trailPct,
      startedAt:  this.startedAt,
      lastUpdate: new Date().toISOString(),
      lastPrices: this.lastPrices,
    });
    
    if (!anyNewCandle) {
      log(`  (no new closed candles this poll — signals skipped)`);
    }
    
    this.printDailySummary();
    this.writeDailySnapshot();
  }
  
  printDailySummary() {
    const totalEquity = CONFIG.assets.reduce((s, a) => s + this.strategies[a].currentEquity(), 0);
    const today      = new Date().toISOString().slice(0,10);
    const uptimeH    = ((Date.now() - new Date(this.startedAt).getTime()) / 3600000).toFixed(1);
    
    log('');
    log('┌──────────────────────────────────────────────────────────────────────────────────────────────┐');
    log(`│  RO15 SHADOW MONITOR  |  ${today}  |  SHADOW MODE  |  uptime: ${uptimeH}h  │`);
    log('├──────────┬────────┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────────────────┤');
    log('│ ASSET    │ POS    │ PRICE    │ PEAK     │ TRAIL    │ DIST     │ EQUITY   │ LAST EVENT          │');
    log('├──────────┼────────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────────────────┤');
    
    for (const asset of CONFIG.assets) {
      const s   = this.strategies[asset];
      const row = s.statusRow();
      
      const priceStr  = row.currentPrice > 0 ? row.currentPrice.toFixed(2) : '—';
      const peakStr   = row.peakPrice    > 0 ? row.peakPrice.toFixed(2)    : '—';
      const trailStr  = row.trailLevel   > 0 ? row.trailLevel.toFixed(2)    : '—';
      const distStr   = row.distToStopPct !== null ? `${row.distToStopPct.toFixed(1)}%` : '—';
      
      log(`│ ${asset.padEnd(8)} │ ${row.position.padEnd(4)} │ ${priceStr.padEnd(8)} │ ${peakStr.padEnd(8)} │ ${trailStr.padEnd(8)} │ ${distStr.padEnd(8)} │ ${row.equity.toFixed(2).padStart(8)} € │ ${row.lastEvent.padEnd(19)} │`);
      
      if (row.position === 'LONG') {
        const unrealSign = row.unrealizedPct >= 0 ? '+' : '';
        const realSign   = row.realizedPct   >= 0 ? '+' : '';
        log(`│          │ unrealized: ${unrealSign}${row.unrealizedPct.toFixed(2)}% (${row.unrealizedEUR >= 0 ? '+' : ''}${row.unrealizedEUR.toFixed(2)} €) | realized: ${realSign}${row.realizedPct.toFixed(2)}% | trades: ${row.trades}`.padEnd(92) + '│');
      } else {
        const realSign = row.realizedPct >= 0 ? '+' : '';
        log(`│          │ realized: ${realSign}${row.realizedPct.toFixed(2)}% (${row.realizedEUR >= 0 ? '+' : ''}${row.realizedEUR.toFixed(2)} €) | trades: ${row.trades}${row.tenDayInfo}`.padEnd(92) + '│');
      }
    }
    
    log('├──────────┴────────┴──────────┴──────────┴──────────┴──────────┴──────────┴─────────────────────┤');
    log(`│  TOTAL PORTFOLIO: ${totalEquity.toFixed(2)} €  |  started: ${this.startedAt.slice(0,10)}  |  validation period: 2–4 weeks  │`);
    log('└────────────────────────────────────────────────────────────────────────────────────────────────────┘');
  }
  
  writeDailySnapshot() {
    const date     = new Date().toISOString().slice(0,10);
    const dailyCsv = path.join(DAILY_DIR, `summary-${date}.csv`);
    const headers  = ['timestamp','asset','position','currentPrice','peakPrice','trailLevel',
                      'distToStopPct','equityEUR','unrealizedPct','unrealizedEUR','realizedPct',
                      'realizedEUR','lastEvent','trades','cumFees'];
    const headerLine = headers.join(',');
    
    for (const asset of CONFIG.assets) {
      const s   = this.strategies[asset];
      const row = s.statusRow();
      
      const rowData = [
        new Date().toISOString(),
        asset,
        row.position,
        row.currentPrice.toFixed(4),
        row.peakPrice.toFixed(4),
        row.trailLevel.toFixed(4),
        row.distToStopPct !== null ? row.distToStopPct.toFixed(4) : '',
        row.equity.toFixed(2),
        row.unrealizedPct.toFixed(4),
        row.unrealizedEUR.toFixed(2),
        row.realizedPct.toFixed(4),
        row.realizedEUR.toFixed(2),
        row.lastEvent,
        row.trades,
        s.cumFees.toFixed(4),
      ].join(',');
      
      if (!fs.existsSync(dailyCsv)) fs.writeFileSync(dailyCsv, headerLine + '\n');
      fs.appendFileSync(dailyCsv, rowData + '\n');
    }
  }
  
  // ─────────────────────────────────────────────────────────────
  // Rolling Log Cleanup
  // ─────────────────────────────────────────────────────────────
  
  rollingCleanup() {
    const now      = Date.now();
    const maxAgeMs = CONFIG.logRetentionDays * 24 * 3600 * 1000;
    const maxLines = CONFIG.signalLogMaxLines;
    
    // Cleanup validator log files (keep last N days)
    try {
      const validatorLogs = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('validator-') && f.endsWith('.log'));
      for (const f of validatorLogs) {
        const fpath = path.join(LOG_DIR, f);
        const ageMs = now - fs.statSync(fpath).mtimeMs;
        if (ageMs > maxAgeMs) { fs.unlinkSync(fpath); log(`Cleaned up old log: ${f}`); }
      }
    } catch(e) {}
    
    // Cleanup old daily CSV files
    try {
      const dailyFiles = fs.readdirSync(DAILY_DIR).filter(f => f.startsWith('summary-') && f.endsWith('.csv'));
      for (const f of dailyFiles) {
        const fpath = path.join(DAILY_DIR, f);
        const ageMs = now - fs.statSync(fpath).mtimeMs;
        if (ageMs > maxAgeMs) { fs.unlinkSync(fpath); log(`Cleaned up old daily CSV: ${f}`); }
      }
    } catch(e) {}
    
    // Rotate signal log if too many lines
    try {
      if (fs.existsSync(SIGNAL_LOG)) {
        const lines = fs.readFileSync(SIGNAL_LOG, 'utf8').split('\n').filter(l => l.trim());
        if (lines.length > maxLines) {
          const rotated = SIGNAL_LOG.replace('.csv', `-${new Date().toISOString().slice(0,10)}.csv`);
          fs.writeFileSync(rotated, lines.join('\n') + '\n');
          fs.writeFileSync(SIGNAL_LOG, lines[0] + '\n' + lines.slice(-(maxLines / 2)).join('\n') + '\n');
          log(`Signal log rotated: ${lines.length} → ${maxLines/2} lines`);
        }
      }
    } catch(e) {}
  }
  
  startLive() {
    log(`\n=== Live polling started (SHADOW MODE) ===`);
    log(`Interval: every ${CONFIG.pollIntervalMs / 1000 / 60} minutes`);
    log(`Signals: evaluated ONLY at daily candle closes`);
    log(`Log retention: ${CONFIG.logRetentionDays} days | Signal log max: ${CONFIG.signalLogMaxLines} lines`);
    log(`State files: logs/state.json + logs/assets/{BTC,ETH}-state.json (restart-safe)`);
    
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
RO15 Live Shadow-Mode Validator v3

Usage:
  node ro15-live-validator.mjs --live   ← continuous hourly polling (PM2)
  node ro15-live-validator.mjs --once   ← single poll and exit (cron)
  node ro15-live-validator.mjs --help   ← this help

Mode: SHADOW ONLY — no real orders. Only signals, state, and logging.

State recovery: restart-safe.
  logs/state.json                   — global state
  logs/assets/{BTC,ETH}-state.json   — per-asset trading state
  logs/signals.csv                  — structured signal log

Logs:
  logs/validator-YYYY-MM-DD.log      — daily console log
  logs/daily/summary-YYYY-MM-DD.csv  — daily equity snapshots
  logs/alerts/{BTC,ETH}-alerts.log   — entry/exit events
  logs/signals.csv                   — all signals (CSV)
  logs/signals-YYYY-MM-DD.csv        — rotated signal archives

Rolling cleanup: logs older than ${CONFIG.logRetentionDays} days auto-deleted.
Signal log auto-rotates at ${CONFIG.signalLogMaxLines} lines.

PM2:
  pm2 start ro15-live-validator.mjs --name ro15-live -- --live
  pm2 save
  pm2 logs ro15-live

Systemd:
  sudo systemctl enable /path/to/ro15-live.service
  sudo systemctl start ro15-live
  journalctl -u ro15-live -f

Cron (one-shot hourly):
  0 * * * * cd /path/to/crypto-live-validator && node ro15-live-validator.mjs --once
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
      log('One-shot mode. Daily check complete.');
      process.exit(0);
    }
  } catch(e) {
    log(`FATAL: ${e.message}`, 'ERROR');
    process.exit(1);
  }
}

main();