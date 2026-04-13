import fetch from 'fetch';

async function fetchCandles(symbol, interval = '1h', limit = 100) {
  const pair = symbol === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  const data = await r.json();
  return data.map(([o, h, l, c, v]) => ({
    open: parseFloat(o), high: parseFloat(h), low: parseFloat(l), close: parseFloat(c),
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

const eth1h = await fetchCandles('ETH', '1h', 20);
const eth4h = await fetchCandles('ETH', '4h', 20);
console.log('ATR 1h:', calcATR(eth1h).toFixed(3) + '%');
console.log('ATR 4h:', calcATR(eth4h).toFixed(3) + '%');
console.log('1h price:', eth1h.at(-1).close.toFixed(2));
console.log('ATR in range 0.8-2.0:', calcATR(eth1h) >= 0.8 && calcATR(eth1h) <= 2.0 ? 'PASS ✓' : 'FAIL ✗');