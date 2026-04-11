#!/usr/bin/env node
/**
 * RO15 Live Shadow-Mode Validator — Production Build v2
 * 
 * Strategy (exact research spec — DO NOT CHANGE):
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
 *       ├── daily/
 *       │   └── summary-YYYY-MM-DD.csv   ← daily equity snapshots
 *       ├── assets/
 *       │   ├── BTC-state.json           ← BTC full trading state
 *       │   └── ETH-state.json           ← ETH full trading state
 *       └── alerts/
 *           ├── BTC-alerts.log            ← BTC entry/exit events
 *           └── ETH-alerts.log            ← ETH entry/exit events
 * 
 * State recovery (restart-safe):
 *   On restart, loadAssetState() restores inPosition/entryPrice/peakPrice/
 *   trades/realizedPnL from logs/assets/{ASSET}-state.json.
 *   tenDayPrices and tenDayHigh also persisted — re-entry continuous.
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

const CONFIG = {
  assets: ['BTC', 'ETH'],
  trailPct:        0.15,
  reentryLookback: 10,
  feePct:          0.15,
  slippagePct:     0,
  pollIntervalMs:  60 * 60 * 1000,
  lookbackDays:    30,
  initialCapital:  10000,
  apiRetries:      3,
  apiRetryDelayMs: 5000,
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
  const line = `[${new Date().toISOString()}] [ALERT] ${asset}: ${event} — ${details}`;
  console.log(`  ${line}`);
  fs.appendFileSync(path.join(ALERTS_DIR, `${asset}-alerts.log`), line + '\n');
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
      e.high = Math.max(e.high, high); e.low = Math.min(e.low, low);
      e.close = close; e.volume += volume; e.trades++;
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
  try { return fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : null; }
  catch (e) { log(`State load error: ${e.message}`, 'WARN'); return null; }
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
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
  catch (e) { return null; }
}

function saveAssetState(asset, state) {
  const p = path.join(ASSET_LOG_DIR, `${asset}-state.json`);
  try { fs.writeFileSync(p, JSON.stringify(state, null, 2)); }
  catch (e) { log(`Asset state save error (${asset}): ${e.message}`, 'ERROR'); }
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
    this.slippagePct     = CONFIG.slippagePct;
    this.initialCapital  = CONFIG.initialCapital;

    this.inPosition    = false;
    this.entryPrice    = 0;
    this.peakPrice     = 0;
    this.trades        = 0;
    this.realizedPnL   = 0;
    this.cumFees       = 0;
    this.lastEvent     = 'INIT';
    this.currentPrice  = 0;
    this.tenDayHigh    = 0;
    this.tenDayPrices  = [];
    this.daysSinceExit = 0;

    this._lastAlertEvent = null;
    this._alertSilence   = 0;
  }

  hydrate(s) {
    this.inPosition    = s?.inPosition    ?? false;
    this.entryPrice   = s?.entryPrice    ?? 0;
    this.peakPrice    = s?.peakPrice     ?? 0;
    this.trades        = s?.trades        ?? 0;
    this.realizedPnL  = s?.realizedPnL  ?? 0;
    this.cumFees      = s?.cumFees       ?? 0;
    this.lastEvent    = s?.lastEvent     ?? 'INIT';
    this.tenDayHigh   = s?.tenDayHigh    ?? 0;
    this.tenDayPrices = Array.isArray(s?.tenDayPrices) ? s.tenDayPrices.slice(-this.reentryLookback) : [];
    this.daysSinceExit = s?.daysSinceExit ?? 0;
    this.currentPrice = s?.currentPrice  ?? 0;
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
   * Process a closed daily candle. Signals ONLY evaluated here.
   */
  processClosedCandle(candle) {
    const close = candle.close;
    const date  = candle.date;

    // Always roll the 10d window
    this.tenDayPrices.push(close);
    if (this.tenDayPrices.length > this.reentryLookback) this.tenDayPrices.shift();
    const window10dHigh = this.tenDayPrices.length > 0 ? Math.max(...this.tenDayPrices) : close;

    if (!this.inPosition) {
      // FLAT — check re-entry
      if (this.daysSinceExit > 0 && close > this.tenDayHigh) {
        this.inPosition    = true;
        this.entryPrice    = close;
        this.peakPrice     = close;
        this.trades++;
        this.lastEvent     = 'ENTRY';
        this.daysSinceExit = 0;
        this.tenDayHigh    = 0;
        this.tenDayPrices  = [close];
        const sig = { action: 'BUY', price: close, date, return: null,
          reason: `re-entry (>${this.reentryLookback}d high ${this.tenDayHigh.toFixed(2)})` };
        this._alert(sig); return sig;
      } else {
        this.daysSinceExit++;
        this.tenDayHigh = Math.max(this.tenDayHigh || 0, close);
        this.lastEvent  = 'FLAT'; return null;
      }
    } else {
      // IN POSITION — update peak, check trailing stop
      this.peakPrice = Math.max(this.peakPrice, close);
      const trailLevel = this.peakPrice * (1 - this.trailPct);
      if (close < trailLevel) {
        const grossReturn = (close - this.entryPrice) / this.entryPrice;
        const fee          = close * (this.feePct / 100);
        const netReturn    = grossReturn - fee / this.entryPrice;
        this.realizedPnL  += netReturn;
        this.cumFees      += fee;
        this.inPosition    = false;
        this.lastEvent     = 'EXIT';
        this.daysSinceExit = 0;
        this.tenDayHigh    = window10dHigh;
        this.tenDayPrices  = [];
        const exitedPeak   = this.peakPrice;
        this.peakPrice     = 0; this.entryPrice = 0;
        const sig = { action: 'SELL', price: close, date, return: netReturn,
          reason: `trailing stop (peak ${exitedPeak.toFixed(2)}, trail ${trailLevel.toFixed(2)})` };
        this._alert(sig); return sig;
      } else {
        this.lastEvent = 'HOLD'; return null;
      }
    }
  }

  _alert(sig) {
    if (this._alertSilence > 0) { this._alertSilence--; return; }
    if (this._lastAlertEvent === sig.action) { this._alertSilence = 2; return; }
    this._lastAlertEvent = sig.action;
    const pnlStr = sig.return !== null
      ? ` | PnL: ${(sig.return*100).toFixed(2)}% | Total: ${(this.realizedPnL*100).toFixed(2)}%` : '';
    logAlert(this.asset, sig.action === 'BUY' ? '🟢 BUY' : '🔴 SELL', `${sig.date} @ ${sig.price.toFixed(4)} | ${sig.reason}${pnlStr}`);
  }

  // ── Monitoring helpers ──

  trailLevel()    { return this.inPosition ? this.peakPrice * (1 - this.trailPct) : 0; }
  distToStop()    { return this.inPosition && this.currentPrice > 0 ? ((this.currentPrice - this.trailLevel()) / this.currentPrice) * 100 : null; }
  unrealizedPct() { return (this.inPosition && this.entryPrice > 0 && this.currentPrice > 0) ? ((this.currentPrice - this.entryPrice) / this.entryPrice) * 100 : 0; }
  unrealizedEUR() { return (this.unrealizedPct() / 100) * this.initialCapital; }
  realizedPct()   { return this.realizedPnL * 100; }
  realizedEUR()   { return this.realizedPnL * this.initialCapital; }
  equity()        { return this.initialCapital * (1 + this.realizedPnL + this.unrealizedPct() / 100); }
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
    for (const a of CONFIG.assets) {
      this.strategies[a]    = new RO15Strategy(a);
      this.lastPrices[a]    = 0;
      this.lastDailyDate[a] = null;
    }
  }

  async initialize() {
    log('═'.repeat(78));
    log('RO15 LIVE SHADOW VALIDATOR — initializing');
    log(`Assets: ${CONFIG.assets.join(', ')}`);
    log(`Spec: trail=${CONFIG.trailPct*100}% | fee=${CONFIG.feePct}% | slippage=${CONFIG.slippagePct}%`);
    log(`Re-entry: price > ${CONFIG.reentryLookback}d high | Mode: SHADOW ONLY`);
    log(`Poll: every ${CONFIG.pollIntervalMs/1000/60} min | Signals: DAILY CANDLE CLOSES ONLY`);
    log('═'.repeat(78));

    for (const asset of CONFIG.assets) {
      let daily;
      try { daily = await fetchDailyCandles(asset, CONFIG.lookbackDays); }
      catch(e) { log(`FATAL: Cannot fetch ${asset}: ${e.message}`, 'ERROR'); throw e; }

      const latestCandle        = daily[daily.length - 1];
      this.lastPrices[asset]    = latestCandle.close;
      this.lastDailyDate[asset] = latestCandle.date;

      const saved = loadAssetState(asset);
      if (saved) {
        log(`  ${asset}: restoring state from disk`);
        this.strategies[asset].hydrate(saved);
        this.strategies[asset].updateCurrentPrice(latestCandle.close);
        // Sync peak with any new highs since last poll
        if (this.strategies[asset].inPosition) {
          for (const c of daily.slice(-5)) {
            this.strategies[asset].peakPrice = Math.max(this.strategies[asset].peakPrice, c.close);
          }
        }
      } else {
        log(`  ${asset}: cold start — processing ${daily.length} historical candles`);
        for (const c of daily) this.strategies[asset].processClosedCandle(c);
        const s = this.strategies[asset];
        if (!s.inPosition) {
          s.inPosition = true; s.entryPrice = latestCandle.close; s.peakPrice = latestCandle.close;
          s.currentPrice = latestCandle.close;
          s.tenDayPrices = daily.slice(-CONFIG.reentryLookback).map(c => c.close);
          s.tenDayHigh = Math.max(...s.tenDayPrices);
          s.trades++; s.lastEvent = 'ENTRY';
          logAlert(asset, '🟢 BUY (cold start)', `forced entry @ ${latestCandle.close.toFixed(4)}`);
        }
      }
      saveAssetState(asset, this.strategies[asset].dehydrate());
    }

    saveState({ assets: CONFIG.assets, trailPct: CONFIG.trailPct, startedAt: this.startedAt,
                lastUpdate: new Date().toISOString(), lastPrices: this.lastPrices });
    this.printDailySummary();
    log('Initialization complete. Live polling active in SHADOW MODE.');
  }

  async poll() {
    log(`\n${'─'.repeat(78)}`);
    log(`POLL @ ${new Date().toISOString()}`);
    let anyNew = false;

    for (const asset of CONFIG.assets) {
      let daily;
      try { daily = await fetchDailyCandles(asset, 3); }
      catch(e) { log(`  ${asset}: API error — ${e.message}`, 'ERROR'); continue; }

      const latestCandle = daily[daily.length - 1];
      const prevCandle   = daily[daily.length - 2];
      const latestDate   = latestCandle.date;
      const lastKnown    = this.lastDailyDate[asset];

      if (latestDate !== lastKnown && prevCandle) {
        anyNew = true;
        log(`  ${asset}: 📅 new closed candle ${prevCandle.date} (was ${lastKnown})`);
        const sig = this.strategies[asset].processClosedCandle(prevCandle);
        this.lastDailyDate[asset] = prevCandle.date;
        this.lastPrices[asset]    = prevCandle.close;
        this.strategies[asset].currentPrice = prevCandle.close;
        if (sig) log(`  ${asset}: ⚡ SIGNAL → ${sig.action} | ${sig.reason}`);
        // Track today's in-progress candle for peak (no signal)
        if (latestCandle.close !== prevCandle.close) {
          this.strategies[asset].peakPrice = Math.max(this.strategies[asset].peakPrice, latestCandle.close);
          this.strategies[asset].currentPrice = latestCandle.close;
          this.lastPrices[asset] = latestCandle.close;
        }
      } else {
        this.strategies[asset].currentPrice = latestCandle.close;
        this.lastPrices[asset]             = latestCandle.close;
        log(`  ${asset}: ⏳ ${latestDate} (no new candle yet) | price: ${latestCandle.close.toFixed(4)}`);
      }
      saveAssetState(asset, this.strategies[asset].dehydrate());
    }

    saveState({ assets: CONFIG.assets, trailPct: CONFIG.trailPct, startedAt: this.startedAt,
                lastUpdate: new Date().toISOString(), lastPrices: this.lastPrices });
    if (!anyNew) log('  (no new closed candles — signals skipped)');
    this.printDailySummary();
    this.writeDailySnapshot();
  }

  printDailySummary() {
    const total = CONFIG.assets.reduce((s, a) => s + this.strategies[a].equity(), 0);
    const today = new Date().toISOString().slice(0,10);

    log('');
    log('┌──────────────────────────────────────────────────────────────────────────────────────────────┐');
    log(`│  RO15 SHADOW MONITOR  |  ${today}  |  SHADOW MODE                                           │`);
    log('├──────────┬────────┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────────────────┤');
    log('│ ASSET    │ POS    │ PRICE    │ PEAK     │ TRAIL    │ DIST     │ EQUITY   │ LAST EVENT          │');
    log('├──────────┼────────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────────────────┤');

    for (const asset of CONFIG.assets) {
      const s   = this.strategies[asset];
      const pos = s.inPosition ? 'LONG' : 'FLAT';
      const priceStr  = s.currentPrice > 0 ? s.currentPrice.toFixed(2)          : '—';
      const peakStr   = s.peakPrice    > 0 ? s.peakPrice.toFixed(2)             : '—';
      const trailStr  = s.trailLevel() > 0 ? s.trailLevel().toFixed(2)         : '—';
      const distStr   = s.distToStop() !== null ? `${s.distToStop().toFixed(1)}%` : '—';

      log(`│ ${asset.padEnd(8)} │ ${pos.padEnd(4)} │ ${priceStr.padEnd(8)} │ ${peakStr.padEnd(8)} │ ${trailStr.padEnd(8)} │ ${distStr.padEnd(8)} │ ${s.equity().toFixed(2).padStart(8)} € │ ${s.lastEvent.padEnd(19)} │`);

      if (s.inPosition) {
        const uPct = s.unrealizedPct(), uEUR = s.unrealizedEUR();
        const rPct = s.realizedPct(),   rEUR = s.realizedEUR();
        const uSign = uPct >= 0 ? '+' : '';
        const rSign = rPct >= 0 ? '+' : '';
        log(`│          │ unrealized: ${uSign}${uPct.toFixed(2)}% (${uEUR >= 0 ? '+' : ''}${uEUR.toFixed(2)} €) | realized: ${rSign}${rPct.toFixed(2)}% | trades: ${s.trades}`.padEnd(92) + ' │');
      } else {
        const rPct = s.realizedPct(), rEUR = s.realizedEUR();
        const rSign = rPct >= 0 ? '+' : '';
        const tenDayStr = s.tenDayHigh > 0 ? ` | 10d high: ${s.tenDayHigh.toFixed(2)}` : '';
        log(`│          │ realized: ${rSign}${rPct.toFixed(2)}% (${rEUR >= 0 ? '+' : ''}${rEUR.toFixed(2)} €) | trades: ${s.trades}${tenDayStr}`.padEnd(92) + ' │');
      }
    }

    log('├──────────┴────────┴──────────┴──────────┴──────────┴──────────┴──────────┴─────────────────────┤');
    log(`│  TOTAL PORTFOLIO: ${total.toFixed(2)} €  |  started: ${this.startedAt.slice(0,10)}  |  validation period: 2–4 weeks  │`);
    log('└────────────────────────────────────────────────────────────────────────────────────────────────────┘');
  }

  writeDailySnapshot() {
    const date     = new Date().toISOString().slice(0,10);
    const csvPath   = path.join(DAILY_DIR, `summary-${date}.csv`);
    const headers   = ['timestamp','asset','position','currentPrice','peakPrice','trailLevel',
                       'distToStopPct','equityEUR','unrealizedPct','unrealizedEUR','realizedPct',
                       'realizedEUR','lastEvent','trades','cumFees'];
    const headerLine = headers.join(',');

    for (const asset of CONFIG.assets) {
      const s = this.strategies[asset];
      const row = [
        new Date().toISOString(), asset,
        s.inPosition ? 'LONG' : 'FLAT',
        s.currentPrice.toFixed(4),
        s.peakPrice.toFixed(4),
        s.trailLevel().toFixed(4),
        s.distToStop() !== null ? s.distToStop().toFixed(4) : '',
        s.equity().toFixed(2),
        s.unrealizedPct().toFixed(4),
        s.unrealizedEUR().toFixed(2),
        s.realizedPct().toFixed(4),
        s.realizedEUR().toFixed(2),
        s.lastEvent, s.trades, s.cumFees.toFixed(4),
      ].join(',');
      if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, headerLine + '\n');
      fs.appendFileSync(csvPath, row + '\n');
    }
  }

  startLive() {
    log(`\n=== Live polling started (SHADOW MODE) ===`);
    log(`Interval: every ${CONFIG.pollIntervalMs / 1000 / 60} minutes`);
    log(`Signals: evaluated ONLY at daily candle closes`);
    this.poll().catch(e => log(`Poll error: ${e.message}`, 'ERROR'));
    setInterval(() => this.poll().catch(e => log(`Poll error: ${e.message}`, 'ERROR')), CONFIG.pollIntervalMs);
  }
}

// ─────────────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
RO15 Live Shadow-Mode Validator

Usage:
  node ro15-live-validator.mjs --live   ← continuous hourly polling (PM2)
  node ro15-live-validator.mjs --once   ← single poll and exit (cron)
  node ro15-live-validator.mjs --help   ← this help

Mode: SHADOW ONLY — no real orders. Only signals, state, logging.

State recovery: restart-safe (logs/assets/{ASSET}-state.json)

Logs:
  logs/validator-YYYY-MM-DD.log   — daily console log
  logs/daily/summary-YYYY-MM-DD.csv — daily equity snapshots
  logs/alerts/{ASSET}-alerts.log  — entry/exit events

PM2:
  pm2 start ro15-live-validator.mjs --name ro15-live -- --live
  pm2 save && pm2 logs ro15-live

Cron (one-shot hourly):
  0 * * * * cd /path/to/crypto-live-validator && node ro15-live-validator.mjs --once
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { printHelp(); return; }

  const engine = new PaperEngine();
  try {
    await engine.initialize();
    if (args.includes('--live')) { engine.startLive(); }
    else { log('One-shot mode complete.'); process.exit(0); }
  } catch(e) {
    log(`FATAL: ${e.message}`, 'ERROR');
    process.exit(1);
  }
}

main();