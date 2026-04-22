/**
 * NEXUS — Market Regime Detection Engine
 * Detects: TRENDING, RANGING, VOLATILE, LOW_VOL
 * Uses ADX, ATR, Bollinger Width, EMA separation, swing behavior.
 */
const { calcEMA, calcATR, calcADX, calcBBWidth, calcRollingStdDev } = require('./indicators');

function detectRegime(candles, lookback = 50) {
  if (candles.length < lookback + 20) return { regime: 'RANGING', confidence: 0.5, recommendedMode: 'mean_reversion' };

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
  const emaSep = Math.abs(ema20[ema20.length - 1] - ema50[ema50.length - 1]);
  const emaSepPct = emaSep / closes[closes.length - 1];

  const rollingVol = calcRollingStdDev(closes, 20);
  const currentVol = rollingVol[rollingVol.length - 1] || 0;
  const avgVol = rollingVol.slice(-lookback).reduce((s, v) => s + v, 0) / Math.max(1, rollingVol.slice(-lookback).length);
  const volRatio = avgVol > 0 ? currentVol / avgVol : 1;

  // Score each regime
  let trendScore = 0, rangeScore = 0, volatileScore = 0, lowVolScore = 0;

  // TRENDING indicators
  if (currentADX > 25) trendScore += 0.35;
  else if (currentADX > 20) trendScore += 0.15;
  if (emaSepPct > 0.01) trendScore += 0.25;
  else if (emaSepPct > 0.005) trendScore += 0.10;
  if (atrExpansion > 1.1 && atrExpansion < 1.8) trendScore += 0.20;
  // Higher highs / higher lows or lower highs / lower lows
  const hh = slice.slice(-10).filter((c, i) => i > 0 && c.high > slice.slice(-10)[i - 1].high).length;
  const ll = slice.slice(-10).filter((c, i) => i > 0 && c.low < slice.slice(-10)[i - 1].low).length;
  if (hh >= 6 || ll >= 6) trendScore += 0.20;

  // RANGING indicators
  if (currentADX < 20) rangeScore += 0.30;
  if (emaSepPct < 0.005) rangeScore += 0.25;
  if (bbExpansion < 0.9) rangeScore += 0.20;
  if (atrExpansion < 1.1 && atrExpansion > 0.7) rangeScore += 0.15;
  if (hh < 5 && ll < 5) rangeScore += 0.10;

  // VOLATILE indicators
  if (atrExpansion > 1.8) volatileScore += 0.35;
  if (bbExpansion > 1.5) volatileScore += 0.25;
  if (volRatio > 1.5) volatileScore += 0.25;
  if (currentADX > 30 && atrExpansion > 1.5) volatileScore += 0.15;

  // LOW_VOL indicators
  if (atrExpansion < 0.6) lowVolScore += 0.35;
  if (bbExpansion < 0.6) lowVolScore += 0.25;
  if (volRatio < 0.5) lowVolScore += 0.25;
  if (currentADX < 15) lowVolScore += 0.15;

  const scores = { TRENDING: trendScore, RANGING: rangeScore, VOLATILE: volatileScore, LOW_VOL: lowVolScore };
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const regime = sorted[0][0];
  const confidence = Math.min(1, sorted[0][1]);

  const modeMap = { TRENDING: 'trend_following', RANGING: 'mean_reversion', VOLATILE: 'reduced_exposure', LOW_VOL: 'no_trade' };

  return {
    regime,
    confidence: Math.round(confidence * 100) / 100,
    recommendedMode: modeMap[regime],
    scores,
    metrics: {
      adx: Math.round(currentADX * 100) / 100,
      atrExpansion: Math.round(atrExpansion * 100) / 100,
      bbExpansion: Math.round(bbExpansion * 100) / 100,
      emaSepPct: Math.round(emaSepPct * 10000) / 100,
      volRatio: Math.round(volRatio * 100) / 100,
    },
  };
}

module.exports = { detectRegime };
