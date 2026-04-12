#!/usr/bin/env node
/**
 * Market Microstructure Data Collector
 * 
 * Phase 1: Data Infrastructure
 * 
 * Collects via Binance WebSocket:
 * - Trades (tick data): price, size, aggressor side, timestamp
 * - Order book snapshots: bid/ask depth at multiple levels
 * 
 * Storage: JSON per session, CSV for trades
 */

import pkg from 'ws';
const { WebSocket } = pkg;
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { mkdir } from 'fs/promises';

// Configuration
const SYMBOLS = ['btcusdt', 'ethusdt', 'bnbusdt', 'solusdt', 'xrpusdt'];
const OUTPUT_DIR = './microstructure-data';
const SESSION_ID = new Date().toISOString().replace(/[:.]/g, '-');

// State
const trades = {};        // symbol -> trade buffer
const orderbooks = {};     // symbol -> current orderbook state
const stats = {};          // symbol -> stats

// Initialize
SYMBOLS.forEach(s => {
  trades[s] = [];
  orderbooks[s] = { bids: {}, asks: {}, lastUpdate: null };
  stats[s] = { trades: 0, tradesPerSec: 0, lastTradeTime: Date.now() };
});

// Create output directory
await mkdir(OUTPUT_DIR, { recursive: true });
const sessionDir = join(OUTPUT_DIR, `session-${SESSION_ID}`);
await mkdir(sessionDir, { recursive: true });

// Trade stats tracking
const tradeTimestamps = {};  // for trades/sec calculation
SYMBOLS.forEach(s => tradeTimestamps[s] = []);

/**
 * Format timestamp for filenames
 */
function ts() {
  return new Date().toISOString().slice(11, 19);  // HH:MM:SS
}

/**
 * Write buffer to file
 */
function flushTrades(symbol) {
  if (trades[symbol].length === 0) return;
  
  const filename = join(sessionDir, `${symbol}-trades.csv`);
  const header = 'timestamp_ms,price,size,side,is_buyer_maker\n';
  
  if (!existsSync(filename)) {
    appendFileSync(filename, header);
  }
  
  trades[symbol].forEach(t => {
    appendFileSync(filename, `${t.t},${t.p},${t.q},${t.m ? 'SELL' : 'BUY'},${t.m}\n`);
  });
  
  trades[symbol] = [];
}

/**
 * Write orderbook snapshot
 */
function flushOrderbook(symbol) {
  const ob = orderbooks[symbol];
  const filename = join(sessionDir, `${symbol}-orderbook-${ts()}.json`);
  
  const snapshot = {
    timestamp: Date.now(),
    symbol: symbol.toUpperCase(),
    bids: Object.entries(ob.bids).sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, 20),
    asks: Object.entries(ob.asks).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).slice(0, 20),
  };
  
  writeFileSync(filename, JSON.stringify(snapshot, null, 2));
}

/**
 * Calculate trades per second
 */
function updateTradeStats(symbol) {
  const now = Date.now();
  const oneSecondAgo = now - 1000;
  
  // Clean old timestamps
  tradeTimestamps[symbol] = tradeTimestamps[symbol].filter(t => t > oneSecondAgo);
  tradeTimestamps[symbol].push(now);
  
  stats[symbol].tradesPerSec = tradeTimestamps[symbol].length;
  stats[symbol].trades++;
}

/**
 * Print current state
 */
function printState() {
  const lines = [`\n[${ts()}] Market Microstructure Collector`];
  
  SYMBOLS.forEach(s => {
    const st = stats[s];
    const ob = orderbooks[s];
    const bestBid = Object.keys(ob.bids).sort((a, b) => parseFloat(b) - parseFloat(a))[0] || '-';
    const bestAsk = Object.keys(ob.asks).sort((a, b) => parseFloat(a) - parseFloat(b))[0] || '-';
    const bidDepth = Object.values(ob.bids).reduce((sum, q) => sum + parseFloat(q), 0).toFixed(4);
    const askDepth = Object.values(ob.asks).reduce((sum, q) => sum + parseFloat(q), 0).toFixed(4);
    
    lines.push(`  ${s.toUpperCase()}: trades/sec=${st.tradesPerSec} | best bid=${bestBid} ask=${bestAsk} | depth b=${bidDepth} a=${askDepth}`);
  });
  
  process.stdout.write('\r' + lines.join(' | '));
}

/**
 * Connect to combined WebSocket streams
 */
function connect() {
  // Combined stream: trades + depth@100ms
  const streams = SYMBOLS.flatMap(s => [
    `${s}@trade`,
    `${s}@depth@100ms`
  ]);
  
  const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
  
  console.log(`\n[${ts()}] Connecting to Binance WebSocket...`);
  console.log(`[${ts()}] Output: ${sessionDir}`);
  console.log(`[${ts()}] Streams: ${SYMBOLS.length} symbols × (trade + depth)`);
  
  const ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log(`[${ts()}] ✓ Connected`);
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const { stream, data: d } = msg;
      const symbol = stream.split('@')[0];
      
      if (stream.includes('@trade')) {
        // Trade data
        const trade = {
          t: d.t,  // trade ID
          p: d.p,  // price
          q: d.q,  // quantity
          m: d.m,  // is buyer maker
          T: d.T,  // timestamp
        };
        
        trades[symbol].push(trade);
        updateTradeStats(symbol);
        
        // Flush every 100 trades
        if (trades[symbol].length >= 100) {
          flushTrades(symbol);
        }
        
      } else if (stream.includes('@depth')) {
        // Order book update
        const ob = orderbooks[symbol];
        
        // Update bids
        d.bids.forEach(([price, qty]) => {
          if (parseFloat(qty) === 0) {
            delete ob.bids[price];
          } else {
            ob.bids[price] = qty;
          }
        });
        
        // Update asks
        d.asks.forEach(([price, qty]) => {
          if (parseFloat(qty) === 0) {
            delete ob.asks[price];
          } else {
            ob.asks[price] = qty;
          }
        });
        
        ob.lastUpdate = Date.now();
      }
    } catch (e) {
      console.error(`\n[${ts()}] Parse error:`, e.message);
    }
  });
  
  ws.on('error', (e) => {
    console.error(`\n[${ts()}] WebSocket error:`, e.message);
  });
  
  ws.on('close', () => {
    console.log(`\n[${ts()}] Connection closed, reconnecting in 5s...`);
    SYMBOLS.forEach(s => flushTrades(s));  // Flush remaining trades
    setTimeout(connect, 5000);
  });
  
  return ws;
}

// Status reporting
setInterval(() => {
  printState();
}, 1000);

// Orderbook snapshot every 30 seconds
setInterval(() => {
  SYMBOLS.forEach(s => {
    if (orderbooks[s].lastUpdate) {
      flushOrderbook(s);
    }
  });
}, 30000);

// Flush trades every 30 seconds
setInterval(() => {
  SYMBOLS.forEach(s => flushTrades(s));
}, 30000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nFlushing remaining data...');
  SYMBOLS.forEach(s => flushTrades(s));
  console.log('Saved to:', sessionDir);
  process.exit(0);
});

// Start
const ws = connect();
