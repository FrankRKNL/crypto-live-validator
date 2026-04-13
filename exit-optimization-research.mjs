#!/usr/bin/env node
/**
 * EXIT OPTIMIZATION RESEARCH - Compress Momentum Edge to <8h
 * 
 * Frank's insight: We found momentum edge exists (24h payoff).
 * Now we optimize HOW we take profit, not WHEN we enter.
 * 
 * Entry: Fast move >= 1.5%, follow-through confirmed
 * Tests:
 *   TEST 1: Dynamic Exit (momentum break = 2 bearish candles OR price < SMA for longs)
 *   TEST 2: Partial Take Profit (50% @ +0.5%, rest on 24h max OR stop)
 *   TEST 3: Volatility Exit (exit when ATR/range strongly declines)
 * 
 * Goal: Compress 24h payoff to <8h without losing edge.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
mkdirSync(RESULTS_DIR, { recursive: true });

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const ASSETS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const INITIAL_BALANCE = 10000;
const FEE = 0.001;        // 10bps maker fee
const SLIPPAGE = 0.0005;  // 5bps slippage

// Entry: fast move momentum (confirmed working from prior research)
const FAST_MOVE_THRESHOLD = 0.015;  // 1.5%
const FOLLOW_THROUGH_MIN  = 0.003;  // 0.3%

// Backtest window (~41 days of 1h candles = 984 candles)
const MAX_CANDLES = 984;

// ─── HELPERS ───────────────────────────────────────────────────────────────
function pctChange(a, b) { return ((a - b) / b) * 100; }

function smaArr(prices, period) {
  const r = [];
  for (let i = period - 1; i < prices.length; i++) {
    const s = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    r.push(s);
  }
  return r;
}

function emaArr(prices, period) {
  const k = 2 / (period + 1);
  let e = prices[0];
  const r = [e];
  for (let i = 1; i < prices.length; i++) {
    e = prices[i] * k + e * (1 - k);
    r.push(e);
  }
  return r;
}

function atrArr(candles, period = 14) {
  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  // ATR using EMA method
  const k = 2 / (period + 1);
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const r = [a];
  for (let i = period; i < trs.length; i++) {
    a = trs[i] * k + a * (1 - k);
    r.push(a);
  }
  return r; // aligned with candles[period..]
}

function rangeAtr(candles, lookback = 20) {
  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);
  const r = [];
  for (let i = lookback; i < candles.length; i++) {
    const maxH = Math.max(...highs.slice(i - lookback + 1, i + 1));
    const minL = Math.min(...lows.slice(i - lookback + 1, i + 1));
    r.push({ range: maxH - minL, idx: i });
  }
  return r;
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}
function tTestVsZero(arr) {
  const m = mean(arr);
  const s = std(arr);
  const n = arr.length;
  if (s === 0 || n < 3) return { t: 0, p: 1, sig: false };
  const se = s / Math.sqrt(n);
  const t = m / se;
  const z = Math.abs(t);
  // Approximate p via normal CDF
  const a1=0.254829592, a2=-0.284496581, a3=1.26551223, a4=-1.30417387e-5, a5=5.007579009e-4, a6=-0.001683885;
  const t2 = 1/(1+a1*z+a2*z**2+a3*z**3+a4*z**4+a5*z**5+a6*z**6);
  const p = 2 * (1 - 0.5*(1+t2*Math.exp(-z*z)));
  return { t, p, sig: Math.abs(t) > 1.96 && p < 0.05 };
}

// ─── DATA ───────────────────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const { default: { default: Binance } } = await import('binance-api-node');
  const client = Binance();
  const candles = await client.candles({
    symbol: `${symbol}USDT`,
    interval: '1h',
    limit: MAX_CANDLES
  });
  return candles.map(c => ({
    time: c.openTime / 1000,
    open:  parseFloat(c.open),
    high:  parseFloat(c.high),
    low:   parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume),
  }));
}

// ─── SIGNAL: Fast Move Momentum ────────────────────────────────────────────
function detectFastMoveSignal(candles, idx) {
  // Need prev candle for pump + cur candle for follow-through
  if (idx < 1) return null;
  const prev = candles[idx - 1];
  const cur  = candles[idx];

  const pump = pctChange(prev.close, prev.open);
  const ft   = pctChange(cur.close, prev.close);

  if (pump >= FAST_MOVE_THRESHOLD && ft >= FOLLOW_THROUGH_MIN) {
    return { type: 'LONG', entryPrice: cur.close, entryTime: cur.time, pump, ft };
  }
  return null;
}

// ─── TEST 1: DYNAMIC EXIT ───────────────────────────────────────────────────
// Exit when: 2 bearish candles OR price < SMA8 for longs
function runDynamicExit(candles) {
  let balance = INITIAL_BALANCE;
  let position = null; // { entryPrice, entryTime, entryIdx, peakPrice }
  const trades = [];
  
  // Precompute SMA8 aligned with candles
  const closes = candles.map(c => c.close);
  const sma8 = smaArr(closes, 8);
  // sma8[i] corresponds to candles[i+7] (first valid at idx 7)

  for (let i = 2; i < candles.length - 1; i++) {
    const cur  = candles[i];
    const prev = candles[i - 1];
    const prev2 = candles[i - 2];
    const sma8Val = sma8[i - 8 + 7] ?? null; // sma8 valid at i-1

    // Check exit FIRST
    if (position) {
      const ageHours = (cur.time - position.entryTime) / 3600;
      
      // Dynamic exit triggers
      let exit = false;
      let exitReason = '';

      // Trigger A: 2 bearish candles
      const bear1 = prev.close < prev.open;
      const bear2 = prev2.close < prev2.open;
      if (bear1 && bear2) { exit = true; exitReason = '2BEAR'; }

      // Trigger B: price below SMA8 (only valid after enough data)
      if (sma8Val !== null && cur.close < sma8Val) { exit = true; exitReason = 'SMA8'; }

      // Trigger C: max hold time 8h
      if (ageHours >= 8) { exit = true; exitReason = '8H_MAX'; }

      if (exit) {
        const pnl = pctChange(cur.close, position.entryPrice);
        const netPnl = pnl - FEE - SLIPPAGE;
        balance *= (1 + netPnl / 100);
        trades.push({
          entryPrice: position.entryPrice, exitPrice: cur.close,
          pnl: netPnl, exitReason, holdHours: ageHours,
          entryTime: new Date(position.entryTime * 1000).toISOString()
        });
        position = null;
        continue;
      }

      // Update peak
      if (cur.close > position.peakPrice) position.peakPrice = cur.close;
    }

    // Check entry
    if (!position) {
      const signal = detectFastMoveSignal(candles, i);
      if (signal) {
        position = {
          entryPrice: signal.entryPrice,
          entryTime:  signal.entryTime,
          entryIdx:   i,
          peakPrice:  signal.entryPrice,
        };
      }
    }
  }

  return { balance, trades, finalBalance: balance };
}

// ─── TEST 2: PARTIAL TAKE PROFIT ───────────────────────────────────────────
// Entry: fast move
// Exit: 50% at +0.5%, rest on 24h max OR stop loss (-1% within first 2h)
function runPartialTP(candles) {
  let balance = INITIAL_BALANCE;
  let position = null; // { entryPrice, entryTime, peakPrice, tp1Done, tp1Price, remaining }
  const trades = [];

  for (let i = 2; i < candles.length - 1; i++) {
    const cur  = candles[i];
    const prev = candles[i - 1];

    if (position) {
      const ageHours = (cur.time - position.entryTime) / 3600;
      const curRet  = pctChange(cur.close, position.entryPrice);

      // Exit conditions
      let exit = false;
      let exitReason = '';

      // TP1: 50% at +0.5%
      if (!position.tp1Done && curRet >= 0.5) {
        // Close 50% of position at this candle
        position.tp1Done = true;
        position.tp1Price = cur.close;
        const halfPnl = 0.5 * (curRet - FEE - SLIPPAGE);
        balance *= (1 + halfPnl / 100);
        trades.push({
          type: 'TP1', entryPrice: position.entryPrice, exitPrice: cur.close,
          pnl: halfPnl, exitReason: 'TP1_50%', holdHours: ageHours,
          partial: true, remaining: position.remaining
        });
        // Remaining 50% stays in play
      }

      // Stop loss: -1% within first 2h
      if (ageHours <= 2 && curRet <= -1.0) {
        const remainingPnl = position.remaining * (curRet - FEE - SLIPPAGE);
        balance *= (1 + remainingPnl / 100);
        trades.push({
          type: 'TP2_STOP', entryPrice: position.entryPrice, exitPrice: cur.close,
          pnl: remainingPnl, exitReason: 'STOP_1%', holdHours: ageHours,
          partial: false, remaining: 0
        });
        position = null;
        continue;
      }

      // Max hold 24h
      if (ageHours >= 24) {
        if (!position.tp1Done) {
          // Never hit TP1, close full position
          const fullPnl = position.remaining * (curRet - FEE - SLIPPAGE);
          balance *= (1 + fullPnl / 100);
          trades.push({
            type: 'TP2_MAX', entryPrice: position.entryPrice, exitPrice: cur.close,
            pnl: fullPnl, exitReason: '24H_MAX', holdHours: ageHours,
            partial: false, remaining: 0
          });
        } else {
          // TP1 done, close remaining 50%
          const remainingPnl = position.remaining * (curRet - FEE - SLIPPAGE);
          balance *= (1 + remainingPnl / 100);
          trades.push({
            type: 'TP2_MAX', entryPrice: position.entryPrice, exitPrice: cur.close,
            pnl: remainingPnl, exitReason: '24H_MAX', holdHours: ageHours,
            partial: false, remaining: 0
          });
        }
        position = null;
        continue;
      }

      // Update peak
      if (cur.close > position.peakPrice) position.peakPrice = cur.close;
    }

    // Check entry
    if (!position) {
      const signal = detectFastMoveSignal(candles, i);
      if (signal) {
        position = {
          entryPrice: signal.entryPrice,
          entryTime:  signal.entryTime,
          peakPrice:  signal.entryPrice,
          tp1Done: false,
          tp1Price: null,
          remaining: 1.0  // 100% of balance allocated
        };
      }
    }
  }

  return { balance, trades, finalBalance: balance };
}

// ─── TEST 3: VOLATILITY EXIT ───────────────────────────────────────────────
// Exit when: ATR strongly declines (move "exhausted")
// We measure: ATR at entry vs ATR now. If ATR dropped significantly → exit
function runVolatilityExit(candles) {
  let balance = INITIAL_BALANCE;
  let position = null;
  const trades = [];

  // Precompute ATR14 for every candle
  const atr = atrArr(candles, 14);
  // atr[i] valid for candles[i+1] (starts at index 15)

  // Also compute rangeAtr for 20-period lookback
  const ranges = rangeAtr(candles, 20);
  // ranges[i] = { range, idx } where idx is candle index

  for (let i = 15; i < candles.length - 1; i++) {
    const cur  = candles[i];
    const prev  = candles[i - 1];
    const atrIdx = i - 1 - 14; // atr index for prev candle

    if (position) {
      const ageHours = (cur.time - position.entryTime) / 3600;

      // Volatility exit: ATR dropped significantly since entry
      const entryAtrIdx = position.entryIdx - 1 - 14;
      let exit = false;
      let exitReason = '';

      if (entryAtrIdx >= 0 && entryAtrIdx < atr.length) {
        const entryAtr = atr[entryAtrIdx];
        const curAtr = atr[atrIdx] ?? entryAtr;
        const atrRatio = curAtr / entryAtr;

        // ATR collapsed: current ATR is less than 50% of entry ATR
        if (atrRatio < 0.5) { exit = true; exitReason = `ATR_COLLAPSE_${atrRatio.toFixed(2)}`; }
      }

      // Also: range contracted (current range < 50% of entry range)
      const entryRangeIdx = ranges.findIndex(r => r.idx === position.entryIdx);
      const curRangeIdx   = ranges.findIndex(r => r.idx === i);
      if (entryRangeIdx >= 0 && curRangeIdx >= 0) {
        const entryRange = ranges[entryRangeIdx].range;
        const curRange   = ranges[curRangeIdx].range;
        const rangeRatio = curRange / entryRange;
        if (rangeRatio < 0.5) { exit = true; exitReason = `RANGE_CONTRACT_${rangeRatio.toFixed(2)}`; }
      }

      // Max hold 24h
      if (ageHours >= 24) { exit = true; exitReason = '24H_MAX'; }

      if (exit) {
        const pnl = pctChange(cur.close, position.entryPrice);
        const netPnl = pnl - FEE - SLIPPAGE;
        balance *= (1 + netPnl / 100);
        trades.push({
          entryPrice: position.entryPrice, exitPrice: cur.close,
          pnl: netPnl, exitReason, holdHours: ageHours,
          atrRatio: atr[atrIdx] ? (atr[atrIdx] / (atr[entryAtrIdx] || 1)).toFixed(2) : 'N/A'
        });
        position = null;
        continue;
      }

      // Update peak
      if (cur.close > position.peakPrice) position.peakPrice = cur.close;
    }

    // Check entry
    if (!position) {
      const signal = detectFastMoveSignal(candles, i);
      if (signal) {
        position = {
          entryPrice: signal.entryPrice,
          entryTime:  signal.entryTime,
          entryIdx:   i,
          peakPrice:  signal.entryPrice,
        };
      }
    }
  }

  return { balance, trades, finalBalance: balance };
}

// ─── BASELINE: Fixed 24h Hold ──────────────────────────────────────────────
function runBaseline24h(candles) {
  let balance = INITIAL_BALANCE;
  let position = null;
  const trades = [];

  for (let i = 2; i < candles.length - 24; i++) { // need 24h ahead
    const cur = candles[i];

    if (position) {
      const ageHours = (cur.time - position.entryTime) / 3600;
      if (ageHours >= 24) {
        const pnl = pctChange(cur.close, position.entryPrice);
        const netPnl = pnl - FEE - SLIPPAGE;
        balance *= (1 + netPnl / 100);
        trades.push({
          entryPrice: position.entryPrice, exitPrice: cur.close,
          pnl: netPnl, holdHours: 24, exitReason: '24H_FIXED'
        });
        position = null;
      } else {
        if (cur.close > position.peakPrice) position.peakPrice = cur.close;
      }
    }

    if (!position) {
      const signal = detectFastMoveSignal(candles, i);
      if (signal) {
        position = {
          entryPrice: signal.entryPrice,
          entryTime:  signal.entryTime,
          entryIdx:   i,
          peakPrice:  signal.entryPrice,
        };
      }
    }
  }

  return { balance, trades, finalBalance: balance };
}

// ─── RUN ALL TESTS ─────────────────────────────────────────────────────────
async function runAll() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  EXIT OPTIMIZATION RESEARCH - Compress Momentum Edge to <8h  ║');
  console.log('║  Entry: fast move >= 1.5% + follow-through                  ║');
  console.log('║  Tests: Dynamic Exit | Partial TP | Volatility Exit         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const allResults = {};

  for (const asset of ASSETS) {
    console.log(`══ ${asset} ══════════════════════════════════════════`);
    let candles;
    try {
      candles = await fetchCandles(asset);
      console.log(`   ${candles.length} candles | ${new Date(candles[0].time * 1000).toISOString().split('T')[0]} → ${new Date(candles[candles.length - 1].time * 1000).toISOString().split('T')[0]}`);
    } catch (e) {
      console.log(`   ERROR: ${e.message}`);
      allResults[asset] = { error: e.message };
      continue;
    }

    const baseline = runBaseline24h(candles);
    const dyn      = runDynamicExit(candles);
    const partial  = runPartialTP(candles);
    const vol      = runVolatilityExit(candles);

    function tradeStats(t) {
      if (!t.trades || t.trades.length === 0) return { n: 0, avg: 0, winRate: 0, medHold: 0 };
      const pnls = t.trades.map(tr => tr.pnl);
      const wins = pnls.filter(p => p > 0).length;
      const holds = t.trades.map(tr => tr.holdHours || 0);
      return {
        n: t.trades.length,
        avg: mean(pnls).toFixed(3),
        winRate: ((wins / t.trades.length) * 100).toFixed(1),
        medHold: holds.sort((a, b) => a - b)[Math.floor(holds.length / 2)].toFixed(1),
        maxHold: Math.max(...holds).toFixed(1),
      };
    }

    const bs = tradeStats(baseline);
    const ds = tradeStats(dyn);
    const ps = tradeStats(partial);
    const vs = tradeStats(vol);

    const retPct = (t) => ((t.finalBalance / INITIAL_BALANCE - 1) * 100).toFixed(2);

    console.log(`   BASELINE (24h hold):  ${retPct(baseline)}% | ${bs.n} trades | win=${bs.winRate}% | avg=${bs.avg}% | medH=${bs.medHold}h | maxH=${bs.maxHold}h`);
    console.log(`   TEST1-Dynamic Exit:  ${retPct(dyn)}% | ${ds.n} trades | win=${ds.winRate}% | avg=${ds.avg}% | medH=${ds.medHold}h | maxH=${ds.maxHold}h`);
    console.log(`   TEST2-Partial TP:   ${retPct(partial)}% | ${ps.n} trades | win=${ps.winRate}% | avg=${ps.avg}% | medH=${ps.medHold}h | maxH=${ps.maxHold}h`);
    console.log(`   TEST3-Vol Exit:      ${retPct(vol)}% | ${vs.n} trades | win=${vs.winRate}% | avg=${vs.avg}% | medH=${vs.medHold}h | maxH=${vs.maxHold}h`);

    // Statistical significance test on trades
    for (const [label, t] of [['BASELINE', baseline], ['DYNAMIC', dyn], ['PARTIAL', partial], ['VOL', vol]]) {
      if (t.trades.length >= 5) {
        const pnls = t.trades.map(tr => tr.pnl);
        const { t: tt, p } = tTestVsZero(pnls);
        console.log(`     ${label}: t=${tt.toFixed(2)} p=${p.toFixed(4)} ${pnls.length} trades`);
      }
    }

    allResults[asset] = {
      candles: candles.length,
      baseline: { finalBalance: baseline.finalBalance, retPct: retPct(baseline), stats: bs, trades: baseline.trades },
      dynamic:  { finalBalance: dyn.finalBalance,      retPct: retPct(dyn),      stats: ds, trades: dyn.trades },
      partial:  { finalBalance: partial.finalBalance,  retPct: retPct(partial),  stats: ps, trades: partial.trades },
      vol:      { finalBalance: vol.finalBalance,       retPct: retPct(vol),      stats: vs, trades: vol.trades },
    };

    console.log('');
  }

  // ─── CROSS-ASSET SUMMARY ─────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  CROSS-ASSET SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('  (Return % vs Buy & Hold on fast-move entries)');
  console.log('');
  console.log('  Asset   | Baseline | DynExit | PartTP  | VolExit');
  console.log('  --------|----------|----------|---------|---------');

  const rows = [];
  for (const asset of ASSETS) {
    if (!allResults[asset] || allResults[asset].error) continue;
    const r = allResults[asset];
    rows.push({
      asset,
      b: parseFloat(r.baseline.retPct),
      d: parseFloat(r.dynamic.retPct),
      p: parseFloat(r.partial.retPct),
      v: parseFloat(r.vol.retPct),
    });
  }

  rows.forEach(row => {
    const best = Math.max(row.d, row.p, row.v);
    const bestLabel = row.d === best ? 'Dyn' : row.p === best ? 'Part' : row.v === best ? 'Vol' : '';
    console.log(
      `  ${row.asset.padEnd(7)}| ${row.b >= 0 ? '+' : ''}${row.b.toFixed(1).padStart(6)}% | ` +
      `${row.d >= 0 ? '+' : ''}${row.d.toFixed(1).padStart(6)}% | ` +
      `${row.p >= 0 ? '+' : ''}${row.p.toFixed(1).padStart(5)}% | ` +
      `${row.v >= 0 ? '+' : ''}${row.v.toFixed(1).padStart(5)}`
    );
  });

  // Averages
  const avgB = rows.length ? rows.reduce((s, r) => s + r.b, 0) / rows.length : 0;
  const avgD = rows.length ? rows.reduce((s, r) => s + r.d, 0) / rows.length : 0;
  const avgP = rows.length ? rows.reduce((s, r) => s + r.p, 0) / rows.length : 0;
  const avgV = rows.length ? rows.reduce((s, r) => s + r.v, 0) / rows.length : 0;
  console.log('  --------|----------|----------|---------|---------');
  console.log(`  ${'AVG'.padEnd(7)}| ${avgB >= 0 ? '+' : ''}${avgB.toFixed(1).padStart(6)}% | ${avgD >= 0 ? '+' : ''}${avgD.toFixed(1).padStart(6)}% | ${avgP >= 0 ? '+' : ''}${avgP.toFixed(1).padStart(5)}% | ${avgV >= 0 ? '+' : ''}${avgV.toFixed(1).padStart(5)}%`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  KEY INSIGHTS');
  console.log('═══════════════════════════════════════════════════════════');
  
  // Which test won most often?
  const wins = { baseline: 0, dynamic: 0, partial: 0, vol: 0 };
  rows.forEach(row => {
    const vals = { baseline: row.b, dynamic: row.d, partial: row.p, vol: row.v };
    const best = Object.entries(vals).reduce((a, b) => b[1] > a[1] ? b : a);
    wins[best[0]]++;
  });
  const winOrder = Object.entries(wins).sort((a, b) => b[1] - a[1]);
  console.log('');
  console.log('  Most wins: ' + winOrder.map(([k, v]) => `${k}=${v}`).join(' > '));
  
  // Average hold time compression
  console.log('');
  console.log('  Hold time compression (vs baseline 24h):');
  for (const [label, key] of [['DynExit', 'dynamic'], ['PartTP', 'partial'], ['VolExit', 'vol']]) {
    let totalMed = 0, totalMax = 0, cnt = 0;
    for (const asset of ASSETS) {
      if (!allResults[asset] || allResults[asset].error) continue;
      const s = allResults[asset][key].stats;
      if (s && s.n > 0) {
        totalMed += parseFloat(s.medHold);
        totalMax += parseFloat(s.maxHold);
        cnt++;
      }
    }
    if (cnt > 0) {
      console.log(`    ${label}: avg medHold=${(totalMed/cnt).toFixed(1)}h | avg maxHold=${(totalMax/cnt).toFixed(1)}h`);
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('═══════════════════════════════════════════════════════════');
  
  const avgTests = [{ label: 'DynExit', val: avgD }, { label: 'PartTP', val: avgP }, { label: 'VolExit', val: avgV }];
  const bestTest = avgTests.reduce((a, b) => b.val > a.val ? b : a);
  const vsBaseline = bestTest.val > avgB ? `+${(bestTest.val - avgB).toFixed(1)}pp vs baseline` : `${(bestTest.val - avgB).toFixed(1)}pp vs baseline`;
  console.log(`  Best exit method: ${bestTest.label} (avg return ${bestTest.val >= 0 ? '+' : ''}${bestTest.val.toFixed(2)}% ${vsBaseline})`);
  console.log('');

  // Save report
  const reportPath = join(RESULTS_DIR, 'EXIT-OPTIMIZATION.md');
  const report = `# Exit Optimization Research\n**Date:** ${new Date().toISOString().split('T')[0]}\n**Entry:** Fast move >= 1.5%, follow-through confirmed\n**Goal:** Compress 24h payoff to <8h via better exits\n\n## Three Exit Strategies Tested\n\n### TEST 1: Dynamic Exit\n- Exit on: 2 bearish candles OR price < SMA8\n- Max hold: 8h\n\n### TEST 2: Partial Take Profit\n- 50% closes at +0.5%\n- Remaining 50%: 24h max OR stop loss (-1% within 2h)\n\n### TEST 3: Volatility Exit\n- Exit when: ATR < 50% of entry ATR OR range < 50% of entry range\n- Max hold: 24h\n\n## Results\n\n| Asset | Baseline(24h) | DynExit | PartTP | VolExit |\n|-------|--------------|---------|--------|---------|\n${rows.map(r => `| ${r.asset} | ${r.b >= 0 ? '+' : ''}${r.b.toFixed(1)}% | ${r.d >= 0 ? '+' : ''}${r.d.toFixed(1)}% | ${r.p >= 0 ? '+' : ''}${r.p.toFixed(1)}% | ${r.v >= 0 ? '+' : ''}${r.v.toFixed(1)}% |`).join('\n')}\n\n**Averages:** Baseline=${avgB >= 0 ? '+' : ''}${avgB.toFixed(1)}% | DynExit=${avgD >= 0 ? '+' : ''}${avgD.toFixed(1)}% | PartTP=${avgP >= 0 ? '+' : ''}${avgP.toFixed(1)}% | VolExit=${avgV >= 0 ? '+' : ''}${avgV.toFixed(1)}%\n\n## Verdict\n**Best exit:** ${bestTest.label} (avg return ${bestTest.val >= 0 ? '+' : ''}${bestTest.val.toFixed(2)}% ${vsBaseline})\n\nData: ~41 days of 1h candles per asset. Short window — validate on longer dataset.\n`;
  writeFileSync(reportPath, report);
  console.log(`  Report: ${reportPath}`);

  return allResults;
}

runAll().catch(console.error);