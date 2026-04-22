/**
 * NEXUS — Technical Indicators Library
 * Pure functions. No side effects. Used across all analysis engines.
 */

function calcEMA(data, period) {
  if (data.length < period) return data.map(() => data[0] || 0);
  const k = 2 / (period + 1);
  const result = [data.slice(0, period).reduce((s, v) => s + v, 0) / period];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function calcSMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(data[i]); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function calcATR(candles, period = 14) {
  const trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  return calcEMA(trs, period);
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signal);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

function calcStochastic(candles, kPeriod = 14, dPeriod = 3) {
  const k = [], d = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < kPeriod - 1) { k.push(50); continue; }
    let highest = -Infinity, lowest = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > highest) highest = candles[j].high;
      if (candles[j].low < lowest) lowest = candles[j].low;
    }
    const range = highest - lowest;
    k.push(range > 0 ? ((candles[i].close - lowest) / range) * 100 : 50);
  }
  const dLine = calcSMA(k, dPeriod);
  return { k, d: dLine };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return candles.map(() => 20);
  const pdm = [], ndm = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    pdm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    ndm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  const smoothTR = calcEMA(tr, period);
  const smoothPDM = calcEMA(pdm, period);
  const smoothNDM = calcEMA(ndm, period);
  const pdi = smoothPDM.map((v, i) => smoothTR[i] > 0 ? (v / smoothTR[i]) * 100 : 0);
  const ndi = smoothNDM.map((v, i) => smoothTR[i] > 0 ? (v / smoothTR[i]) * 100 : 0);
  const dx = pdi.map((v, i) => {
    const sum = v + ndi[i];
    return sum > 0 ? (Math.abs(v - ndi[i]) / sum) * 100 : 0;
  });
  const adx = calcEMA(dx, period);
  // Pad to match original length
  return [20, ...adx]; // offset by 1 from TR calc
}

function calcBBWidth(closes, period = 20, mult = 2) {
  const sma = calcSMA(closes, period);
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(0); continue; }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - sma[i]) ** 2;
    const std = Math.sqrt(sumSq / period);
    const upper = sma[i] + mult * std;
    const lower = sma[i] - mult * std;
    result.push(sma[i] > 0 ? (upper - lower) / sma[i] : 0);
  }
  return result;
}

function calcRollingStdDev(data, period = 20) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(0); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    const mean = sum / period;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (data[j] - mean) ** 2;
    result.push(Math.sqrt(sumSq / period));
  }
  return result;
}

function calcOBV(candles) {
  const obv = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv.push(obv[i - 1] + candles[i].volume);
    else if (candles[i].close < candles[i - 1].close) obv.push(obv[i - 1] - candles[i].volume);
    else obv.push(obv[i - 1]);
  }
  return obv;
}

function calcCVD(candles) {
  const cvd = [];
  let cumulative = 0;
  for (const c of candles) {
    const range = c.high - c.low;
    if (range <= 0) { cvd.push(cumulative); continue; }
    const buyVol = c.close > c.open
      ? c.volume * (c.close - c.low) / range
      : c.volume * (1 - (c.open - c.close) / range) * 0.4;
    const sellVol = c.volume - buyVol;
    cumulative += buyVol - sellVol;
    cvd.push(cumulative);
  }
  return cvd;
}

module.exports = {
  calcEMA, calcSMA, calcATR, calcRSI, calcMACD, calcStochastic,
  calcADX, calcBBWidth, calcRollingStdDev, calcOBV, calcCVD,
};
