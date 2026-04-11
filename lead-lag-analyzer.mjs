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
    c: parseFloat(k[4])
  }));
}

function avg(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }
function std(arr) { const m=avg(arr); return Math.sqrt(avg(arr.map(x=>(x-m)**2))); }
function corr(a, b) {
  if (a.length !== b.length || a.length < 3) return 0;
  const ma = avg(a), mb = avg(b);
  const sa = std(a), sb = std(b);
  if (sa < 1e-10 || sb < 1e-10) return 0;
  return avg(a.map((x,i) => (x-ma)*(b[i]-mb))) / (sa * sb);
}

async function main() {
  console.log('Fetching candles for BTC, ETH, BNB, SOL...');
  const [rawBTC, rawETH, rawBNB, rawSOL] = await Promise.all([
    fetchCandles('BTCUSDT', '15m', 10000),
    fetchCandles('ETHUSDT', '15m', 10000),
    fetchCandles('BNBUSDT', '15m', 10000),
    fetchCandles('SOLUSDT', '15m', 10000),
  ]);
  
  const btc = parseKlines(rawBTC);
  const eth = parseKlines(rawETH);
  const bnb = parseKlines(rawBNB);
  const sol = parseKlines(rawSOL);
  
  console.log(`BTC: ${btc.length} | ETH: ${eth.length} | BNB: ${bnb.length} | SOL: ${sol.length}`);
  
  // Index candles by timestamp
  const btcByT = {}, ethByT = {}, bnbByT = {}, solByT = {};
  btc.forEach(c => btcByT[c.t] = c);
  eth.forEach(c => ethByT[c.t] = c);
  bnb.forEach(c => bnbByT[c.t] = c);
  sol.forEach(c => solByT[c.t] = c);
  
  // Common timestamps
  const commonT = btc.map(c => c.t).filter(t => ethByT[t] && bnbByT[t] && solByT[t]);
  console.log(`Common timestamps: ${commonT.length}`);
  
  const btcRet = commonT.map(t => (btcByT[t].c - btcByT[t].o) / btcByT[t].o * 100);
  const ethRet = commonT.map(t => (ethByT[t].c - ethByT[t].o) / ethByT[t].o * 100);
  const bnbRet = commonT.map(t => (bnbByT[t].c - bnbByT[t].o) / bnbByT[t].o * 100);
  const solRet = commonT.map(t => (solByT[t].c - solByT[t].o) / solByT[t].o * 100);
  
  // Event study
  const horizons = [
    { name: '15m',  candles: 1 },
    { name: '30m',  candles: 2 },
    { name: '1h',   candles: 4 },
    { name: '2h',   candles: 8 },
  ];
  const altData = { ETH: ethRet, BNB: bnbRet, SOL: solRet };
  const altNames = ['ETH', 'BNB', 'SOL'];
  
  console.log('\n=== EVENT STUDY: BTC >+1% or <-1% move ===');
  
  const btcEvents = btcRet.map((r, i) => ({ i, btc: r })).filter(e => Math.abs(e.btc) >= 1);
  console.log(`Total BTC events: ${btcEvents.length} (${btcEvents.filter(e=>e.btc>0).length} up, ${btcEvents.filter(e=>e.btc<0).length} down)`);
  
  const results = {};
  
  for (const alt of altNames) {
    results[alt] = {};
    const altRet = altData[alt];
    
    for (const h of horizons) {
      const altUp = [], altDown = [];
      
      btcEvents.forEach(ev => {
        const j = ev.i + h.candles;
        if (j < commonT.length) {
          if (ev.btc > 1) altUp.push(altRet[j]);
          else altDown.push(altRet[j]);
        }
      });
      
      const avgAltUp = avg(altUp);
      const avgAltDown = avg(altDown);
      const sameDirUp = avgAltUp > 0 ? avg(altUp.map(r => r > 0 ? 1 : 0)) * 100 : 0;
      const oppDirDown = avgAltDown < 0 ? avg(altDown.map(r => r < 0 ? 1 : 0)) * 100 : 0;
      
      // Correlation at horizon (BTC lead)
      const btcH = btcRet.map((r, i) => ({ btc: r, alt: altRet[i] }))
        .filter((x, i) => i + h.candles < commonT.length)
        .map(x => ({ btc: x.btc, alt: altRet[commonT.indexOf(commonT[btcRet.indexOf(x.btc)]) + h.candles] || 0 }));
      
      // Actually simpler: for each index i where BTC has event, look at ALT at i+h
      const btcArr = [], altArr = [];
      btcEvents.forEach(ev => {
        const j = ev.i + h.candles;
        if (j < commonT.length) {
          btcArr.push(btcRet[j]);
          altArr.push(altRet[j]);
        }
      });
      const correlation = corr(btcArr, altArr);
      
      results[alt][h.name] = {
        nUp: altUp.length, nDown: altDown.length,
        avgAltUp, avgAltDown,
        sameDirUp, oppDirDown,
        correlation
      };
    }
  }
  
  console.log(`\nAlt | Horizon | nUp | avgAltUp% | sameDir% | nDown | avgAltDown% | oppDir% | corr`);
  console.log('----|---------|-----|-----------|----------|-------|------------|---------|------');
  
  Object.entries(results).forEach(([alt, horizons]) => {
    Object.entries(horizons).forEach(([hName, r]) => {
      const upSign = r.avgAltUp > 0 ? '+' : '';
      const dnSign = r.avgAltDown > 0 ? '+' : '';
      console.log(`${alt} | ${hName.padEnd(7)} | ${String(r.nUp).padStart(3)} | ${(upSign+r.avgAltUp.toFixed(3)).padStart(10)} | ${r.sameDirUp.toFixed(1).padStart(8)}% | ${String(r.nDown).padStart(5)} | ${(dnSign+r.avgAltDown.toFixed(3)).padStart(12)} | ${r.oppDirDown.toFixed(1).padStart(7)}% | ${r.correlation.toFixed(4)}`);
    });
  });
  
  // Cross-correlation at lags
  console.log('\n=== CROSS-CORRELATION (BTC leads at positive lag) ===');
  console.log('Lag(h) | Description      | ETH    | BNB    | SOL');
  console.log('-------|------------------|--------|--------|------');
  
  for (let lag = -8; lag <= 8; lag++) {
    const btcLagged = btcRet.slice(Math.max(0, lag), Math.min(btcRet.length, btcRet.length + lag));
    const ethLagged = lag >= 0 
      ? ethRet.slice(Math.max(0, -lag), ethRet.length - Math.max(0, lag))
      : ethRet.slice(0, ethRet.length + lag);
    const bnbLagged = lag >= 0 
      ? bnbRet.slice(Math.max(0, -lag), bnbRet.length - Math.max(0, lag))
      : bnbRet.slice(0, bnbRet.length + lag);
    const solLagged = lag >= 0 
      ? solRet.slice(Math.max(0, -lag), solRet.length - Math.max(0, lag))
      : solRet.slice(0, solRet.length + lag);
    
    const minLen = Math.min(btcLagged.length, ethLagged.length, bnbLagged.length, solLagged.length);
    
    const cETH = corr(btcLagged.slice(0,minLen), ethLagged.slice(0,minLen));
    const cBNB = corr(btcLagged.slice(0,minLen), bnbLagged.slice(0,minLen));
    const cSOL = corr(btcLagged.slice(0,minLen), solLagged.slice(0,minLen));
    
    const lagHours = (lag * 15 / 60).toFixed(1);
    const desc = lag > 0 ? `BTC leads ${lagHours}h` : lag < 0 ? `ALT leads ${(-lagHours)}h` : 'same time';
    console.log(`${String(lag).padStart(3)}     | ${desc.padEnd(15)} | ${cETH.toFixed(4).padStart(6)} | ${cBNB.toFixed(4).padStart(6)} | ${cSOL.toFixed(4)}`);
  }
  
  // Key findings
  console.log('\n=== KEY FINDINGS ===');
  
  Object.entries(results).forEach(([alt, horizons]) => {
    const h1 = horizons['1h'];
    console.log(`\n${alt} at 1h horizon:`);
    console.log(`  After BTC +1%: ALT avg = ${h1.avgAltUp > 0 ? '+' : ''}${h1.avgAltUp.toFixed(3)}% (same dir: ${h1.sameDirUp.toFixed(1)}%)`);
    console.log(`  After BTC -1%: ALT avg = ${h1.avgAltDown > 0 ? '+' : ''}${h1.avgAltDown.toFixed(3)}% (opposite dir: ${h1.oppDirDown.toFixed(1)}%)`);
    console.log(`  Correlation: ${h1.correlation.toFixed(4)}`);
    console.log(`  Verdict: ${Math.abs(h1.avgAltUp) > 0.3 && Math.abs(h1.avgAltDown) > 0.3 ? 'CONSISTENT DIRECTION' : 'WEAK/INCONSISTENT RESPONSE'}`);
  });
  
  let md = `# BTC Lead-Lag Analysis (15m candles)

**Data:** ~100 days, ${new Date(btc[0].t).toISOString()} to ${new Date(btc[btc.length-1].t).toISOString()}
**Common candles:** ${commonT.length}

## Event Study: BTC >+1% or <-1% moves

| Alt | Horizon | nUp | avgAltUp% | sameDir% | nDown | avgAltDown% | oppDir% | corr |
|-----|---------|-----|-----------|----------|-------|------------|---------|------|
`;
  
  Object.entries(results).forEach(([alt, horizons]) => {
    Object.entries(horizons).forEach(([hName, r]) => {
      const upSign = r.avgAltUp > 0 ? '+' : '';
      const dnSign = r.avgAltDown > 0 ? '+' : '';
      md += `| ${alt} | ${hName} | ${r.nUp} | ${upSign+r.avgAltUp.toFixed(3)} | ${r.sameDirUp.toFixed(1)}% | ${r.nDown} | ${dnSign+r.avgAltDown.toFixed(3)} | ${r.oppDirDown.toFixed(1)}% | ${r.correlation.toFixed(4)} |\n`;
    });
  });
  
  md += `
## Cross-Correlation (BTC vs ALT returns)

Positive lag = BTC leads ALT. Peak at lag > 0 would suggest BTC leads.

## Key Findings

`;
  
  Object.entries(results).forEach(([alt, horizons]) => {
    const h1 = horizons['1h'];
    md += `**${alt} at 1h horizon:** BTC +1% -> ALT avg ${h1.avgAltUp > 0 ? '+' : ''}${h1.avgAltUp.toFixed(3)}% (same: ${h1.sameDirUp.toFixed(1)}%), BTC -1% -> ALT avg ${h1.avgAltDown > 0 ? '+' : ''}${h1.avgAltDown.toFixed(3)}% (opp: ${h1.oppDirDown.toFixed(1)}%), corr=${h1.correlation.toFixed(4)}\n`;
  });
  
  md += `
## Interpretation

What would "BTC leads alts" look like?
- After BTC +1%: alts also positive (same direction, ${'>'}-0.3% avg)
- After BTC -1%: alts also negative (same direction, ${'<'}-0.3% avg)
- Cross-correlation peaks at positive lag

What would "NO lead-lag" look like?
- Correlation near zero at all lags
- BTC events produce inconsistent/no ALT response
`;
  
  writeFileSync('/home/node/.openclaw/workspace/crypto-live-validator/results/LEAD-LAG.md', md);
  console.log('\nSaved to results/LEAD-LAG.md');
}

main().catch(console.error);
