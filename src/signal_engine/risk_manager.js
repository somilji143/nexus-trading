/**
 * NEXUS — Risk Manager
 * ATR-based, structure-aware SL/TP. Position sizing. Validation.
 */
const config = require('../core/config');
const { calcATR } = require('../analysis_engine/indicators');
const { detectSwingPoints } = require('../analysis_engine/smc');

function calculateEntryRisk(direction, currentPrice, candles1h, confluenceData, symbol) {
  const atr = calcATR(candles1h, 14);
  const currentATR = atr[atr.length - 1] || 1;
  const assetCfg = config.assets[symbol] || {};
  const spread = assetCfg.spread || 0.5;
  const isBuy = direction === 'LONG';

  // ─── Stop Loss ─────────────────────────────────
  // Method 1: Nearest OB edge + buffer
  let slFromOB = null;
  const ob = confluenceData?.details?.smcDetails?.activeOB;
  if (ob) {
    slFromOB = isBuy ? ob.low - currentATR * 0.5 : ob.high + currentATR * 0.5;
  }

  // Method 2: Recent swing extreme + buffer
  const swings = detectSwingPoints(candles1h, 5);
  let slFromSwing = null;
  if (isBuy && swings.lows.length > 0) {
    const recentLow = swings.lows[swings.lows.length - 1].price;
    slFromSwing = recentLow - currentATR * 0.3;
  }
  if (!isBuy && swings.highs.length > 0) {
    const recentHigh = swings.highs[swings.highs.length - 1].price;
    slFromSwing = recentHigh + currentATR * 0.3;
  }

  // Method 3: ATR-based fallback
  const slFromATR = isBuy ? currentPrice - currentATR * 1.5 : currentPrice + currentATR * 1.5;

  // Use tightest valid SL
  let sl;
  const candidates = [slFromOB, slFromSwing, slFromATR].filter(v => v !== null);
  if (isBuy) {
    const validSLs = candidates.filter(v => v < currentPrice);
    sl = validSLs.length > 0 ? Math.max(...validSLs) : slFromATR; // Tightest = highest for longs
  } else {
    const validSLs = candidates.filter(v => v > currentPrice);
    sl = validSLs.length > 0 ? Math.min(...validSLs) : slFromATR;
  }

  const slDistance = Math.abs(currentPrice - sl);
  const slATRRatio = slDistance / currentATR;

  // Validation
  let isValid = true;
  const reasons = [];
  if (slATRRatio > config.defaultThresholds.maxSLATR) { isValid = false; reasons.push(`SL too wide: ${slATRRatio.toFixed(1)}x ATR > ${config.defaultThresholds.maxSLATR}x`); }
  if (slATRRatio < config.defaultThresholds.minSLATR) { isValid = false; reasons.push(`SL too tight: ${slATRRatio.toFixed(1)}x ATR < ${config.defaultThresholds.minSLATR}x`); }

  // ─── Take Profits ─────────────────────────────
  const entry = currentPrice + (isBuy ? spread / 2 : -spread / 2); // Account for spread
  const tp1 = isBuy ? entry + slDistance * config.risk.tp1R : entry - slDistance * config.risk.tp1R;
  const tp2 = isBuy ? entry + slDistance * config.risk.tp2R : entry - slDistance * config.risk.tp2R;
  const tp3 = isBuy ? entry + slDistance * config.risk.tp3R : entry - slDistance * config.risk.tp3R;

  // ─── Position Sizing ──────────────────────────
  const riskAmount = config.risk.accountSize * config.risk.riskPerTrade;
  const positionSize = slDistance > 0 ? riskAmount / slDistance : 0;

  // Regime reduction
  const regime = confluenceData?.regime?.name;
  const sizeMultiplier = regime === 'VOLATILE' ? 0.5 : regime === 'RANGING' ? 0.75 : 1.0;

  return {
    entry: r(entry),
    sl: r(sl),
    tp1: r(tp1), tp1R: config.risk.tp1R,
    tp2: r(tp2), tp2R: config.risk.tp2R,
    tp3: r(tp3), tp3R: config.risk.tp3R,
    slDistance: r(slDistance),
    atr: r(currentATR),
    atrRatio: Math.round(slATRRatio * 100) / 100,
    positionSize: Math.round(positionSize * sizeMultiplier * 10000) / 10000,
    riskAmount: r(riskAmount * sizeMultiplier),
    isValid,
    rejectionReasons: reasons,
    spread: r(spread),
  };
}

function updateTrailingStop(signal, currentPrice, candles1h) {
  const isBuy = signal.direction === 'LONG';
  const atr = calcATR(candles1h, 14);
  const currentATR = atr[atr.length - 1] || 1;

  if (signal.status === 'TP1_HIT') {
    // After TP1: trail to breakeven
    return signal.entry_price;
  }
  if (signal.status === 'TP2_HIT') {
    // After TP2: ATR trailing
    return isBuy ? currentPrice - currentATR * 2 : currentPrice + currentATR * 2;
  }
  return signal.sl_price; // No change
}

function r(v) { return Math.round(v * 100) / 100; }

module.exports = { calculateEntryRisk, updateTrailingStop };
