#!/usr/bin/env node
/**
 * EVENT-DRIVEN MICROSTRUCTURE RESEARCH
 * 
 * Frank's new direction (2026-04-11):
 * - STOP: average returns per window, simple OFI averages
 * - START: specific rare events and sequences
 * 
 * FASE 1: Event Detection
 * - Sudden imbalance shift (OFI flips sign rapidly)
 * - Large aggressive trades (size >> average)
 * - Orderbook absorption (strong selling but price doesn't drop)
 * - Sweep events (multiple levels consumed quickly)
 * 
 * FASE 2: Post-Event Behavior
 * - Measure price movement at 100ms, 500ms, 1s, 5s after event
 * - Continuation vs reversal classification
 * 
 * FASE 3: Sequence Analysis
 * - Event A followed by Event B
 * - e.g., sell pressure → absorption → bounce?
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { mkdir } from 'fs/promises';

const __dirname = '/home/node/.openclaw/workspace/crypto-live-validator';
const OUTPUT_DIR = join(__dirname, 'microstructure-data', 'event-research');
const SESSION_ID = new Date().toISOString().replace(/[:.]/g, '-');

// ─── CONFIG ───────────────────────────────────────────────
const SYMBOLS = ['btcusdt', 'ethusdt'];
const TRADE_FLUSH_SIZE = 500;
const ORDERBOOK_FLUSH_INTERVAL_MS = 10_000;
const EVENT_WINDOW_MS = { 100: 0.1, 500: 0.5, 1000: 1, 5000: 5 };

// Event thresholds (will be calibrated from live data)
const LARGE_TRADE_MULTIPLE = 3.0;  // trade size > N × recent average
const IMBALANCE_SHIFT_THRESHOLD = 0.6;  // OFI ratio flip
const SWEEP_LEVELS_THRESHOLD = 3;  // N levels consumed in < 100ms

// ─── STATE ─────────────────────────────────────────────────
const sessionDir = join(OUTPUT_DIR, `session-${SESSION_ID}`);
await mkdir(sessionDir, { recursive: true });

const state = {
  symbols: {},
  eventLog: [],          // all detected events
  tradeBuffer: {},        // symbol -> trades awaiting flush
  orderbook: {},          // symbol -> current orderbook
  ofiHistory: {},        // symbol -> rolling OFI (for imbalance detection)
  tradeSizeHistory: {},   // symbol -> rolling avg trade size (for large trade detection)
  lastOFI: {},           // symbol -> last OFI value
  ofiSignChanges: {},    // symbol -> count of rapid sign flips
};

// Initialize per-symbol state
SYMBOLS.forEach(s => {
  state.symbols[s] = { connected: false, trades: 0, lastTradeTime: 0 };
  state.tradeBuffer[s] = [];
  state.orderbook[s] = { bids: {}, asks: {}, lastUpdate: 0 };
  state.ofiHistory[s] = [];
  state.tradeSizeHistory[s] = [];
  state.lastOFI[s] = null;
  state.ofiSignChanges[s] = 0;
});

// ─── HELPERS ─────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 23); }
function ms() { return Date.now(); }

function flushTrades(symbol) {
  const buf = state.tradeBuffer[symbol];
  if (!buf || buf.length === 0) return;
  const filename = join(sessionDir, `${symbol}-trades.csv`);
  const header = 'trade_timestamp_ms,trade_id,price,size,side,is_buyer_maker,event_flags\n';
  if (!existsSync(filename)) appendFileSync(filename, header);
  buf.forEach(t => {
    appendFileSync(filename, `${t.T},${t.t},${t.p},${t.q},${t.m ? 'SELL' : 'BUY'},${t.m},${t.flags || ''}\n`);
  });
  state.tradeBuffer[symbol] = [];
}

function writeEvent(event) {
  const filename = join(sessionDir, `events-${event.symbol}.jsonl`);
  const line = JSON.stringify({ ...event, ts: new Date(event.ts).toISOString() });
  appendFileSync(filename, line + '\n');
  state.eventLog.push(event);
}

/**
 * Calculate Order Flow Imbalance (OEFI)
 * Sum of (signed trade size) over recent window
 */
function calculateOEFI(trades, windowMs = 1000) {
  const now = ms();
  const window = trades.filter(t => now - t.T < windowMs);
  if (window.length === 0) return 0;
  return window.reduce((sum, t) => {
    // BUY trades (is_buyer_maker = false) = aggressive buy = positive flow
    // SELL trades (is_buyer_maker = true) = aggressive sell = negative flow
    const sign = t.m ? -1 : 1;  // m=true means seller is maker = SELL
    return sum + sign * parseFloat(t.q);
  }, 0);
}

/**
 * Detect large trade event
 */
function detectLargeTrade(symbol, trade, recentAvgSize) {
  const size = parseFloat(trade.q);
  if (size > recentAvgSize * LARGE_TRADE_MULTIPLE) {
    return {
      type: 'LARGE_TRADE',
      symbol,
      ts: trade.T || ms(),
      price: parseFloat(trade.p),
      size,
      avgSize: recentAvgSize,
      ratio: size / recentAvgSize,
      side: trade.m ? 'SELL' : 'BUY',
      // Post-event price targets (we'll fill these when we process the event)
    };
  }
  return null;
}

/**
 * Detect orderbook imbalance shift
 */
function detectImbalanceShift(symbol, ofi, price) {
  const history = state.ofiHistory[symbol];
  history.push(ofi);
  if (history.length > 20) history.shift();
  
  if (history.length < 5) return null;
  
  // Check for rapid sign flip
  const recent = history.slice(-5);
  const signs = recent.map(v => Math.sign(v));
  
  // Count sign changes in last 5 OFI values
  let signChanges = 0;
  for (let i = 1; i < signs.length; i++) {
    if (signs[i] !== signs[i-1] && signs[i] !== 0 && signs[i-1] !== 0) {
      signChanges++;
    }
  }
  
  if (signChanges >= 3) {
    // Rapid flip detected
    const lastSign = Math.sign(history[history.length - 1]);
    const prevSign = Math.sign(history[history.length - 2]);
    return {
      type: 'IMBALANCE_SHIFT',
      symbol,
      ts: ms(),
      currentOFI: ofi,
      direction: lastSign > 0 ? 'POSITIVE' : lastSign < 0 ? 'NEGATIVE' : 'NEUTRAL',
      flipCount: signChanges,
      price,
      // Next: measure post-event price movement
    };
  }
  return null;
}

/**
 * Detect orderbook absorption
 * Strong selling (large SELL trades) but price doesn't drop proportionally
 */
function detectAbsorption(symbol, trades, price) {
  const now = ms();
  const window500 = trades.filter(t => now - t.T < 500);
  const window1000 = trades.filter(t => now - t.T < 1000);
  
  if (window1000.length < 5) return null;
  
  // Sum signed volume
  const signedVol500 = window500.reduce((s, t) => s + (t.m ? -1 : 1) * parseFloat(t.q), 0);
  const signedVol1000 = window1000.reduce((s, t) => s + (t.m ? -1 : 1) * parseFloat(t.q), 0);
  
  // Net selling?
  if (signedVol1000 < 0) {
    // Calculate price impact
    const priceStart = window1000[0].p;
    const priceChange = ((price - priceStart) / priceStart) * 100;
    
    // Absorption: selling > 1 BTC equivalent but price drop < 0.1%
    const sellVolume = Math.abs(signedVol1000);
    if (sellVolume > 1 && priceChange > -0.1) {
      return {
        type: 'ABSORPTION',
        symbol,
        ts: ms(),
        netSellVolume: Math.abs(signedVol1000),
        priceStart,
        priceCurrent: price,
        priceChangePct: priceChange,
        tradeCount: window1000.length,
      };
    }
  }
  return null;
}

/**
 * Detect sweep event
 * Multiple orderbook levels consumed in rapid succession
 */
function detectSweep(symbol, newTrades, ob) {
  if (newTrades.length < SWEEP_LEVELS_THRESHOLD) return null;
  
  // Check if trades are consuming multiple price levels
  const prices = newTrades.map(t => parseFloat(t.p)).sort((a, b) => a - b);
  const minPrice = prices[0];
  const maxPrice = prices[prices.length - 1];
  const priceRange = ((maxPrice - minPrice) / minPrice) * 100;
  
  // Sweep: multiple trades at different prices within short time
  const timestamps = newTrades.map(t => t.T);
  const timeSpan = Math.max(...timestamps) - Math.min(...timestamps);
  
  if (priceRange > 0.05 && timeSpan < 100) {  // 0.05% price range in < 100ms
    return {
      type: 'SWEEP',
      symbol,
      ts: ms(),
      trades: newTrades.length,
      priceRangePct: priceRange,
      timeSpanMs: timeSpan,
      avgPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
    };
  }
  return null;
}

/**
 * Process post-event price movement
 * Returns price at 100ms, 500ms, 1s, 5s after event
 */
async function measurePostEvent(symbol, eventTs, eventPrice) {
  try {
    // Fetch recent trades from Binance
    const now = ms();
    const results = {};
    
    for (const [label, windowMs] of Object.entries(EVENT_WINDOW_MS)) {
      // In production, we'd wait and measure. For backtest, we mark the event
      // and analyze after data collection
      results[label] = { windowMs, measured: false, price: null };
    }
    
    return results;
  } catch (e) {
    return null;
  }
}

// ─── SEQUENCE DETECTOR ─────────────────────────────────────
class SequenceDetector {
  constructor() {
    this.events = [];  // recent events within time window
    this.windowMs = 5000;  // sequence window
    this.sequences = [];
  }
  
  add(event) {
    const now = ms();
    // Remove old events
    this.events = this.events.filter(e => now - e.ts < this.windowMs);
    this.events.push(event);
    
    // Check for known sequences
    this.detect();
  }
  
  detect() {
    if (this.events.length < 2) return;
    
    const types = this.events.map(e => e.type);
    
    // Sequence: LARGE_TRADE → price holds or reverses = absorption
    // Sequence: IMBALANCE_SHIFT → LARGE_TRADE → potential reversal
    // etc.
    
    // Check for sell pressure → absorption → bounce pattern
    // We look for events in order
    for (let i = 0; i < this.events.length - 1; i++) {
      const curr = this.events[i];
      const next = this.events[i + 1];
      
      // Pattern: large sell followed by price stability = absorption → bullish
      if (curr.type === 'LARGE_TRADE' && curr.side === 'SELL') {
        if (next.type === 'ABSORPTION' || next.type === 'IMBALANCE_SHIFT') {
          this.sequences.push({
            pattern: 'SELL_PRESSURE_ABSORBED',
            events: [curr, next],
            ts: ms(),
          });
        }
      }
      
      // Pattern: imbalance shift positive → large buy = confirmation
      if (curr.type === 'IMBALANCE_SHIFT' && curr.direction === 'POSITIVE') {
        if (next.type === 'LARGE_TRADE' && next.side === 'BUY') {
          this.sequences.push({
            pattern: 'OFI_POSITIVE_CONFIRMED',
            events: [curr, next],
            ts: ms(),
          });
        }
      }
    }
  }
  
  getRecentSequences() {
    const now = ms();
    return this.sequences.filter(s => now - s.ts < 30000);
  }
}

// ─── MAIN EVENT PROCESSOR ─────────────────────────────────
function processTrade(symbol, trade) {
  const now = ms();
  const price = parseFloat(trade.p);
  const size = parseFloat(trade.q);
  const isSell = trade.m;
  
  // Update trade size history (rolling)
  const sizeHistory = state.tradeSizeHistory[symbol];
  sizeHistory.push(size);
  if (sizeHistory.length > 100) sizeHistory.shift();
  const recentAvgSize = sizeHistory.reduce((a, b) => a + b, 0) / sizeHistory.length;
  
  // Add to trade buffer
  const flags = [];
  
  // Detect LARGE TRADE
  const largeTrade = detectLargeTrade(symbol, trade, recentAvgSize);
  if (largeTrade) {
    writeEvent(largeTrade);
    flags.push('LARGE');
  }
  
  // Detect IMBALANCE SHIFT (need accumulated trades for OFI)
  const ofi = calculateOEFI(state.tradeBuffer[symbol].concat([trade]), 1000);
  const imbalanceShift = detectImbalanceShift(symbol, ofi, price);
  if (imbalanceShift) {
    writeEvent(imbalanceShift);
    flags.push('OFI_SHIFT');
  }
  
  // Add trade to buffer
  state.tradeBuffer[symbol].push({ ...trade, flags: flags.join('+') });
  
  // Update OFI history
  state.ofiHistory[symbol].push(ofi);
  if (state.ofiHistory[symbol].length > 20) state.ofiHistory[symbol].shift();
  state.lastOFI[symbol] = ofi;
  
  // Count trades per second
  state.symbols[symbol].trades++;
}

// ─── WEBSOCKET CONNECTION ─────────────────────────────────
function connect() {
  const streams = SYMBOLS.flatMap(s => [`${s}@trade`, `${s}@depth@100ms`]);
  const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
  
  console.log(`\n[${ts()}] EVENT MICROSTRUCTURE RESEARCH`);
  console.log(`[${ts()}] Session: ${SESSION_ID}`);
  console.log(`[${ts()}] Output: ${sessionDir}`);
  console.log(`[${ts()}] Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`[${ts()}] Thresholds: LARGE_TRADE>${LARGE_TRADE_MULTIPLE}×avg, IMBALANCE_SHIFT≥${IMBALANCE_SHIFT_THRESHOLD} flips, SWEEP≥${SWEEP_LEVELS_THRESHOLD} levels`);
  console.log(`[${ts()}] Connecting...\n`);
  
  const ws = new WebSocket(wsUrl);
  const sequenceDetectors = {};
  SYMBOLS.forEach(s => sequenceDetectors[s] = new SequenceDetector());
  
  ws.on('open', () => {
    console.log(`[${ts()}] ✓ Connected to Binance WebSocket`);
    SYMBOLS.forEach(s => state.symbols[s].connected = true);
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const { stream, data: d } = msg;
      const symbol = stream.split('@')[0];
      
      if (stream.includes('@trade')) {
        const trade = {
          t: d.t, p: d.p, q: d.q, m: d.m, T: d.T || ms(),
        };
        processTrade(symbol, trade);
        
      } else if (stream.includes('@depth')) {
        // Order book update
        // Depth stream format: { b: [[price, qty], ...], a: [[price, qty], ...] }
        const ob = state.orderbook[symbol];
        
        (d.b || []).forEach(([price, qty]) => {
          if (parseFloat(qty) === 0) delete ob.bids[price];
          else ob.bids[price] = qty;
        });
        
        (d.a || []).forEach(([price, qty]) => {
          if (parseFloat(qty) === 0) delete ob.asks[price];
          else ob.asks[price] = qty;
        });
        
        ob.lastUpdate = ms();
      }
    } catch (e) {
      console.error(`[${ts()}] Parse error:`, e.message);
    }
  });
  
  ws.on('error', (e) => {
    console.error(`[${ts()}] WS error:`, e.message);
  });
  
  ws.on('close', () => {
    console.log(`[${ts()}] Connection closed, reconnecting in 5s...`);
    SYMBOLS.forEach(s => {
      state.symbols[s].connected = false;
      flushTrades(s);
    });
    setTimeout(connect, 5000);
  });
  
  return ws;
}

// ─── STATUS REPORTER ───────────────────────────────────────
function printStatus() {
  const lines = [`\n[${ts()}] EVENT MICROSTRUCTURE MONITOR`];
  
  SYMBOLS.forEach(s => {
    const sym = state.symbols[s];
    const bufLen = state.tradeBuffer[s].length;
    const ofi = state.lastOFI[s];
    const ofiStr = ofi !== null ? ofi.toFixed(4) : '-';
    const events = state.eventLog.filter(e => e.symbol === s);
    const recentEvents = events.filter(e => Date.now() - e.ts < 30000);
    
    lines.push(`  ${s.toUpperCase()}: buf=${bufLen} OFI=${ofiStr} events(last30s)=${recentEvents.length}`);
  });
  
  process.stdout.write('\r' + lines.join(' | '));
}

// ─── MAIN ───────────────────────────────────────────────────
let ws;

// Status every 5 seconds
setInterval(printStatus, 5000);

// Trade flush every 30 seconds
setInterval(() => {
  SYMBOLS.forEach(s => flushTrades(s));
}, 30000);

// Event summary every 60 seconds
setInterval(() => {
  const now = ms();
  const recentEvents = state.eventLog.filter(e => now - e.ts < 60000);
  if (recentEvents.length > 0) {
    console.log(`\n[${ts()}] EVENT SUMMARY (last 60s):`);
    const byType = {};
    recentEvents.forEach(e => {
      byType[e.type] = (byType[e.type] || 0) + 1;
    });
    Object.entries(byType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });
  }
}, 60000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nFlushing and saving...');
  SYMBOLS.forEach(s => flushTrades(s));
  
  // Write final event summary
  const summaryPath = join(sessionDir, 'event-summary.json');
  const now = ms();
  const byType = {};
  state.eventLog.forEach(e => {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(e);
  });
  
  const summary = {
    sessionId: SESSION_ID,
    totalEvents: state.eventLog.length,
    eventsByType: Object.fromEntries(
      Object.entries(byType).map(([type, events]) => [type, { count: events.length, sample: events.slice(0, 3) }])
    ),
  };
  
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log('Saved to:', sessionDir);
  console.log('Summary:', summaryPath);
  process.exit(0);
});

ws = connect();
