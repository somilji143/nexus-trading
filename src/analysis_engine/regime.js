/**
 * NEXUS v3 — Market Regime Detection (10 Regimes)
 * 1. Strong Uptrend  2. Weak Uptrend  3. Strong Downtrend  4. Weak Downtrend
 * 5. Range-bound  6. Choppy  7. High Volatility  8. Low Liquidity
 * 9. Breakout  10. Mean-reversion
 */
const { calcEMA, calcATR, calcADX, calcBBWidth, calcRollingStdDev } = require('./indicators');

function detectRegime(candles, lookback = 50) {
  if (candles.length < lookback + 20) return { regime: 'RANGING', subType: 'RANGE_BOUND', confidence: 0.5, recommendedMode: 'mean_reversion', metrics: {} };

  const closes = candles.map(c => c.close);
  const slice = candles.slice(-lookback);
  const atr14 = calcATR(candles, 14);
  const currentATR = atr14[atr14.length - 1];
  const avgATR = atr14.slice(-lookback).reduce((s, v) => s + v, 0) / lookback;
  const atrExpansion = avgATR > 0 ? currentATR / avgATR : 1;

  const adx = calcADX(candles, 14);
  const currentADX = adx[adx.length - 1] || 20;

  const bbWidth = calcBBWidth(closes, 20, 2);
  const currentBBW = bbWidth[bbWidth.length - 1] || 0;
  const avgBBW = bbWidth.slice(-lookback).reduce((s, v) => s + v, 0) / Math.max(1, bbWidth.slice(-lookback).length);
  const bbExpansion = avgBBW > 0 ? currentBBW / avgBBW : 1;

  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : null;
  const e20 = ema20[ema20.length - 1];
  const e50 = ema50[ema50.length - 1];
  const e200 = ema200 ? ema200[ema200.length - 1] : e50;
  const price = closes[closes.length - 1];
  const emaSep = Math.abs(e20 - e50) / price;

  const rollingVol = calcRollingStdDev(closes, 20);
  const currentVol = rollingVol[rollingVol.length - 1] || 0;
  const avgVol = rollingVol.slice(-lookback).reduce((s, v) => s + v, 0) / Math.max(1, rollingVol.slice(-lookback).length);
  const volRatio = avgVol > 0 ? currentVol / avgVol : 1;

  // EMA slope (last 5 bars)
  const emaSlope20 = e20 - ema20[ema20.length - 6];
  const emaSlopeDir = emaSlope20 > 0 ? 'up' : 'down';

  // Swing structure
  const last10 = slice.slice(-10);
  const hh = last10.filter((c, i) => i > 0 && c.high > last10[i - 1].high).length;
  const ll = last10.filter((c, i) => i > 0 && c.low < last10[i - 1].low).length;

  // Body-to-wick ratio (choppiness indicator)
  const bodyWickRatios = slice.slice(-20).map(c => {
    const body = Math.abs(c.close - c.open);
    const totalRange = c.high - c.low;
    return totalRange > 0 ? body / totalRange : 0.5;
  });
  const avgBodyRatio = bodyWickRatios.reduce((s, v) => s + v, 0) / bodyWickRatios.length;

  // Compression detection
  const recentBBW = bbWidth.slice(-10);
  const prevBBW = bbWidth.slice(-30, -10);
  const isCompressing = recentBBW.length > 0 && prevBBW.length > 0 &&
    (recentBBW.reduce((s, v) => s + v, 0) / recentBBW.length) < (prevBBW.reduce((s, v) => s + v, 0) / prevBBW.length) * 0.7;

  // Volume trend
  const volumes = candles.slice(-20).map(c => c.volume);
  const avgVolume = volumes.reduce((s, v) => s + v, 0) / volumes.length;
  const recentVolAvg = volumes.slice(-5).reduce((s, v) => s + v, 0) / 5;
  const volExpanding = avgVolume > 0 ? recentVolAvg / avgVolume > 1.3 : false;

  // ─── Score each of 10 regimes ──────────────────
  const scores = {};

  // 1. Strong Uptrend: ADX>25, EMA aligned bullish, HH/HL, price>EMA200
  scores.STRONG_UPTREND = 0;
  if (currentADX > 25) scores.STRONG_UPTREND += 0.25;
  if (e20 > e50 && e50 > e200) scores.STRONG_UPTREND += 0.25;
  if (price > e200) scores.STRONG_UPTREND += 0.15;
  if (hh >= 6) scores.STRONG_UPTREND += 0.20;
  if (emaSlopeDir === 'up' && emaSep > 0.01) scores.STRONG_UPTREND += 0.15;

  // 2. Weak Uptrend: bullish but weak momentum
  scores.WEAK_UPTREND = 0;
  if (currentADX > 15 && currentADX <= 25) scores.WEAK_UPTREND += 0.25;
  if (e20 > e50) scores.WEAK_UPTREND += 0.20;
  if (price > e50) scores.WEAK_UPTREND += 0.15;
  if (emaSep > 0.003 && emaSep <= 0.01) scores.WEAK_UPTREND += 0.20;
  if (hh >= 4 && hh < 6) scores.WEAK_UPTREND += 0.20;

  // 3. Strong Downtrend
  scores.STRONG_DOWNTREND = 0;
  if (currentADX > 25) scores.STRONG_DOWNTREND += 0.25;
  if (e20 < e50 && e50 < e200) scores.STRONG_DOWNTREND += 0.25;
  if (price < e200) scores.STRONG_DOWNTREND += 0.15;
  if (ll >= 6) scores.STRONG_DOWNTREND += 0.20;
  if (emaSlopeDir === 'down' && emaSep > 0.01) scores.STRONG_DOWNTREND += 0.15;

  // 4. Weak Downtrend
  scores.WEAK_DOWNTREND = 0;
  if (currentADX > 15 && currentADX <= 25) scores.WEAK_DOWNTREND += 0.25;
  if (e20 < e50) scores.WEAK_DOWNTREND += 0.20;
  if (price < e50) scores.WEAK_DOWNTREND += 0.15;
  if (emaSep > 0.003 && emaSep <= 0.01) scores.WEAK_DOWNTREND += 0.20;
  if (ll >= 4 && ll < 6) scores.WEAK_DOWNTREND += 0.20;

  // 5. Range-bound
  scores.RANGE_BOUND = 0;
  if (currentADX < 20) scores.RANGE_BOUND += 0.30;
  if (emaSep < 0.005) scores.RANGE_BOUND += 0.25;
  if (avgBodyRatio > 0.35) scores.RANGE_BOUND += 0.15;
  if (atrExpansion < 1.1 && atrExpansion > 0.7) scores.RANGE_BOUND += 0.15;
  if (hh < 5 && ll < 5) scores.RANGE_BOUND += 0.15;

  // 6. Choppy/noisy
  scores.CHOPPY = 0;
  if (currentADX < 18) scores.CHOPPY += 0.20;
  if (avgBodyRatio < 0.35) scores.CHOPPY += 0.25; // lots of wicks
  if (hh < 4 && ll < 4 && Math.abs(hh - ll) < 2) scores.CHOPPY += 0.20;
  if (volRatio < 0.8) scores.CHOPPY += 0.15;
  if (bbExpansion < 0.8 && atrExpansion > 0.9) scores.CHOPPY += 0.20;

  // 7. High Volatility
  scores.HIGH_VOLATILITY = 0;
  if (atrExpansion > 1.8) scores.HIGH_VOLATILITY += 0.35;
  if (bbExpansion > 1.5) scores.HIGH_VOLATILITY += 0.25;
  if (volRatio > 1.5) scores.HIGH_VOLATILITY += 0.25;
  if (currentADX > 30 && atrExpansion > 1.5) scores.HIGH_VOLATILITY += 0.15;

  // 8. Low Liquidity
  scores.LOW_LIQUIDITY = 0;
  if (atrExpansion < 0.6) scores.LOW_LIQUIDITY += 0.30;
  if (bbExpansion < 0.6) scores.LOW_LIQUIDITY += 0.25;
  if (volRatio < 0.5) scores.LOW_LIQUIDITY += 0.25;
  if (currentADX < 15) scores.LOW_LIQUIDITY += 0.20;

  // 9. Breakout
  scores.BREAKOUT = 0;
  if (isCompressing) scores.BREAKOUT += 0.30;
  if (volExpanding) scores.BREAKOUT += 0.25;
  if (atrExpansion > 1.3 && bbExpansion > 1.2) scores.BREAKOUT += 0.25;
  if (currentADX > 20 && currentADX < 35) scores.BREAKOUT += 0.20;

  // 10. Mean-reversion
  scores.MEAN_REVERSION = 0;
  if (currentADX < 22) scores.MEAN_REVERSION += 0.25;
  if (emaSep < 0.008) scores.MEAN_REVERSION += 0.20;
  if (bbExpansion < 1.0) scores.MEAN_REVERSION += 0.20;
  if (avgBodyRatio > 0.4) scores.MEAN_REVERSION += 0.15;
  if (atrExpansion < 1.2 && atrExpansion > 0.5) scores.MEAN_REVERSION += 0.20;

  // ─── Find best regime ─────────────────────────
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const bestRegime = sorted[0][0];
  const confidence = Math.min(1, sorted[0][1]);

  // Map to simplified regime for backward compat
  const simplifiedMap = {
    STRONG_UPTREND: 'TRENDING', WEAK_UPTREND: 'TRENDING',
    STRONG_DOWNTREND: 'TRENDING', WEAK_DOWNTREND: 'TRENDING',
    RANGE_BOUND: 'RANGING', CHOPPY: 'LOW_VOL',
    HIGH_VOLATILITY: 'VOLATILE', LOW_LIQUIDITY: 'LOW_VOL',
    BREAKOUT: 'TRENDING', MEAN_REVERSION: 'RANGING',
  };

  const modeMap = {
    STRONG_UPTREND: 'trend_following', WEAK_UPTREND: 'trend_following',
    STRONG_DOWNTREND: 'trend_following', WEAK_DOWNTREND: 'trend_following',
    RANGE_BOUND: 'mean_reversion', CHOPPY: 'no_trade',
    HIGH_VOLATILITY: 'reduced_exposure', LOW_LIQUIDITY: 'no_trade',
    BREAKOUT: 'breakout', MEAN_REVERSION: 'mean_reversion',
  };

  const trendDir = ['STRONG_UPTREND', 'WEAK_UPTREND'].includes(bestRegime) ? 'bullish'
    : ['STRONG_DOWNTREND', 'WEAK_DOWNTREND'].includes(bestRegime) ? 'bearish' : 'neutral';

  return {
    regime: simplifiedMap[bestRegime] || 'RANGING',
    subType: bestRegime,
    trendDirection: trendDir,
    confidence: Math.round(confidence * 100) / 100,
    recommendedMode: modeMap[bestRegime] || 'no_trade',
    scores,
    metrics: {
      adx: Math.round(currentADX * 100) / 100,
      atrExpansion: Math.round(atrExpansion * 100) / 100,
      bbExpansion: Math.round(bbExpansion * 100) / 100,
      emaSepPct: Math.round(emaSep * 10000) / 100,
      volRatio: Math.round(volRatio * 100) / 100,
      bodyWickRatio: Math.round(avgBodyRatio * 100) / 100,
      compression: isCompressing,
      volumeExpanding: volExpanding,
    },
  };
}

module.exports = { detectRegime };
