/**
 * NEXUS — Multi-Timeframe Trend Engine
 * Evaluates 1W, 1D, 4H, 1H trend alignment.
 */
const { calcEMA, calcATR } = require('./indicators');

function getTimeframeBias(candles, timeframe) {
  if (!candles || candles.length < 50) return { timeframe, bias: 'neutral', slope: 'flat', strength: 0 };
  const closes = candles.map(c => c.close);
  const emaMap = { '1w': 200, '1d': 50, '4h': 21, '1h': 21 };
  const period = emaMap[timeframe] || 21;
  const ema = calcEMA(closes, Math.min(period, candles.length - 1));
  const atr = calcATR(candles, 14);
  const last = closes[closes.length - 1];
  const lastEma = ema[ema.length - 1];
  const lastATR = atr[atr.length - 1] || 1;

  // EMA slope (last 5 values)
  const slopeWindow = ema.slice(-5);
  const slopeChange = slopeWindow.length >= 2 ? slopeWindow[slopeWindow.length - 1] - slopeWindow[0] : 0;
  const slopeNorm = slopeChange / lastATR;
  let slope = 'flat';
  if (slopeNorm > 0.3) slope = 'rising';
  else if (slopeNorm < -0.3) slope = 'falling';

  // Bias
  const distFromEma = (last - lastEma) / lastATR;
  let bias = 'neutral';
  if (last > lastEma && slope !== 'falling') bias = 'bullish';
  else if (last < lastEma && slope !== 'rising') bias = 'bearish';

  // Strength (0-1)
  let strength = Math.min(1, Math.abs(distFromEma) / 3);
  if (bias === 'neutral') strength *= 0.3;

  // Recent candle structure (last 10)
  const recent = candles.slice(-10);
  let hhhl = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].high > recent[i - 1].high && recent[i].low > recent[i - 1].low) hhhl++;
    if (recent[i].high < recent[i - 1].high && recent[i].low < recent[i - 1].low) hhhl--;
  }
  if (hhhl > 3 && bias === 'bullish') strength = Math.min(1, strength + 0.15);
  if (hhhl < -3 && bias === 'bearish') strength = Math.min(1, strength + 0.15);

  return { timeframe, bias, slope, strength: Math.round(strength * 100) / 100, emaValue: Math.round(lastEma * 100) / 100, distATR: Math.round(distFromEma * 100) / 100 };
}

function calculateMTFScore(allTimeframes) {
  const weights = { '1w': 0.35, '1d': 0.30, '4h': 0.20, '1h': 0.15 };
  const biases = {};
  let weightedScore = 0;
  let totalWeight = 0;
  const breakdown = [];

  for (const [tf, candles] of Object.entries(allTimeframes)) {
    if (!weights[tf]) continue;
    const bias = getTimeframeBias(candles, tf);
    biases[tf] = bias;
    breakdown.push(bias);
    const biasScore = bias.bias === 'bullish' ? 1 : bias.bias === 'bearish' ? 0 : 0.5;
    const effectiveScore = biasScore * bias.strength + 0.5 * (1 - bias.strength);
    weightedScore += effectiveScore * weights[tf];
    totalWeight += weights[tf];
  }

  const score = totalWeight > 0 ? weightedScore / totalWeight : 0.5;
  const agreeing = breakdown.filter(b => b.bias === 'bullish').length;
  const disagreeing = breakdown.filter(b => b.bias === 'bearish').length;

  return {
    score: Math.round(score * 100) / 100,
    breakdown,
    alignment: agreeing >= 3 ? 'bullish' : disagreeing >= 3 ? 'bearish' : 'mixed',
    agreementCount: Math.max(agreeing, disagreeing),
  };
}

module.exports = { getTimeframeBias, calculateMTFScore };
