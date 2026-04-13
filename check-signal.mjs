#!/usr/bin/env node
async function fetchCandles(symbol, interval = '1h', limit = 20) {
  const pair = symbol === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  const data = await r.json();
  return data.map(k => ({
    time: new Date(k[0]).getTime(),
    open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]),
  }));
}

const [eth, btc] = await Promise.all([fetchCandles('ETH'), fetchCandles('BTC')]);
const w = eth.slice(-4);
const drawdown = (w[0].open - Math.min(...w.map(c => c.low))) / w[0].open;
const lc = w.at(-1);
const atr = (() => {
  const trs = [];
  for (let i = 1; i < eth.length; i++) {
    const c = eth[i], p = eth[i-1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return (trs.slice(-14).reduce((a,b) => a+b, 0) / 14 / eth.at(-1).close) * 100;
})();
const btcTrend = (btc.slice(-4).at(-1).close - btc.slice(-4)[0].open) / btc.slice(-4)[0].open;
const passes = drawdown >= 0.03 && lc.close < lc.open && atr >= 0.8 && atr <= 2.0 && btcTrend <= -0.02;
console.log(`ETH drawdown 4h: ${(drawdown*100).toFixed(2)}% (need >=3%)`);
console.log(`Last candle: ${lc.close < lc.open ? 'RED' : 'GREEN'} (close ${lc.close.toFixed(2)} < open ${lc.open.toFixed(2)})`);
console.log(`ATR: ${atr.toFixed(2)}% (need 0.8-2.0%)`);
console.log(`BTC trend 4h: ${(btcTrend*100).toFixed(2)}% (need <=-2%)`);
console.log(`→ Signal possible: ${passes}`);