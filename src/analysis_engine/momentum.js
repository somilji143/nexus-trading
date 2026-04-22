/**
 * NEXUS — Momentum Engine
 * RSI divergence (regular + hidden), MACD crossover + histogram, Stochastic.
 * Context-aware: strong only when aligned with structure and regime.
 */
const { calcRSI, calcMACD, calcStochastic } = require('./indicators');

function detectRSIDivergence(candles, period = 14, lookback = 50) {
  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes, period);
  const divergences = [];
  if (candles.length < lookback) return divergences;

  const start = candles.length - lookback;
  // Find swing lows and highs in price and RSI
  const priceLows = [], priceHighs = [], rsiLows = [], rsiHighs = [];
  for (let i = start + 2; i < candles.length - 2; i++) {
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i - 2].low && candles[i].low < candles[i + 1].low && candles[i].low < candles[i + 2].low) {
      priceLows.push({ index: i, price: candles[i].low, rsi: rsi[i] });
    }
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i - 2].high && candles[i].high > candles[i + 1].high && candles[i].high > candles[i + 2].high) {
      priceHighs.push({ index: i, price: candles[i].high, rsi: rsi[i] });
    }
  }

  // Regular Bullish: lower low in price, higher low in RSI
  for (let i = 1; i < priceLows.length; i++) {
    if (priceLows[i].price < priceLows[i - 1].price && priceLows[i].rsi > priceLows[i - 1].rsi) {
      divergences.push({ type: 'regular_bullish', index: priceLows[i].index, strength: Math.abs(priceLows[i].rsi - priceLows[i - 1].rsi) });
    }
  }
  // Regular Bearish: higher high in price, lower high in RSI
  for (let i = 1; i < priceHighs.length; i++) {
    if (priceHighs[i].price > priceHighs[i - 1].price && priceHighs[i].rsi < priceHighs[i - 1].rsi) {
      divergences.push({ type: 'regular_bearish', index: priceHighs[i].index, strength: Math.abs(priceHighs[i].rsi - priceHighs[i - 1].rsi) });
    }
  }
  // Hidden Bullish: higher low in price, lower low in RSI
  for (let i = 1; i < priceLows.length; i++) {
    if (priceLows[i].price > priceLows[i - 1].price && priceLows[i].rsi < priceLows[i - 1].rsi) {
      divergences.push({ type: 'hidden_bullish', index: priceLows[i].index, strength: Math.abs(priceLows[i].rsi - priceLows[i - 1].rsi) * 0.8 });
    }
  }
  // Hidden Bearish: lower high in price, higher high in RSI
  for (let i = 1; i < priceHighs.length; i++) {
    if (priceHighs[i].price < priceHighs[i - 1].price && priceHighs[i].rsi > priceHighs[i - 1].rsi) {
      divergences.push({ type: 'hidden_bearish', index: priceHighs[i].index, strength: Math.abs(priceHighs[i].rsi - priceHighs[i - 1].rsi) * 0.8 });
    }
  }
  return divergences;
}

function detectMACDSignal(candles) {
  const closes = candles.map(c => c.close);
  const { macdLine, signalLine, histogram } = calcMACD(closes);
  const i = macdLine.length - 1;
  if (i < 2) return { signal: 'neutral', crossover: false, histogramState: 'flat' };

  const crossUp = macdLine[i] > signalLine[i] && macdLine[i - 1] <= signalLine[i - 1];
  const crossDown = macdLine[i] < signalLine[i] && macdLine[i - 1] >= signalLine[i - 1];
  const histRising = histogram[i] > histogram[i - 1] && histogram[i - 1] > histogram[i - 2];
  const histFalling = histogram[i] < histogram[i - 1] && histogram[i - 1] < histogram[i - 2];
  const belowZero = macdLine[i] < 0;
  const aboveZero = macdLine[i] > 0;

  let signal = 'neutral';
  if (crossUp && histRising) signal = 'bullish';
  else if (crossDown && histFalling) signal = 'bearish';
  else if (histRising && belowZero) signal = 'bullish_momentum';
  else if (histFalling && aboveZero) signal = 'bearish_momentum';

  return { signal, crossover: crossUp || crossDown, crossDirection: crossUp ? 'up' : crossDown ? 'down' : null, histogramState: histRising ? 'rising' : histFalling ? 'falling' : 'flat', belowZero };
}

function calculateMomentumScore(candles, direction) {
  let score = 0.5;
  let agreeing = 0;
  const closes = candles.map(c => c.close);

  // RSI divergence
  const divs = detectRSIDivergence(candles);
  const recentDivs = divs.filter(d => d.index > candles.length - 20);
  for (const d of recentDivs) {
    if ((d.type === 'regular_bullish' || d.type === 'hidden_bullish') && direction === 'long') { score += 0.12; agreeing++; }
    if ((d.type === 'regular_bearish' || d.type === 'hidden_bearish') && direction === 'short') { score += 0.12; agreeing++; }
    if ((d.type === 'regular_bullish' || d.type === 'hidden_bullish') && direction === 'short') score -= 0.08;
    if ((d.type === 'regular_bearish' || d.type === 'hidden_bearish') && direction === 'long') score -= 0.08;
  }

  // MACD
  const macd = detectMACDSignal(candles);
  if ((macd.signal === 'bullish' || macd.signal === 'bullish_momentum') && direction === 'long') { score += 0.10; agreeing++; }
  if ((macd.signal === 'bearish' || macd.signal === 'bearish_momentum') && direction === 'short') { score += 0.10; agreeing++; }
  if (macd.crossover) score += direction === 'long' && macd.crossDirection === 'up' ? 0.05 : direction === 'short' && macd.crossDirection === 'down' ? 0.05 : -0.03;

  // Stochastic
  const stoch = calcStochastic(candles);
  const lastK = stoch.k[stoch.k.length - 1];
  const lastD = stoch.d[stoch.d.length - 1];
  if (direction === 'long' && lastK > lastD && lastK < 80) { score += 0.08; agreeing++; }
  if (direction === 'short' && lastK < lastD && lastK > 20) { score += 0.08; agreeing++; }

  // Require at least 2 of 3 to agree
  if (agreeing < 2) score = 0.5 + (score - 0.5) * 0.4; // Dampen if weak agreement

  return {
    score: Math.max(0, Math.min(1, Math.round(score * 100) / 100)),
    divergences: recentDivs, macd, stochastic: { k: Math.round(lastK), d: Math.round(lastD) }, agreeing,
  };
}

module.exports = { detectRSIDivergence, detectMACDSignal, calculateMomentumScore };
