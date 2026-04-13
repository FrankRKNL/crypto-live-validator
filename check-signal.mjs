import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function fetchCandles(symbol, interval = '1h', limit = 100) {
  const pair = symbol === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  const data = await r.json();
  return data.map(([o, h, l, c, v, , , , tv]) => ({
    open: parseFloat(o), high: parseFloat(h), low: parseFloat(l), close: parseFloat(c), volume: parseFloat(tv),
  }));
}

function calcATR(candles, period = 14) {
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trueRanges.push(tr);
  }
  const atr = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  return (atr / candles.at(-1).close) * 100;
}

function calcBTCTrend(candles, lookback = 4) {
  if (candles.length < lookback) return 0;
  const start = candles.slice(-lookback)[0];
  const end = candles.at(-1);
  return (end.close - start.open) / start.open;
}

const [ethCandles, btcCandles] = await Promise.all([
  fetchCandles('ETH', '1h', 20),
  fetchCandles('BTC', '1h', 20),
]);

// Check last 4 candles for drawdown
const window = ethCandles.slice(-4);
const windowStartOpen = window[0].open;
const windowLow = Math.min(...window.map(c => c.low));
const drawdownPct = (windowStartOpen - windowLow) / windowStartOpen;
const lastCandle = window.at(-1);
const lastRed = lastCandle.close < lastCandle.open;
const btcTrend = calcBTCTrend(btcCandles, 4);
const atr = calcATR(ethCandles.slice(-20));

console.log('=== SIGNAL CHECK ===');
console.log('Last 4 candles:');
window.forEach((c, i) => {
  const color = c.close >= c.open ? '🟢' : '🔴';
  const pct = ((c.close - c.open) / c.open * 100).toFixed(2);
  console.log(`  ${color} ${c.open.toFixed(2)} → ${c.close.toFixed(2)} (${pct}%) low=${c.low.toFixed(2)}`);
});
console.log('');
console.log('Drawdown check:');
console.log(`  Window start open: ${windowStartOpen.toFixed(2)}`);
console.log(`  Window low: ${windowLow.toFixed(2)}`);
console.log(`  Drawdown: ${(drawdownPct * 100).toFixed(2)}% (need >= 3%)`);
console.log('');
console.log('Last candle red:', lastRed);
console.log('ATR 1h:', atr?.toFixed(3) + '% (need 0.8-2.0%)');
console.log('BTC 4h trend:', (btcTrend * 100).toFixed(2) + '% (need <= -2%)');
console.log('');
console.log('=== VERDICT ===');
console.log(`Drawdown >= 3%: ${drawdownPct >= 0.03 ? '✓ YES' : '✗ NO'}`);
console.log(`Last candle red: ${lastRed ? '✓ YES' : '✗ NO'}`);
console.log(`ATR in range: ${atr >= 0.8 && atr <= 2.0 ? '✓ YES' : '✗ NO'}`);
console.log(`BTC <= -2%: ${btcTrend <= -0.02 ? '✓ YES' : '✗ NO'}`);
console.log('');
console.log('Signal?', drawdownPct >= 0.03 && lastRed && atr >= 0.8 && atr <= 2.0 && btcTrend <= -0.02 ? '✅ SIGNAL!' : '❌ NO SIGNAL');