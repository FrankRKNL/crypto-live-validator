import { writeFileSync } from 'fs';

async function fetchCandles(symbol, interval = '15m', limit = 1000, endTime = null) {
  let all = [];
  let cursor = endTime;
  
  while (all.length < limit * 3) {
    const url = cursor 
      ? `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000&endTime=${cursor}`
      : `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`;
    
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    
    all = [...data, ...all];
    cursor = data[0][0] - 1;
    
    if (data.length < 1000) break;
    await new Promise(r => setTimeout(r, 100));
  }
  
  return all.slice(-limit);
}

function parseKlines(raw) {
  return raw.map(k => ({
    t: k[0],
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5])
  }));
}

function avg(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }
function std(arr) { const m=avg(arr); return Math.sqrt(avg(arr.map(x=>(x-m)**2))); }

async function main() {
  console.log('Fetching BTC 15m candles...');
  const rawBTC = await fetchCandles('BTCUSDT', '15m', 10000);
  const candles = parseKlines(rawBTC);
  console.log(`Got ${candles.length} candles: ${new Date(candles[0].t).toISOString()} → ${new Date(candles[candles.length-1].t).toISOString()}`);
  
  const H = Array.from({length: 24}, () => ({
    ranges: [], absReturns: [], returns: [], bullish: [], next1h: [], next4h: []
  }));
  
  candles.forEach((c, i) => {
    const h = new Date(c.t).getUTCHours();
    const range = (c.h - c.l) / c.o * 100;
    const ret = (c.c - c.o) / c.o * 100;
    const absRet = Math.abs(ret);
    const bullish = c.c > c.o ? 1 : 0;
    const next1h = i + 4 < candles.length ? (candles[i+4].c - c.c) / c.c * 100 : null;
    const next4h = i + 16 < candles.length ? (candles[i+16].c - c.c) / c.c * 100 : null;
    
    H[h].ranges.push(range);
    H[h].absReturns.push(absRet);
    H[h].returns.push(ret);
    H[h].bullish.push(bullish);
    if (next1h !== null) H[h].next1h.push(next1h);
    if (next4h !== null) H[h].next4h.push(next4h);
  });
  
  const S = H.map((b, hour) => ({
    hour,
    n: b.ranges.length,
    avgRange: avg(b.ranges),
    stdRange: std(b.ranges),
    avgAbsReturn: avg(b.absReturns),
    avgReturn: avg(b.returns),
    stdReturn: std(b.returns),
    bullishPct: avg(b.bullish) * 100,
    avgNext1h: avg(b.next1h),
    avgNext4h: avg(b.next4h),
    _ranges: b.ranges,
    _returns: b.returns
  }));
  
  const sessions = [
    ['US Overlap (14-21 UTC)', [14,15,16,17,18,19,20,21]],
    ['US Open burst (14-16)',   [14,15,16]],
    ['US Close (20-21)',        [20,21]],
    ['Pre-US (11-14)',          [11,12,13]],
    ['Post-US (22-02)',         [22,23,0,1,2]],
    ['Asian quiet (03-07)',     [3,4,5,6,7]],
    ['Full Day (baseline)',     [...Array(24).keys()]],
  ];
  
  console.log('\n=== HOURLY VOLATILITY PROFILE (BTC 15m, UTC) ===');
  console.log('Hour | n    | AvgRange% | StdRange | Avg|Ret%|  Bull%  | Next1h%  | Next4h%');
  console.log('-----|------|-----------|----------|---------|--------|----------|----------');
  S.forEach(s => {
    console.log(`${String(s.hour).padStart(4)} | ${String(s.n).padStart(4)} | ${s.avgRange.toFixed(4).padStart(9)} | ${s.stdRange.toFixed(4).padStart(8)} | ${s.avgAbsReturn.toFixed(4).padStart(7)} | ${s.bullishPct.toFixed(2).padStart(6)}% | ${s.avgNext1h.toFixed(4).padStart(8)} | ${s.avgNext4h.toFixed(4).padStart(8)}`);
  });
  
  console.log('\n=== SESSION COMPARISON ===');
  console.log('Session                | AvgRange% | Avg|Ret%|  Bull%  | Next1h%  | Next4h%');
  console.log('-----------------------|-----------|---------|--------|----------|----------');
  
  sessions.forEach(([name, hrs]) => {
    const bs = hrs.map(h => S[h]);
    const avgRange = avg(bs.map(b => b.avgRange));
    const avgAbs = avg(bs.map(b => b.avgAbsReturn));
    const bullish = avg(bs.map(b => b.bullishPct));
    const next1h = avg(bs.map(b => b.avgNext1h));
    const next4h = avg(bs.map(b => b.avgNext4h));
    console.log(`${name.padEnd(22)} | ${avgRange.toFixed(4).padStart(9)} | ${avgAbs.toFixed(4).padStart(7)} | ${bullish.toFixed(2).padStart(6)}% | ${next1h.toFixed(4).padStart(8)} | ${next4h.toFixed(4).padStart(8)}`);
  });
  
  const usIdx = [14,15,16,17,18,19,20,21];
  const nonUsIdx = [...Array(24).keys()].filter(h => !usIdx.includes(h));
  
  const usR = [].concat(...usIdx.map(h => S[h]._ranges));
  const nonUsR = [].concat(...nonUsIdx.map(h => S[h]._ranges));
  const usRet = [].concat(...usIdx.map(h => S[h]._returns));
  const nonUsRet = [].concat(...nonUsIdx.map(h => S[h]._returns));
  
  function welchT(a, b) {
    const m1 = avg(a), m2 = avg(b);
    const v1 = std(a)**2/a.length, v2 = std(b)**2/b.length;
    const se = Math.sqrt(v1/a.length + v2/b.length);
    const t = se > 0 ? (m1 - m2) / se : 0;
    return { t: t.toFixed(3), sig: Math.abs(t) > 1.96 };
  }
  
  const tRange = welchT(usR, nonUsR);
  const tRet = welchT(usRet, nonUsRet);
  
  function cohensD(a, b) {
    const pooledStd = Math.sqrt(((a.length-1)*std(a)**2 + (b.length-1)*std(b)**2) / (a.length+b.length-2));
    return pooledStd > 0 ? (avg(a) - avg(b)) / pooledStd : 0;
  }
  
  console.log('\n=== SIGNIFICANCE: US OVERLAP vs NON-US ===');
  console.log(`Avg Range: US=${avg(usR).toFixed(4)}% vs non-US=${avg(nonUsR).toFixed(4)}%  t=${tRange.t} sig=${tRange.sig}`);
  console.log(`Avg Return: US=${avg(usRet).toFixed(4)}% vs non-US=${avg(nonUsRet).toFixed(4)}%  t=${tRet.t} sig=${tRet.sig}`);
  console.log(`Cohen's d (range): ${cohensD(usR, nonUsR).toFixed(4)}`);
  console.log(`Cohen's d (return): ${cohensD(usRet, nonUsRet).toFixed(4)}`);
  
  const byRange = [...S].sort((a,b) => b.avgRange - a.avgRange);
  const byBull = [...S].sort((a,b) => b.bullishPct - a.bullishPct);
  const byNext1h = [...S].sort((a,b) => b.avgNext1h - a.avgNext1h);
  
  console.log('\n=== KEY FINDINGS ===');
  console.log(`Highest volatility: UTC ${byRange[0].hour}:00 (${byRange[0].avgRange.toFixed(4)}%) and UTC ${byRange[1].hour}:00 (${byRange[1].avgRange.toFixed(4)}%)`);
  console.log(`Lowest volatility:  UTC ${byRange[23].hour}:00 (${byRange[23].avgRange.toFixed(4)}%) and UTC ${byRange[22].hour}:00 (${byRange[22].avgRange.toFixed(4)}%)`);
  console.log(`Most bullish hour: UTC ${byBull[0].hour}:00 (${byBull[0].bullishPct.toFixed(1)}% bullish)`);
  console.log(`Most bearish hour: UTC ${byBull[23].hour}:00 (${byBull[23].bullishPct.toFixed(1)}% bullish)`);
  console.log(`Best 1h forward:   UTC ${byNext1h[0].hour}:00 (${byNext1h[0].avgNext1h.toFixed(4)}% avg next hour)`);
  
  const volRatio = (avg(usR) / avg(nonUsR) - 1) * 100;
  const output = `# Hourly Volatility Analysis (BTC 15m)

**Data:** ${candles.length} candles, ${new Date(candles[0].t).toISOString()} to ${new Date(candles[candles.length-1].t).toISOString()}

## Hourly Profile

| Hour (UTC) | n | AvgRange% | StdRange | AvgAbsRet% | Bull% | Next1h% | Next4h% |
|---|---|---|---|---|---|---|---|
${S.map(s => `| ${String(s.hour).padStart(2)}:00 | ${s.n} | ${s.avgRange.toFixed(4)} | ${s.stdRange.toFixed(4)} | ${s.avgAbsReturn.toFixed(4)} | ${s.bullishPct.toFixed(2)}% | ${s.avgNext1h.toFixed(4)} | ${s.avgNext4h.toFixed(4)} |`).join('\n')}

## Session Comparison

| Session | AvgRange% | AvgAbsRet% | Bull% | Next1h% | Next4h% |
|---|---|---|---|---|---|
${sessions.map(([name, hrs]) => {
  const bs = hrs.map(h => S[h]);
  return `| ${name} | ${avg(bs.map(b=>b.avgRange)).toFixed(4)} | ${avg(bs.map(b=>b.avgAbsReturn)).toFixed(4)} | ${avg(bs.map(b=>b.bullishPct)).toFixed(2)}% | ${avg(bs.map(b=>b.avgNext1h)).toFixed(4)} | ${avg(bs.map(b=>b.avgNext4h)).toFixed(4)} |`;
}).join('\n')}

## Significance Test (US Overlap vs Non-US)

| Metric | US Overlap | Non-US | t-stat | Significant (a=0.05) |
|---|---|---|---|---|
| Avg Range% | ${avg(usR).toFixed(4)} | ${avg(nonUsR).toFixed(4)} | ${tRange.t} | ${tRange.sig} |
| Avg Return% | ${avg(usRet).toFixed(4)} | ${avg(nonUsRet).toFixed(4)} | ${tRet.t} | ${tRet.sig} |

- Cohen's d (range): ${cohensD(usR, nonUsR).toFixed(4)}
- Cohen's d (return): ${cohensD(usRet, nonUsRet).toFixed(4)}

## Key Findings

- **Highest volatility:** UTC ${byRange[0].hour}:00 (${byRange[0].avgRange.toFixed(4)}%) and UTC ${byRange[1].hour}:00 (${byRange[1].avgRange.toFixed(4)}%)
- **Lowest volatility:** UTC ${byRange[23].hour}:00 (${byRange[23].avgRange.toFixed(4)}%) and UTC ${byRange[22].hour}:00 (${byRange[22].avgRange.toFixed(4)}%)
- **Most bullish hour:** UTC ${byBull[0].hour}:00 (${byBull[0].bullishPct.toFixed(1)}% bullish closes)
- **Most bearish hour:** UTC ${byBull[23].hour}:00 (${byBull[23].bullishPct.toFixed(1)}% bullish closes)
- **Best 1h forward return:** UTC ${byNext1h[0].hour}:00 (${byNext1h[0].avgNext1h.toFixed(4)}% avg next hour)
- **US overlap volatility vs non-US:** ${volRatio.toFixed(1)}% higher

## Interpretation

Data covers ~100 days (Dec 2025 - Apr 2026). The US market overlap (14-21 UTC):
- Volatility is ~${volRatio.toFixed(0)}% higher than non-US hours
- Directional bias is ${avg(usRet) > avg(nonUsRet) ? 'more positive' : 'more negative'} during US hours

**Caveats:** 100 days of 15m data (~416 samples/hour) is limited for tail event analysis. Need 6-12 months for robust significance on hourly patterns.
`;

  writeFileSync('/home/node/.openclaw/workspace/crypto-live-validator/results/HOURLY-VOLATILITY.md', output);
  console.log('\nSaved to results/HOURLY-VOLATILITY.md');
}

main().catch(console.error);
