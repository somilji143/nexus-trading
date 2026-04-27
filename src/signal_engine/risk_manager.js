/**
 * NEXUS v3 — Risk Model
 * Institutional-grade risk management with:
 * - ATR+structure stop loss placement
 * - Spread/slippage/fee accounting
 * - Position sizing with daily/weekly loss limits
 * - Max drawdown pause, correlation guard
 * - Minimum R:R enforcement
 * - Explainable rejection reasons
 */
const config = require('../core/config');
const { calcATR } = require('../analysis_engine/indicators');
const { detectSwingPoints } = require('../analysis_engine/smc');
const logger = require('../core/logger');
const MOD = 'RiskModel';

// ─── Daily / Weekly Loss Tracking ───────────────
const riskState = {
  dailyLoss: 0,
  weeklyLoss: 0,
  lastDailyReset: new Date().toDateString(),
  lastWeeklyReset: getWeekId(),
  totalOpenExposure: 0,
  tradesToday: 0,
  consecutiveLosses: 0,
  drawdownPct: 0,
  peakEquity: 10000,
  paused: false,
  pauseReason: null,
};

function getWeekId() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  return `${d.getFullYear()}-W${Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7)}`;
}

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (riskState.lastDailyReset !== today) {
    riskState.dailyLoss = 0;
    riskState.tradesToday = 0;
    riskState.lastDailyReset = today;
  }
  const week = getWeekId();
  if (riskState.lastWeeklyReset !== week) {
    riskState.weeklyLoss = 0;
    riskState.lastWeeklyReset = week;
  }
  // Unpause if drawdown recovered
  if (riskState.paused && riskState.drawdownPct < config.risk.maxDrawdown * 0.5) {
    riskState.paused = false;
    riskState.pauseReason = null;
  }
}

function recordLoss(amount) {
  resetDailyIfNeeded();
  riskState.dailyLoss += amount;
  riskState.weeklyLoss += amount;
  riskState.consecutiveLosses++;
  // Update drawdown
  const currentEquity = riskState.peakEquity - riskState.dailyLoss;
  riskState.drawdownPct = riskState.peakEquity > 0 ? ((riskState.peakEquity - currentEquity) / riskState.peakEquity) * 100 : 0;
  if (riskState.consecutiveLosses >= 3) {
    logger.warn(MOD, `Loss streak: ${riskState.consecutiveLosses} — reducing risk`);
  }
}

function recordWin() {
  riskState.consecutiveLosses = 0;
  // Update peak equity
  const currentEquity = riskState.peakEquity - riskState.dailyLoss;
  if (currentEquity > riskState.peakEquity) riskState.peakEquity = currentEquity;
}

function recordTrade() {
  resetDailyIfNeeded();
  riskState.tradesToday++;
}

// ─── Main Entry Risk Calculation ────────────────
function calculateEntryRisk(direction, currentPrice, candles1h, confluenceData, symbol, openTrades = []) {
  resetDailyIfNeeded();

  const rejectionReasons = [];
  const warnings = [];
  const assetCfg = config.assets[symbol] || {};
  const spread = assetCfg.spread || 0.5;
  const isBuy = direction === 'LONG';

  // ─── Pre-flight checks ─────────────────────────
  // 1. Max drawdown pause
  if (riskState.paused) {
    return reject([`System paused: ${riskState.pauseReason}`]);
  }

  // 2. Daily loss limit (default 3% of account)
  const dailyLimit = config.risk.accountSize * (config.risk.dailyLossLimit || 0.03);
  if (riskState.dailyLoss >= dailyLimit) {
    return reject([`Daily loss limit reached: $${riskState.dailyLoss.toFixed(2)} >= $${dailyLimit.toFixed(2)}`]);
  }

  // 3. Weekly loss limit (default 6% of account)
  const weeklyLimit = config.risk.accountSize * (config.risk.weeklyLossLimit || 0.06);
  if (riskState.weeklyLoss >= weeklyLimit) {
    return reject([`Weekly loss limit reached: $${riskState.weeklyLoss.toFixed(2)} >= $${weeklyLimit.toFixed(2)}`]);
  }

  // 4. Max active trades
  if (openTrades.length >= (config.risk.maxActiveTrades || 3)) {
    return reject([`Max active trades: ${openTrades.length}`]);
  }

  // 5. Correlation guard: don't overexpose BTC+ETH same direction
  if (symbol !== 'XAUUSD') {
    const sameDir = openTrades.filter(t => t.asset_symbol !== 'XAUUSD' && t.direction === direction);
    if (sameDir.length >= (config.risk.maxCorrelatedExposure || 1)) {
      return reject([`Correlated exposure: ${sameDir.length} crypto trades in ${direction}`]);
    }
  }

  // 6. Max trades per day
  if (riskState.tradesToday >= 6) {
    return reject([`Max trades per day reached: ${riskState.tradesToday}`]);
  }

  // 7. Consecutive loss cooldown
  if (riskState.consecutiveLosses >= 3) {
    warnings.push(`Loss streak: ${riskState.consecutiveLosses} — risk halved`);
  }

  // ─── ATR Calculation ───────────────────────────
  const atr = calcATR(candles1h, 14);
  const currentATR = atr[atr.length - 1] || 1;

  if (currentATR <= 0) {
    return reject(['ATR is zero or negative']);
  }

  // ─── Spread-to-ATR check ───────────────────────
  const spreadToATR = spread / currentATR;
  if (spreadToATR > 0.15) {
    warnings.push(`High spread-to-ATR ratio: ${(spreadToATR * 100).toFixed(1)}%`);
    if (spreadToATR > 0.3) {
      return reject([`Spread too wide relative to ATR: ${(spreadToATR * 100).toFixed(1)}% (max 30%)`]);
    }
  }

  // ─── Stop Loss Placement ───────────────────────
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

  // Select tightest valid SL
  let sl;
  const candidates = [slFromOB, slFromSwing, slFromATR].filter(v => v !== null);
  if (isBuy) {
    const valid = candidates.filter(v => v < currentPrice);
    sl = valid.length > 0 ? Math.max(...valid) : slFromATR;
  } else {
    const valid = candidates.filter(v => v > currentPrice);
    sl = valid.length > 0 ? Math.min(...valid) : slFromATR;
  }

  // ─── Entry with spread ─────────────────────────
  const entry = currentPrice + (isBuy ? spread / 2 : -spread / 2);
  const slDistance = Math.abs(entry - sl);
  const slATRRatio = slDistance / currentATR;

  // ─── SL Distance Validation ────────────────────
  if (slATRRatio > (config.defaultThresholds.maxSLATR || 3.0)) {
    rejectionReasons.push(`SL too wide: ${slATRRatio.toFixed(1)}x ATR > ${config.defaultThresholds.maxSLATR}x`);
  }
  if (slATRRatio < (config.defaultThresholds.minSLATR || 0.5)) {
    rejectionReasons.push(`SL too tight: ${slATRRatio.toFixed(1)}x ATR < ${config.defaultThresholds.minSLATR}x`);
  }

  // ─── Direction Sanity Check ────────────────────
  if (isBuy && sl >= entry) {
    rejectionReasons.push(`LONG SL (${sl}) must be below entry (${entry})`);
  }
  if (!isBuy && sl <= entry) {
    rejectionReasons.push(`SHORT SL (${sl}) must be above entry (${entry})`);
  }

  // ─── Take Profits ─────────────────────────────
  const tp1R = config.risk.tp1R || 1.5;
  const tp2R = config.risk.tp2R || 2.5;
  const tp3R = config.risk.tp3R || 4.0;
  const tp1 = isBuy ? entry + slDistance * tp1R : entry - slDistance * tp1R;
  const tp2 = isBuy ? entry + slDistance * tp2R : entry - slDistance * tp2R;
  const tp3 = isBuy ? entry + slDistance * tp3R : entry - slDistance * tp3R;

  // ─── Minimum R:R Check ─────────────────────────
  const minRR = config.defaultThresholds.minRR || 1.5;
  // Effective R:R considering partial exits
  const effectiveRR = 0.5 * tp1R + 0.3 * tp2R + 0.2 * tp3R; // weighted TP system
  if (effectiveRR < minRR) {
    rejectionReasons.push(`Effective R:R ${effectiveRR.toFixed(2)} < minimum ${minRR}`);
  }

  // ─── Position Sizing ──────────────────────────
  let riskPct = config.risk.riskPerTrade || 0.01;

  // Loss streak risk reduction
  if (riskState.consecutiveLosses >= 3) {
    riskPct *= 0.5;
    warnings.push(`Risk halved due to ${riskState.consecutiveLosses} consecutive losses`);
  }

  // Drawdown risk reduction
  if (riskState.drawdownPct > 10) {
    riskPct *= 0.5;
    warnings.push(`Risk halved due to drawdown: ${riskState.drawdownPct.toFixed(1)}%`);
  }

  const riskAmount = config.risk.accountSize * riskPct;
  const positionSize = slDistance > 0 ? riskAmount / slDistance : 0;

  // Regime-based size reduction
  const regime = confluenceData?.regime?.name;
  let sizeMultiplier = 1.0;
  if (regime === 'VOLATILE') { sizeMultiplier = 0.5; warnings.push('Size halved: volatile regime'); }
  else if (regime === 'RANGING') { sizeMultiplier = 0.75; warnings.push('Size reduced 25%: ranging regime'); }

  // ─── Fee Estimation ───────────────────────────
  const commissionRate = config.backtest?.defaultCommission || 0.0002;
  const estimatedFees = entry * positionSize * sizeMultiplier * commissionRate * 2; // round trip

  const isValid = rejectionReasons.length === 0;

  if (!isValid) {
    logger.warn(MOD, `Signal rejected: ${symbol} ${direction}`, { reasons: rejectionReasons });
  }

  return {
    entry: r(entry),
    sl: r(sl),
    tp1: r(tp1), tp1R,
    tp2: r(tp2), tp2R,
    tp3: r(tp3), tp3R,
    slDistance: r(slDistance),
    atr: r(currentATR),
    atrRatio: Math.round(slATRRatio * 100) / 100,
    spreadToATR: r(spreadToATR),
    positionSize: Math.round(positionSize * sizeMultiplier * 10000) / 10000,
    riskAmount: r(riskAmount * sizeMultiplier),
    riskPct: r(riskPct * sizeMultiplier * 100),
    estimatedFees: r(estimatedFees),
    sizeMultiplier,
    effectiveRR: r(effectiveRR),
    isValid,
    rejectionReasons,
    warnings,
    spread: r(spread),
    slMethod: slFromOB ? 'OB_EDGE' : slFromSwing ? 'SWING' : 'ATR',
    // Invalidation price: what would cancel this trade idea
    invalidationPrice: r(isBuy ? sl - currentATR * 0.5 : sl + currentATR * 0.5),
    invalidationReason: isBuy
      ? `Price closing below ${r(sl - currentATR * 0.5)} would invalidate the bullish thesis`
      : `Price closing above ${r(sl + currentATR * 0.5)} would invalidate the bearish thesis`,
  };
}

function updateTrailingStop(signal, currentPrice, candles1h) {
  const isBuy = signal.direction === 'LONG';
  const atr = calcATR(candles1h, 14);
  const currentATR = atr[atr.length - 1] || 1;

  if (signal.status === 'TP1_HIT') return signal.entry_price; // Breakeven
  if (signal.status === 'TP2_HIT') return isBuy ? currentPrice - currentATR * 2 : currentPrice + currentATR * 2;
  return signal.sl_price;
}

function reject(reasons) {
  return { isValid: false, rejectionReasons: reasons, warnings: [] };
}

function getRiskState() {
  resetDailyIfNeeded();
  return { ...riskState };
}

function r(v) { return Math.round(v * 100) / 100; }

module.exports = { calculateEntryRisk, updateTrailingStop, recordLoss, recordWin, recordTrade, getRiskState };
