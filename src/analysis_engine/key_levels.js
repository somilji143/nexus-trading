/**
 * NEXUS — Key Level Engine
 * PDH/PDL, PWH/PWL, monthly open, round numbers, Fibonacci, S/R clusters.
 */
const config = require('../core/config');

function getPreviousSessionLevels(candles1d, candles1w) {
  const levels = {};
  if (candles1d && candles1d.length >= 2) {
    const prev = candles1d[candles1d.length - 2];
    levels.PDH = prev.high;
    levels.PDL = prev.low;
  }
  if (candles1w && candles1w.length >= 2) {
    const prev = candles1w[candles1w.length - 2];
    levels.PWH = prev.high;
    levels.PWL = prev.low;
  }
  if (candles1d && candles1d.length >= 22) {
    levels.monthlyOpen = candles1d[candles1d.length - 22].open;
  }
  if (candles1d && candles1d.length >= 66) {
    levels.quarterlyOpen = candles1d[candles1d.length - 66].open;
  }
  return levels;
}

function calculateFibLevels(candles, lookback = 100) {
  const slice = candles.slice(-Math.min(lookback, candles.length));
  let swingHigh = -Infinity, swingLow = Infinity;
  for (const c of slice) {
    if (c.high > swingHigh) swingHigh = c.high;
    if (c.low < swingLow) swingLow = c.low;
  }
  const range = swingHigh - swingLow;
  if (range <= 0) return { retracements: {}, extensions: {}, swingHigh, swingLow };

  const last = candles[candles.length - 1].close;
  const upswing = last > (swingHigh + swingLow) / 2;

  const r = (pct) => upswing ? swingHigh - range * pct : swingLow + range * pct;
  const retracements = {
    '23.6%': Math.round(r(0.236) * 100) / 100,
    '38.2%': Math.round(r(0.382) * 100) / 100,
    '50.0%': Math.round(r(0.500) * 100) / 100,
    '61.8%': Math.round(r(0.618) * 100) / 100,
    '78.6%': Math.round(r(0.786) * 100) / 100,
  };

  const e = (pct) => upswing ? swingHigh + range * (pct - 1) : swingLow - range * (pct - 1);
  const extensions = {
    '127.2%': Math.round(e(1.272) * 100) / 100,
    '161.8%': Math.round(e(1.618) * 100) / 100,
    '261.8%': Math.round(e(2.618) * 100) / 100,
  };

  return { retracements, extensions, swingHigh: Math.round(swingHigh * 100) / 100, swingLow: Math.round(swingLow * 100) / 100 };
}

function getRoundNumberLevels(currentPrice, symbol) {
  const step = config.assets[symbol]?.roundStep || 100;
  const levels = [];
  const base = Math.floor(currentPrice / step) * step;
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    levels.push(base + i * step);
  }
  return levels;
}

function calculateKeyLevelScore(currentPrice, symbol, candles1d, candles1w, direction) {
  let score = 0.5;
  const levels = getPreviousSessionLevels(candles1d, candles1w);
  const fib = calculateFibLevels(candles1d || []);
  const rounds = getRoundNumberLevels(currentPrice, symbol);

  const proximity = (level) => Math.abs(currentPrice - level) / currentPrice;
  const nearThreshold = 0.005; // 0.5%

  // PDH/PDL
  if (levels.PDL && proximity(levels.PDL) < nearThreshold && direction === 'long') score += 0.12;
  if (levels.PDH && proximity(levels.PDH) < nearThreshold && direction === 'short') score += 0.12;

  // PWH/PWL
  if (levels.PWL && proximity(levels.PWL) < nearThreshold && direction === 'long') score += 0.10;
  if (levels.PWH && proximity(levels.PWH) < nearThreshold && direction === 'short') score += 0.10;

  // Fibonacci 61.8% and 78.6% (strong reversal zones)
  if (fib.retracements) {
    if (fib.retracements['61.8%'] && proximity(fib.retracements['61.8%']) < nearThreshold) score += direction === 'long' ? 0.08 : 0.08;
    if (fib.retracements['78.6%'] && proximity(fib.retracements['78.6%']) < nearThreshold) score += direction === 'long' ? 0.06 : 0.06;
  }

  // Round numbers
  for (const rn of rounds) {
    if (proximity(rn) < nearThreshold * 0.5) { score += 0.04; break; }
  }

  // Monthly open
  if (levels.monthlyOpen && proximity(levels.monthlyOpen) < nearThreshold) score += 0.05;

  const nearbyLevels = { ...levels, fibonacci: fib.retracements, roundNumbers: rounds.slice(0, 4) };

  return {
    score: Math.max(0, Math.min(1, Math.round(score * 100) / 100)),
    nearbyLevels,
    fibonacci: fib,
  };
}

module.exports = { getPreviousSessionLevels, calculateFibLevels, getRoundNumberLevels, calculateKeyLevelScore };
