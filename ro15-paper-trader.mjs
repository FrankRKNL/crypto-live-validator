#!/usr/bin/env node
/**
 * RO15 Live/Paper Trading Validator
 * 
 * Strategy: RiskOverlay-15% trailing stop
 * - Start IN position
 * - Track peak price
 * - Exit when price drops 15% below peak
 * - Re-entry on next candle after exit
 * - Always in market (no cash position)
 * 
 * Data: Binance public API (no API key)
 * Assets: BTC, ETH
 * Timeframe: 1h candles (for more frequent signals)
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, 'logs');
const CSV_PATH = path.join(LOG_DIR, 'ro15-trades.csv');
const STATE_PATH = path.join(LOG_DIR, 'state.json');

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const CONFIG = {
  assets: ['BTC', 'ETH'],
  trailPct: 0.15,           // 15% trailing stop (RO15)
  pollIntervalMs: 60 * 60 * 1000, // 1 hour between checks
  initialCapital: 10000,     // EUR (paper money)
  feePct: 0.1,               // 0.1% trading fee
  slippagePct: 0.05,         // 0.05% slippage
  dataPoints: 168,           // ~7 days of 1h candles for initial load
};

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function formatNumber(n, decimals = 2) {
  return Number(n).toFixed(decimals);
}

/**
 * Fetch JSON from Binance public API
 */
function fetchBinanceKlines(symbol, interval = '1h', limit = 168) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`;
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Binance kline format: [openTime, open, high, low, close, volume, closeTime, ...]
          const candles = parsed.map(k => ({
            openTime: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            closeTime: k[6],
          }));
          resolve(candles);
        } catch (e) {
          reject(new Error(`Failed to parse Binance response: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Get asset symbol for Binance
 */
function getSymbol(asset) {
  const map = { BTC: 'BTC', ETH: 'ETH' };
  return map[asset] || asset;
}

// ─────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (e) {
    log(`Warning: Could not load state: ${e.message}`);
  }
  return null;
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    log(`Error: Could not save state: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// CSV Logging
// ─────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  'timestamp',
  'asset',
  'price',
  'position',
  'peakPrice',
  'trailLevel',
  'equity',
  'unrealizedPnL',
  'realizedPnL',
  'event',
  'tradeReturn',
  'cumFees',
].join(',');

function initCSV() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, CSV_HEADERS + '\n');
    log(`CSV initialized: ${CSV_PATH}`);
  }
}

function appendCSV(row) {
  const values = [
    row.timestamp,
    row.asset,
    formatNumber(row.price, 4),
    row.position ? 'LONG' : 'FLAT',
    formatNumber(row.peakPrice, 4),
    formatNumber(row.trailLevel, 4),
    formatNumber(row.equity, 2),
    formatNumber(row.unrealizedPnL, 2),
    formatNumber(row.realizedPnL, 2),
    row.event,
    row.tradeReturn ? formatNumber(row.tradeReturn * 100, 2) + '%' : '',
    formatNumber(row.cumFees, 2),
  ].join(',');
  fs.appendFileSync(CSV_PATH, values + '\n');
}

// ─────────────────────────────────────────────────────────────
// RO15 Strategy
// ─────────────────────────────────────────────────────────────

/**
 * RO15 Strategy Implementation (exact copy from engine-v3.mjs)
 * 
 * Logic:
 * - Start IN position
 * - Track peak price since entry
 * - Exit when price < peak * (1 - trailPct)
 * - Re-entry immediately on next candle
 * - Always in market
 */
class RO15Strategy {
  constructor(asset, trailPct = 0.15) {
    this.asset = asset;
    this.trailPct = trailPct;
    this.reset();
  }

  reset() {
    this.inPosition = false;
    this.peakPrice = 0;
    this.entryPrice = 0;
    this.trades = 0;
    this.realizedPnL = 0;
    this.cumFees = 0;
    this.lastEvent = 'INIT';
  }

  /**
   * Process a candle and return signal
   */
  processCandle(candle) {
    const { date, price: close } = candle;
    
    if (!this.inPosition) {
      // Entry signal: buy at market
      this.inPosition = true;
      this.entryPrice = close;
      this.peakPrice = close;
      this.trades++;
      this.lastEvent = 'ENTRY';
      
      return {
        action: 'buy',
        price: close,
        date,
        return: null,
      };
    } else {
      // Update peak
      this.peakPrice = Math.max(this.peakPrice, close);
      
      // Check trailing stop
      const trailLevel = this.peakPrice * (1 - this.trailPct);
      
      if (close < trailLevel) {
        // Exit signal: sell
        const ret = (close - this.entryPrice) / this.entryPrice;
        const fees = close * CONFIG.feePct / 100;
        const slippage = close * CONFIG.slippagePct / 100;
        const netReturn = ret - (fees + slippage) / this.entryPrice;
        
        this.realizedPnL += netReturn;
        this.cumFees += fees + slippage;
        this.inPosition = false;
        this.lastEvent = 'EXIT';
        
        const result = {
          action: 'sell',
          price: close,
          date,
          return: netReturn,
        };
        
        // Reset peak for next entry
        this.peakPrice = 0;
        this.entryPrice = 0;
        
        return result;
      } else {
        // Hold
        this.lastEvent = 'HOLD';
        return null;
      }
    }
  }

  getTrailLevel() {
    if (!this.inPosition) return 0;
    return this.peakPrice * (1 - this.trailPct);
  }
}

// ─────────────────────────────────────────────────────────────
// Paper Trading Engine
// ─────────────────────────────────────────────────────────────

class PaperTrader {
  constructor() {
    this.strategies = {};
    this.equity = {};
    this.unrealizedPnL = {};
    this.data = {};
    this.lastPrices = {};
    
    for (const asset of CONFIG.assets) {
      this.strategies[asset] = new RO15Strategy(asset, CONFIG.trailPct);
      this.equity[asset] = CONFIG.initialCapital;
      this.unrealizedPnL[asset] = 0;
    }
  }

  /**
   * Load initial data from Binance
   */
  async loadData() {
    log('Loading market data from Binance...');
    
    for (const asset of CONFIG.assets) {
      const symbol = getSymbol(asset);
      try {
        const candles = await fetchBinanceKlines(symbol, '1h', CONFIG.dataPoints);
        this.data[asset] = candles.map(c => ({
          date: new Date(c.openTime).toISOString(),
          price: c.close,
          high: c.high,
          low: c.low,
          volume: c.volume,
        }));
        this.lastPrices[asset] = candles[candles.length - 1].close;
        log(`  ${asset}: ${candles.length} candles loaded (${candles[0].close} -> ${candles[candles.length - 1].close})`);
      } catch (e) {
        log(`  ERROR loading ${asset}: ${e.message}`);
      }
    }
  }

  /**
   * Process a single candle for an asset
   */
  processCandle(asset, candle) {
    const strategy = this.strategies[asset];
    const signal = strategy.processCandle(candle);
    
    // Calculate unrealized PnL
    const currentPrice = candle.price;
    if (strategy.inPosition) {
      this.unrealizedPnL[asset] = (currentPrice - strategy.entryPrice) / strategy.entryPrice;
    } else {
      this.unrealizedPnL[asset] = 0;
    }
    
    // Calculate equity
    this.equity[asset] = CONFIG.initialCapital * (1 + strategy.realizedPnL + this.unrealizedPnL[asset]);
    
    // Log to CSV
    appendCSV({
      timestamp: candle.date,
      asset,
      price: currentPrice,
      position: strategy.inPosition,
      peakPrice: strategy.peakPrice,
      trailLevel: strategy.getTrailLevel(),
      equity: this.equity[asset],
      unrealizedPnL: this.unrealizedPnL[asset] * CONFIG.initialCapital,
      realizedPnL: strategy.realizedPnL * CONFIG.initialCapital,
      event: strategy.lastEvent,
      tradeReturn: signal?.return ?? null,
      cumFees: strategy.cumFees,
    });
    
    // Console output
    if (signal) {
      log(`${asset}: ${signal.action.toUpperCase()} at ${currentPrice} | Return: ${signal.return ? (signal.return * 100).toFixed(2) + '%' : '-'} | Equity: ${this.equity[asset].toFixed(2)}`);
    }
    
    return signal;
  }

  /**
   * Run through historical data (backtest mode)
   */
  async runHistorical() {
    log('\n=== Running Historical Backtest ===');
    
    // Find the longest data length
    const maxLen = Math.max(...Object.values(this.data).map(d => d.length));
    
    for (let i = 0; i < maxLen; i++) {
      for (const asset of CONFIG.assets) {
        if (this.data[asset] && i < this.data[asset].length) {
          this.processCandle(asset, this.data[asset][i]);
        }
      }
    }
    
    this.printSummary();
  }

  /**
   * Fetch latest candle and process
   */
  async fetchAndProcess() {
    log('\n=== Live Update ===');
    
    for (const asset of CONFIG.assets) {
      const symbol = getSymbol(asset);
      try {
        const candles = await fetchBinanceKlines(symbol, '1h', 2);
        const latest = candles[candles.length - 1];
        const candle = {
          date: new Date(latest.openTime).toISOString(),
          price: latest.close,
          high: latest.high,
          low: latest.low,
        };
        
        // Only process if this is a new candle
        if (this.lastPrices[asset] !== candle.price || true) {
          this.processCandle(asset, candle);
          this.lastPrices[asset] = candle.price;
        }
      } catch (e) {
        log(`ERROR: ${e.message}`);
      }
    }
  }

  /**
   * Start live polling (assumes data already loaded via loadData + runHistorical)
   */
  async startLive() {
    log(`\n=== Starting Live Polling (every ${CONFIG.pollIntervalMs / 1000 / 60} minutes) ===`);
    
    // Save initial state
    saveState({
      equity: this.equity,
      strategies: {},
      lastPrices: this.lastPrices,
      timestamp: new Date().toISOString(),
    });
    
    // Poll for updates
    setInterval(async () => {
      try {
        await this.fetchAndProcess();
        saveState({
          equity: this.equity,
          strategies: {},
          lastPrices: this.lastPrices,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        log(`Live update error: ${e.message}`);
      }
    }, CONFIG.pollIntervalMs);
  }

  printSummary() {
    log('\n=== Paper Trading Summary ===');
    for (const asset of CONFIG.assets) {
      const strategy = this.strategies[asset];
      log(`${asset}:`);
      log(`  Trades: ${strategy.trades}`);
      log(`  Realized PnL: ${(strategy.realizedPnL * 100).toFixed(2)}%`);
      log(`  Cum. Fees: ${strategy.cumFees.toFixed(2)}`);
      log(`  Current Equity: ${this.equity[asset].toFixed(2)}`);
      log(`  Last Event: ${strategy.lastEvent}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  initCSV();
  
  const trader = new PaperTrader();
  
  const args = process.argv.slice(2);
  
  if (args.includes('--historical-only')) {
    await trader.loadData();
    await trader.runHistorical();
  } else if (args.includes('--live')) {
    await trader.startLive();
  } else {
    // Default: run historical, then start live
    await trader.loadData();
    await trader.runHistorical();
    log('\nHistorical run complete. Starting live polling...');
    await trader.startLive();
  }
}

main().catch(e => {
  log(`Fatal error: ${e.message}`);
  process.exit(1);
});
