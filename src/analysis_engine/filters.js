/**
 * NEXUS — Fake Move / Manipulation Filter
 * Detects stop hunts, breakout failures, whipsaws, anomalous bars.
 */
const { calcATR } = require('./indicators');

function detectFakeMoves(candles, lookback = 20) {
  if (candles.length < lookback + 5) return { blocked: false, probability: 0, reasons: [] };
  const reasons = [];
  let fakeProb = 0;
  const atr = calcATR(candles, 14);
  const currentATR = atr[atr.length - 1] || 1;
  const recent = candles.slice(-lookback);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // 1. Long-wick stop hunt
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const body = Math.abs(last.close - last.open);
  if (upperWick > body * 2 && upperWick > currentATR * 0.8) { fakeProb += 0.25; reasons.push('Long upper wick — possible stop hunt above'); }
  if (lowerWick > body * 2 && lowerWick > currentATR * 0.8) { fakeProb += 0.25; reasons.push('Long lower wick — possible stop hunt below'); }

  // 2. Breakout failure (broke level but closed back inside)
  let recentHigh = -Infinity, recentLow = Infinity;
  for (let i = 0; i < recent.length - 1; i++) {
    recentHigh = Math.max(recentHigh, recent[i].high);
    recentLow = Math.min(recentLow, recent[i].low);
  }
  if (last.high > recentHigh && last.close < recentHigh) { fakeProb += 0.20; reasons.push('Breakout failure above — closed back inside range'); }
  if (last.low < recentLow && last.close > recentLow) { fakeProb += 0.20; reasons.push('Breakout failure below — closed back inside range'); }

  // 3. Anomalous range bar (> 3x ATR)
  const lastRange = last.high - last.low;
  if (lastRange > currentATR * 3) { fakeProb += 0.15; reasons.push(`Anomalous range bar (${(lastRange / currentATR).toFixed(1)}x ATR)`); }

  // 4. Volume spike without continuation
  const avgVol = recent.slice(0, -1).reduce((s, c) => s + c.volume, 0) / (recent.length - 1);
  if (last.volume > avgVol * 2.5 && body < currentATR * 0.3) { fakeProb += 0.15; reasons.push('High volume + tiny body — absorption/manipulation'); }

  // 5. Repeated whipsaw (3+ direction changes in last 5 candles)
  let dirChanges = 0;
  for (let i = candles.length - 5; i < candles.length - 1; i++) {
    if (i < 1) continue;
    const curr = candles[i].close > candles[i].open ? 1 : -1;
    const nxt = candles[i + 1].close > candles[i + 1].open ? 1 : -1;
    if (curr !== nxt) dirChanges++;
  }
  if (dirChanges >= 3) { fakeProb += 0.15; reasons.push('Whipsaw — repeated direction changes'); }

  // 6. Structure break with poor close
  if (last.high > recentHigh && (last.close - last.low) / (last.high - last.low) < 0.3) {
    fakeProb += 0.10; reasons.push('Broke high but poor close position');
  }

  fakeProb = Math.min(1, fakeProb);
  return { blocked: fakeProb >= 0.45, probability: Math.round(fakeProb * 100) / 100, reasons };
}

module.exports = { detectFakeMoves };
