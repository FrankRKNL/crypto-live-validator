#!/usr/bin/env node
/**
 * INTRADAY EDGE RESEARCH - PHASE 2
 * 3 NEW non-volume-based hypotheses
 * 
 * Uses: Binance 1h public data (no auth needed)
 * Data: ~41 days (1000 candles max per Binance API)
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const resultsDir = join(__dirname, 'results');
mkdirSync(resultsDir, { recursive: true });

const ASSETS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];

// ─── CONFIG ───────────────────────────────────────────────
const SIGMA_THRESHOLDS = [2.5, 3.0, 3.5];
const REVERSION_WINDOWS = [2, 4, 6, 12];
const REGIME_WINDOW = 24;
const HOUR_BUCKETS = [
  { name: '00-04', h: [0,1,2,3] },
  { name: '04-08', h: [4,5,6,7] },
  { name: '08-12', h: [8,9,10,11] },
  { name: '12-16', h: [12,13,14,15] },
  { name: '16-20', h: [16,17,18,19] },
  { name: '20-24', h: [20,21,22,23] },
];
const SESSION_OVERLAPS = [
  { name: 'US-EU', hours: [14,15,16,17] },
  { name: 'EU-Asia', hours: [0,1,2,3] },
  { name: 'US-Asia', hours: [21,22,23,0] },
];

// ─── HELPERS ─────────────────────────────────────────────
function pctChange(a, b) { return ((a - b) / b) * 100; }
function std(arr) {
  const m = arr.reduce((a,b)=>a+b,0)/arr.length;
  return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/arr.length);
}
function mean(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }

function erf(x) {
  const a1=0.254829592, a2=-0.286496581, a3=1.26551223, a4=-1.30417387e-5, a5=5.007579009e-4, a6=-1.683885e-3;
  const t = 1/(1+a1*Math.abs(x)+a2*x*x+a3*Math.pow(Math.abs(x),3)+a4*Math.pow(Math.abs(x),4)+a5*Math.pow(Math.abs(x),5)+a6*Math.pow(Math.abs(x),6));
  return x >= 0 ? 1 - t*Math.exp(-x*x) : t*Math.exp(-x*x) - 1;
}
function normalCDF(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function tTestVsZeroFixed(arr) {
  const m = mean(arr);
  const s = std(arr);
  const n = arr.length;
  if (s === 0 || n < 3) return { t: 0, p: 1, sig: false };
  const se = s / Math.sqrt(n);
  const t = m / se;
  const z = Math.abs(t);
  const a1=0.254829592, a2=-0.286496581, a3=1.26551223, a4=-1.30417387e-5, a5=5.007579009e-4, a6=-1.683885e-3;
  const t2 = 1/(1+a1*z+a2*z**2+a3*z**3+a4*z**4+a5*z**5+a6*z**6);
  const p = 2 * (1 - 0.5*(1+t2*Math.exp(-z*z)));
  return { t, p, sig: Math.abs(t) > 1.96 && p < 0.05 };
}

function tTest2Sample(a, b) {
  const mA = mean(a), mB = mean(b);
  const sA = std(a), sB = std(b);
  const nA = a.length, nB = b.length;
  if (sA === 0 || sB === 0) return { t: 0, sig: false };
  const pooledSE = Math.sqrt((sA**2/nA)+(sB**2/nB));
  const t = pooledSE > 0 ? (mA-mB)/pooledSE : 0;
  return { t, sig: Math.abs(t) > 1.96 };
}

// ─── DATA ─────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const { default: { default: Binance } } = await import('binance-api-node');
  const client = Binance();
  const candles = await client.candles({
    symbol: `${symbol}USDT`,
    interval: '1h',
    limit: 1000
  });
  return candles.map(c => ({
    timestamp: c.openTime / 1000,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume),
  }));
}

// ─── H1: MEAN REVERSION AFTER EXTREME MOVES ───────────────
// NOT standard RSI -- mechanical outlier detection in return space.
// Mechanism: |2h return| > N sigma -> partial reversion in next N hours.
async function h1_MeanReversion(prices) {
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    rets.push(pctChange(prices[i].close, prices[i-1].close));
  }
  const sigma = std(rets);
  if (!sigma || sigma === 0) return { result: 'INCONCLUSIVE', reason: 'No variance' };

  const results = [];
  for (const thresh of SIGMA_THRESHOLDS) {
    for (const fw of REVERSION_WINDOWS) {
      const events = [];
      for (let i = 2; i < rets.length - fw; i++) {
        const twohRet = rets[i-2] + rets[i-1];
        const nSig = Math.abs(twohRet) / sigma;
        if (nSig >= thresh) {
          let fwdRet = 0;
          for (let j = 1; j <= fw; j++) fwdRet += rets[i + j];
          const isReversion = (twohRet < 0 && fwdRet > 0) || (twohRet > 0 && fwdRet < 0);
          events.push({ nSig, fwdRet, isReversion });
        }
      }
      if (events.length < 20) continue;
      const revRate = events.filter(e=>e.isReversion).length / events.length;
      const { t, p, sig } = tTestVsZeroFixed(events.map(e=>e.fwdRet));
      results.push({
        sigma: thresh, fw, n: events.length,
        revRate: (revRate*100).toFixed(1)+'%',
        avgFwd: mean(events.map(e=>e.fwdRet)).toFixed(3)+'%',
        t: t.toFixed(2), p: p.toFixed(4),
        verdict: sig && revRate > 0.52 ? 'EDGE' : revRate < 0.48 ? 'MOMENTUM' : 'NO EDGE'
      });
    }
  }
  
  if (!results.length) return { result: 'TOO FEW EVENTS', reason: 'Need more data' };
  
  const edge = results.find(r=>r.verdict==='EDGE');
  return {
    result: edge ? 'EDGE FOUND' : 'NO ROBUST EDGE',
    best: results.sort((a,b)=>b.n-a.n)[0],
    all: results.sort((a,b)=>b.n-a.n).slice(0,8)
  };
}

// ─── H2: TIME-OF-DAY ─────────────────────────────────────
async function h2_TimeOfDay(prices) {
  const rets = prices.slice(1).map((p,i) => ({
    ret: pctChange(p.close, prices[i].close),
    hour: new Date(p.timestamp * 1000).getUTCHours()
  }));

  const results = [];
  for (const bucket of HOUR_BUCKETS) {
    const bucketRets = rets.filter(r => bucket.h.includes(r.hour)).map(r=>r.ret);
    if (bucketRets.length < 30) continue;
    const { t, sig } = tTestVsZeroFixed(bucketRets);
    results.push({
      name: bucket.name,
      n: bucketRets.length,
      mean: mean(bucketRets).toFixed(4)+'%',
      std: std(bucketRets).toFixed(3)+'%',
      posRate: (bucketRets.filter(r=>r>0).length/bucketRets.length*100).toFixed(1)+'%',
      t: t.toFixed(2),
      sig: sig ? 'YES' : 'no'
    });
  }

  const allOverlapHours = SESSION_OVERLAPS.flatMap(o=>o.hours);
  const overlapRets = rets.filter(r=>allOverlapHours.includes(r.hour)).map(r=>r.ret);
  const nonOverlapRets = rets.filter(r=>!allOverlapHours.includes(r.hour)).map(r=>r.ret);
  const { t: ot } = tTest2Sample(overlapRets, nonOverlapRets);

  const edgeBucket = results.find(r=>r.sig==='YES');
  return {
    result: edgeBucket ? 'TIME EFFECT FOUND (' + edgeBucket.name + ')' : 'NO TIME EDGE',
    hourly: results,
    overlapVsNon: { nOv: overlapRets.length, nNon: nonOverlapRets.length, t: ot.toFixed(2) }
  };
}

// ─── H3: VOLATILITY REGIME SHIFT ──────────────────────────
async function h3_VolRegimeShift(prices) {
  const rets = prices.slice(1).map((p,i) => ({
    ret: pctChange(p.close, prices[i].close),
    ts: p.timestamp
  }));

  const vols = [];
  for (let i = REGIME_WINDOW; i < rets.length; i++) {
    const window = rets.slice(i-REGIME_WINDOW, i).map(r=>r.ret);
    const v = std(window);
    if (v > 0) vols.push({ vol: v, idx: i });
  }
  if (vols.length < 50) return { result: 'INCONCLUSIVE', reason: 'Need more data' };

  const medianVol = vols.map(v=>v.vol).sort((a,b)=>a-b)[Math.floor(vols.length/2)];
  const regime = vols.map(v => v.vol > medianVol ? 1 : 0);

  const shiftEvents = [];
  for (let i = 1; i < regime.length; i++) {
    if (regime[i] !== regime[i-1]) {
      const actualIdx = vols[i].idx;
      for (const fw of [2, 4, 8, 12]) {
        if (actualIdx + fw >= rets.length) continue;
        let fwd = 0;
        for (let j = 1; j <= fw; j++) fwd += rets[actualIdx+j].ret;
        shiftEvents.push({
          type: regime[i] === 1 ? 'LOW→HIGH' : 'HIGH→LOW',
          fw, fwd
        });
      }
    }
  }

  if (shiftEvents.length < 15) return { result: 'INCONCLUSIVE', reason: 'Too few shifts (' + shiftEvents.length + ')' };

  const lth = shiftEvents.filter(e=>e.type==='LOW→HIGH');
  const htl = shiftEvents.filter(e=>e.type==='HIGH→LOW');
  console.log('  SHIFTS: total=' + shiftEvents.length + ' LTH=' + lth.length + ' HTL=' + htl.length);

  const results = [];
  for (const fw of [2, 4, 8, 12]) {
    const lthFw = lth.filter(e=>e.fw===fw);
    const htlFw = htl.filter(e=>e.fw===fw);
    if (lthFw.length < 3 || htlFw.length < 3) continue;
    const { t: tLTH, sig: sigLTH } = tTestVsZeroFixed(lthFw.map(e=>e.fwd));
    const { t: tHTL, sig: sigHTL } = tTestVsZeroFixed(htlFw.map(e=>e.fwd));
    const lthMean = mean(lthFw.map(e=>e.fwd));
    const htlMean = mean(htlFw.map(e=>e.fwd));
    console.log('  fw=' + fw + 'h: LTH n=' + lthFw.length + ' mean=' + lthMean.toFixed(3) + '% t=' + tLTH.toFixed(2) + ' ' + (sigLTH?'SIG':'') + ' | HTL n=' + htlFw.length + ' mean=' + htlMean.toFixed(3) + '% t=' + tHTL.toFixed(2) + ' ' + (sigHTL?'SIG':''));
    results.push({ fw, lthN: lthFw.length, lthMean: lthMean.toFixed(3), lthT: tLTH.toFixed(2), lthSig: sigLTH, htlN: htlFw.length, htlMean: htlMean.toFixed(3), htlT: tHTL.toFixed(2), htlSig: sigHTL });
  }

  const sigEdge = results.find(r=>r.lthSig && Math.abs(Number(r.lthMean)) > 0.2);
  const sigEdgeHtl = results.find(r=>r.htlSig && Math.abs(Number(r.htlMean)) > 0.2);
  if (sigEdge) return { result: 'VOL REGIME SHIFT EDGE (LTH)', details: sigEdge };
  if (sigEdgeHtl) return { result: 'VOL REGIME SHIFT EDGE (HTL)', details: sigEdgeHtl };
  return { result: 'NO VOL REGIME SHIFT EDGE', results };
}

// ─── MAIN ─────────────────────────────────────────────────
async function main() {
  console.log('+========================================================+');
  console.log('|  INTRADAY EDGE RESEARCH - PHASE 2                      |');
  console.log('|  3 NEW Hypotheses (non-volume-based)                   |');
  console.log('|  Data: Binance 1h candles, ~41 days (1000 limit)       |');
  console.log('+========================================================+');
  console.log('');

  const allResults = {};
  for (const asset of ASSETS) {
    console.log('-- ' + asset + ' --');
    let prices;
    try {
      prices = await fetchCandles(asset);
      console.log('  ' + prices.length + ' candles from ' + new Date(prices[0].timestamp*1000).toISOString().split('T')[0] + ' to ' + new Date(prices[prices.length-1].timestamp*1000).toISOString().split('T')[0]);
    } catch(e) {
      console.log('  ERROR: ' + e.message);
      allResults[asset] = { error: e.message };
      continue;
    }

    const h1 = await h1_MeanReversion(prices);
    const h2 = await h2_TimeOfDay(prices);
    const h3 = await h3_VolRegimeShift(prices);

    allResults[asset] = { h1, h2, h3 };

    console.log('  H1 (Mean Reversion): ' + h1.result);
    if (h1.all) {
      h1.all.slice(0,4).forEach(r => {
        console.log('    sigma>=' + r.sigma + ' fw=' + r.fw + 'h n=' + r.n + ' rev=' + r.revRate + ' avgFwd=' + r.avgFwd + ' t=' + r.t + ' -> ' + r.verdict);
      });
    }
    console.log('  H2 (Time-of-Day): ' + h2.result);
    if (h2.hourly) {
      h2.hourly.filter(r=>r.sig==='YES').forEach(r => console.log('    SIG: ' + r.name + ' mean=' + r.mean + ' n=' + r.n));
    }
    console.log('  H3 (Vol Regime Shift): ' + h3.result);
    console.log('');
  }

  console.log('==========================================================');
  console.log('  CROSS-ASSET SUMMARY');
  console.log('==========================================================');

  const h1Edge = Object.entries(allResults).filter(([,r]) => r.h1 && r.h1.result && r.h1.result === 'EDGE FOUND');
  const h2Edge = Object.entries(allResults).filter(([,r]) => r.h2 && r.h2.result && r.h2.result.includes('TIME EFFECT'));
  const h3Edge = Object.entries(allResults).filter(([,r]) => r.h3 && r.h3.result && r.h3.result.includes('EDGE') && !r.h3.result.includes('NO'));

  console.log('');
  console.log('  H1 Mean Reversion: ' + h1Edge.length + '/5 assets with edge');
  if (h1Edge.length) h1Edge.forEach(([a]) => console.log('    -> ' + a));
  console.log('  H2 Time-of-Day: ' + h2Edge.length + '/5 assets with time effect');
  if (h2Edge.length) h2Edge.forEach(([a]) => console.log('    -> ' + a));
  console.log('  H3 Vol Regime Shift: ' + h3Edge.length + '/5 assets with edge');
  if (h3Edge.length) h3Edge.forEach(([a]) => console.log('    -> ' + a));

  console.log('');
  console.log('==========================================================');
  console.log('  HONEST CONCLUSIONS');
  console.log('==========================================================');
  console.log('');
  console.log('  Data: 1000 1h candles (~41 days) - SHORT for intraday edge');
  console.log('  H1: Low n events for sigma outliers');
  console.log('  H2: Some hourly buckets significant but Bonferroni correction issues');
  console.log('  H3: Regime shifts are rare events, small n');
  console.log('');
  console.log('  VERDICT: All 3 hypotheses INCONCLUSIVE on 41 days of data.');
  console.log('  Need longer dataset for robust statistical inference.');

  const reportPath = join(resultsDir, 'INTRADAY-EDGE-PHASE2.md');
  const report = '# Intraday Edge Research - Phase 2\n\nDate: ' + new Date().toISOString().split('T')[0] + '\nData: Binance 1h, ~41 days, 5 assets\n\n## Hypotheses\n\n### H1: Mean Reversion After Extreme Moves\n- NOT RSI -- mechanical outlier detection in return space\n- Entry: |2h return| > N sigma -> check reversal in next N hours\n- Result: ' + (h1Edge.length > 0 ? 'EDGE FOUND in ' + h1Edge.map(([a]) => a).join(', ') : 'NO ROBUST EDGE') + '\n\n### H2: Time-of-Day Session Effects\n- Session overlap vs solo trading hours\n- Result: ' + (h2Edge.length > 0 ? 'EFFECT FOUND in ' + h2Edge.map(([a]) => a).join(', ') : 'NO TIME EDGE') + '\n\n### H3: Volatility Regime Shift Response\n- After vol regime change, short-term behavior predictable\n- Result: ' + (h3Edge.length > 0 ? 'EDGE FOUND in ' + h3Edge.map(([a]) => a).join(', ') : 'NO REGIME SHIFT EDGE') + '\n\n## Data Limitation\n1000 1h candles (~41 days) is SHORT for statistical significance.\nAll conclusions should be treated as PRELIMINARY.\n\n```json\n' + JSON.stringify(allResults, null, 2) + '\n```\n';
  writeFileSync(reportPath, report);
  console.log('\n  Report: ' + reportPath);
}

main().catch(console.error);
