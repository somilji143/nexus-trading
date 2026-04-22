/**
 * NEXUS — Confluence Engine (THE BRAIN)
 * Aggregates all 6+ analysis systems. Applies regime logic, filters,
 * dynamic thresholds. Returns structured, explainable signal decision.
 */
const config = require('../core/config');
const logger = require('../core/logger');
const { calculateSMCScore } = require('./smc');
const { calculateMTFScore } = require('./mtf_trend');
const { calculateVolumeScore } = require('./volume');
const { calculateMomentumScore } = require('./momentum');
const { calculateSessionScore } = require('./session');
const { calculateKeyLevelScore } = require('./key_levels');
const { detectRegime } = require('./regime');
const { detectFakeMoves } = require('./filters');
const MOD = 'Confluence';

function calculateFullConfluence(symbol, allTimeframes, currentPrice, utcTime) {
  const candles1h = allTimeframes['1h'] || [];
  const candles4h = allTimeframes['4h'] || [];
  const candles1d = allTimeframes['1d'] || [];
  const candles1w = allTimeframes['1w'] || [];

  if (candles1h.length < 60) {
    logger.warn(MOD, `Insufficient 1H data for ${symbol}: ${candles1h.length} candles`);
    return { symbol, direction: 'NO_SIGNAL', reason: 'Insufficient data' };
  }

  // ─── Step 1: Regime Detection ──────────────────
  const regime = detectRegime(candles1h);

  // LOW_VOL → block all signals
  if (regime.regime === 'LOW_VOL' && regime.confidence > 0.6) {
    return buildResult(symbol, 'NO_SIGNAL', null, 0.5, {}, regime, { blocked: false }, null, 'LOW_VOL regime — no trade');
  }

  // ─── Step 2: Get all subsystem scores ──────────
  const smc = calculateSMCScore(candles1h, candles4h, currentPrice);
  const mtf = calculateMTFScore(allTimeframes);

  // Determine preliminary direction for directional scores
  let prelimDir = 'neutral';
  if (smc.score > 0.6 && mtf.score > 0.6) prelimDir = 'long';
  else if (smc.score < 0.4 && mtf.score < 0.4) prelimDir = 'short';
  else if (smc.score > 0.55 || mtf.score > 0.55) prelimDir = 'long';
  else if (smc.score < 0.45 || mtf.score < 0.45) prelimDir = 'short';

  const volume = calculateVolumeScore(candles1h, candles4h, prelimDir);
  const momentum = calculateMomentumScore(candles1h, prelimDir);
  const session = calculateSessionScore(symbol, utcTime || new Date());
  const keyLevel = calculateKeyLevelScore(currentPrice, symbol, candles1d, candles1w, prelimDir);

  // ─── Step 3: Fake move filter ──────────────────
  const fakeMove = detectFakeMoves(candles1h);

  // ─── Step 4: Calculate weighted final score ────
  const scores = {
    smc: smc.score,
    mtf: mtf.score,
    volume: volume.score,
    momentum: momentum.score,
    keyLevel: keyLevel.score,
  };

  const weights = config.weights;
  let finalScore = scores.smc * weights.smc
    + scores.mtf * weights.mtf
    + scores.volume * weights.volume
    + scores.momentum * weights.momentum
    + scores.keyLevel * weights.keyLevel;

  // Normalize (session weight is applied as multiplier, not additive)
  const totalWeight = weights.smc + weights.mtf + weights.volume + weights.momentum + weights.keyLevel;
  finalScore /= totalWeight;

  // Apply session multiplier
  finalScore *= session.multiplier;

  // Regime adjustment
  if (regime.regime === 'VOLATILE') finalScore = 0.5 + (finalScore - 0.5) * 0.8; // Dampen in volatile
  if (regime.regime === 'RANGING') finalScore = 0.5 + (finalScore - 0.5) * 0.9; // Slight dampen

  finalScore = Math.max(0, Math.min(1, finalScore));

  // ─── Step 5: Dynamic thresholds ────────────────
  const thresholds = calculateDynamicThresholds(symbol, regime);

  // ─── Step 6: Determine direction ───────────────
  let direction = 'NO_SIGNAL';
  if (finalScore >= thresholds.long) direction = 'LONG';
  else if (finalScore <= thresholds.short) direction = 'SHORT';

  // ─── Step 7: Apply filters ─────────────────────
  let blocked = false;
  let blockReason = null;

  if (!session.valid) { blocked = true; blockReason = session.reason; }
  if (fakeMove.blocked) { blocked = true; blockReason = `Fake move detected: ${fakeMove.reasons[0]}`; }

  if (blocked && direction !== 'NO_SIGNAL') {
    logger.info(MOD, `Signal blocked for ${symbol}: ${blockReason}`);
    direction = 'NO_SIGNAL';
  }

  // ─── Step 8: Assign tier ───────────────────────
  let tier = null;
  if (direction !== 'NO_SIGNAL') {
    const extremity = direction === 'LONG' ? finalScore : 1 - finalScore;
    if (extremity >= 0.85) tier = 'A+';
    else if (extremity >= 0.78) tier = 'A';
    else tier = 'B';
  }

  return buildResult(symbol, direction, tier, finalScore, scores, regime, fakeMove, session, null, {
    smc, mtf, volume, momentum, session, keyLevel, thresholds,
  });
}

function calculateDynamicThresholds(symbol, regime) {
  let longMin = config.defaultThresholds.longMinScore;
  let shortMax = config.defaultThresholds.shortMaxScore;

  // Regime adjustments
  if (regime.regime === 'TRENDING') { longMin -= 0.03; shortMax += 0.03; } // Easier in trend
  if (regime.regime === 'VOLATILE') { longMin += 0.05; shortMax -= 0.05; } // Stricter
  if (regime.regime === 'RANGING') { longMin += 0.02; shortMax -= 0.02; } // Slightly stricter

  // Symbol adjustments (crypto is naturally more volatile)
  if (symbol !== 'XAUUSD') { longMin += 0.01; shortMax -= 0.01; }

  return {
    long: Math.round(Math.max(0.65, Math.min(0.85, longMin)) * 100) / 100,
    short: Math.round(Math.max(0.15, Math.min(0.35, shortMax)) * 100) / 100,
  };
}

function buildResult(symbol, direction, tier, finalScore, scores, regime, fakeMove, session, reason, details) {
  return {
    symbol,
    direction,
    tier,
    finalScore: Math.round(finalScore * 100) / 100,
    thresholds: details?.thresholds || {},
    regime: { name: regime.regime, confidence: regime.confidence, metrics: regime.metrics },
    scores,
    filters: {
      sessionValid: session ? session.valid : true,
      fakeMoveBlocked: fakeMove ? fakeMove.blocked : false,
      fakeMoveProb: fakeMove ? fakeMove.probability : 0,
      newsBlocked: false, // TODO: implement news calendar integration
    },
    details: details ? {
      smcDetails: { trend1h: details.smc?.trend1h, trend4h: details.smc?.trend4h, activeOB: details.smc?.activeOB, activeFVGs: details.smc?.activeFVGs, recentSweeps: details.smc?.recentSweeps, premiumDiscount: details.smc?.premiumDiscount },
      mtfBreakdown: details.mtf?.breakdown,
      mtfAlignment: details.mtf?.alignment,
      volumeDetails: { cvdDivergence: details.volume?.cvdDivergence, vsaSignals: details.volume?.vsaSignals },
      momentumDetails: { divergences: details.momentum?.divergences?.length || 0, macd: details.momentum?.macd?.signal, stochastic: details.momentum?.stochastic, agreeing: details.momentum?.agreeing },
      sessionDetails: { name: details.session?.session?.name, multiplier: details.session?.multiplier },
      keyLevels: details.keyLevel?.nearbyLevels,
      fibonacci: details.keyLevel?.fibonacci,
    } : {},
    reason: reason || (direction === 'NO_SIGNAL' ? 'Confluence score in neutral zone' : null),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { calculateFullConfluence };
