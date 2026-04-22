/**
 * NEXUS — Volume & Institutional Flow Engine
 * OBV, CVD, CVD divergence, VSA, Volume Profile, absorption detection.
 */
const { calcOBV, calcCVD, calcEMA, calcATR } = require('./indicators');

function calculateVolumeProfile(candles, bins = 50) {
  if (!candles.length) return { poc: 0, vah: 0, val: 0, profile: [] };
  let minP = Infinity, maxP = -Infinity;
  for (const c of candles) { if (c.low < minP) minP = c.low; if (c.high > maxP) maxP = c.high; }
  const range = maxP - minP;
  if (range <= 0) return { poc: candles[0].close, vah: candles[0].close, val: candles[0].close, profile: [] };

  const step = range / bins;
  const profile = [];
  for (let i = 0; i < bins; i++) {
    profile.push({ priceLevel: minP + step * (i + 0.5), volume: 0 });
  }
  for (const c of candles) {
    const midPrice = (c.high + c.low) / 2;
    const idx = Math.min(bins - 1, Math.floor((midPrice - minP) / step));
    profile[idx].volume += c.volume;
  }
  let totalVol = profile.reduce((s, p) => s + p.volume, 0);
  for (const p of profile) p.percentage = totalVol > 0 ? p.volume / totalVol : 0;

  // POC
  const poc = profile.reduce((best, p) => p.volume > best.volume ? p : best, profile[0]);

  // Value Area (70%)
  const sorted = [...profile].sort((a, b) => b.volume - a.volume);
  let vaVol = 0;
  const vaLevels = [];
  for (const p of sorted) {
    vaVol += p.volume;
    vaLevels.push(p.priceLevel);
    if (vaVol >= totalVol * 0.7) break;
  }
  vaLevels.sort((a, b) => a - b);
  const vah = vaLevels[vaLevels.length - 1] || poc.priceLevel;
  const val = vaLevels[0] || poc.priceLevel;

  return { poc: Math.round(poc.priceLevel * 100) / 100, vah: Math.round(vah * 100) / 100, val: Math.round(val * 100) / 100, profile };
}

function detectVSA(candles, lookback = 20) {
  const signals = [];
  if (candles.length < lookback) return signals;
  const recent = candles.slice(-lookback);
  const avgVol = recent.reduce((s, c) => s + c.volume, 0) / lookback;
  const avgRange = recent.reduce((s, c) => s + (c.high - c.low), 0) / lookback;

  for (let i = 1; i < recent.length; i++) {
    const c = recent[i];
    const vol = c.volume;
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const isBull = c.close > c.open;
    const highVol = vol > avgVol * 1.5;
    const narrowSpread = range < avgRange * 0.6;
    const wideSpread = range > avgRange * 1.4;

    if (highVol && wideSpread && isBull) signals.push({ type: 'buying_climax', index: candles.length - lookback + i });
    else if (highVol && wideSpread && !isBull) signals.push({ type: 'selling_climax', index: candles.length - lookback + i });
    else if (highVol && narrowSpread && isBull) signals.push({ type: 'absorption_bullish', index: candles.length - lookback + i });
    else if (highVol && narrowSpread && !isBull) signals.push({ type: 'absorption_bearish', index: candles.length - lookback + i });
    else if (!highVol && vol < avgVol * 0.5 && wideSpread && isBull) signals.push({ type: 'no_demand', index: candles.length - lookback + i });
    else if (!highVol && vol < avgVol * 0.5 && wideSpread && !isBull) signals.push({ type: 'no_supply', index: candles.length - lookback + i });
  }
  return signals;
}

function detectCVDDivergence(candles, lookback = 30) {
  const cvd = calcCVD(candles);
  const closes = candles.map(c => c.close);
  if (closes.length < lookback) return null;

  const priceSlice = closes.slice(-lookback);
  const cvdSlice = cvd.slice(-lookback);

  // Find local highs/lows in both
  const priceHigh1 = Math.max(...priceSlice.slice(0, Math.floor(lookback / 2)));
  const priceHigh2 = Math.max(...priceSlice.slice(Math.floor(lookback / 2)));
  const cvdHigh1 = Math.max(...cvdSlice.slice(0, Math.floor(lookback / 2)));
  const cvdHigh2 = Math.max(...cvdSlice.slice(Math.floor(lookback / 2)));

  if (priceHigh2 > priceHigh1 && cvdHigh2 < cvdHigh1) return 'bearish_divergence';
  if (priceHigh2 < priceHigh1 && cvdHigh2 > cvdHigh1) return 'bullish_divergence';
  return null;
}

function calculateVolumeScore(candles1h, candles4h, direction) {
  let score = 0.5;
  const obv1h = calcOBV(candles1h);
  const obvSlope = obv1h.length > 5 ? obv1h[obv1h.length - 1] - obv1h[obv1h.length - 6] : 0;
  if (direction === 'long' && obvSlope > 0) score += 0.10;
  if (direction === 'short' && obvSlope < 0) score += 0.10;
  if (direction === 'long' && obvSlope < 0) score -= 0.05;
  if (direction === 'short' && obvSlope > 0) score -= 0.05;

  const cvdDiv = detectCVDDivergence(candles1h);
  if (cvdDiv === 'bullish_divergence' && direction === 'long') score += 0.12;
  if (cvdDiv === 'bearish_divergence' && direction === 'short') score += 0.12;
  if (cvdDiv === 'bullish_divergence' && direction === 'short') score -= 0.08;
  if (cvdDiv === 'bearish_divergence' && direction === 'long') score -= 0.08;

  const vsa = detectVSA(candles1h);
  const recent = vsa.slice(-3);
  for (const s of recent) {
    if (s.type === 'absorption_bullish' && direction === 'long') score += 0.08;
    if (s.type === 'absorption_bearish' && direction === 'short') score += 0.08;
    if (s.type === 'buying_climax' && direction === 'long') score -= 0.06;
    if (s.type === 'selling_climax' && direction === 'short') score -= 0.06;
  }

  const vp = calculateVolumeProfile(candles1h.slice(-100));
  const lastPrice = candles1h[candles1h.length - 1].close;
  if (direction === 'long' && lastPrice <= vp.val) score += 0.06;
  if (direction === 'short' && lastPrice >= vp.vah) score += 0.06;

  return { score: Math.max(0, Math.min(1, Math.round(score * 100) / 100)), cvdDivergence: cvdDiv, vsaSignals: recent, volumeProfile: vp };
}

module.exports = { calculateVolumeProfile, detectVSA, detectCVDDivergence, calculateVolumeScore };
