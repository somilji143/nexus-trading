/**
 * NEXUS v3 — Confluence Engine
 * Aggregates all analysis systems. Applies regime-specific scoring,
 * data quality gates, and returns fully explainable signal decisions.
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
const { validateAllTimeframes, detectDataSource } = require('../data_engine/dataQuality');
const { getDataMode } = require('../data_engine/fetcher');
const MOD = 'Confluence';

function calculateFullConfluence(symbol, allTimeframes, currentPrice, utcTime) {
  const candles1h = allTimeframes['1h'] || [];
  const candles4h = allTimeframes['4h'] || [];
  const candles1d = allTimeframes['1d'] || [];
  const candles1w = allTimeframes['1w'] || [];
  const checklist = []; // Signal explanation checklist
  const blockers = [];  // Why no trade

  // ─── Step 0: Data Quality Gate ─────────────────
  const dataQuality = validateAllTimeframes(symbol, allTimeframes);
  const dataSource = detectDataSource(candles1h);
  const dataModeCurrent = getDataMode(symbol);

  if (!dataQuality.overallPassed) {
    const issues = Object.entries(dataQuality.reports)
      .filter(([, r]) => !r.passed)
      .map(([tf, r]) => `${tf}: ${r.issues[0]}`)
      .join('; ');
    return buildResult(symbol, 'NO_SIGNAL', null, 0.5, {}, { regime: 'UNKNOWN', confidence: 0 },
      { blocked: false }, null, `Data quality failed: ${issues}`, null, checklist, blockers, dataQuality, dataModeCurrent);
  }

  if (candles1h.length < 60) {
    blockers.push('Insufficient 1H data: need 60+ candles');
    return buildResult(symbol, 'NO_SIGNAL', null, 0.5, {}, { regime: 'UNKNOWN', confidence: 0 },
      { blocked: false }, null, 'Insufficient data', null, checklist, blockers, dataQuality, dataModeCurrent);
  }

  // ─── Step 1: Regime Detection ──────────────────
  const regime = detectRegime(candles1h);
  checklist.push({ system: 'Regime', value: regime.regime, detail: `ADX: ${regime.metrics?.adx}, ATR expansion: ${regime.metrics?.atrExpansion}x`, pass: regime.regime !== 'LOW_VOL' });

  if (regime.regime === 'LOW_VOL' && regime.confidence > 0.6) {
    blockers.push(`Low volatility regime (ADX: ${regime.metrics?.adx}) — market too quiet for signals`);
    return buildResult(symbol, 'NO_SIGNAL', null, 0.5, {}, regime, { blocked: false }, null, 'LOW_VOL regime — no trade', null, checklist, blockers, dataQuality, dataModeCurrent);
  }

  // ─── Step 2: Get all subsystem scores ──────────
  const smc = calculateSMCScore(candles1h, candles4h, currentPrice);
  const mtf = calculateMTFScore(allTimeframes);

  let prelimDir = 'neutral';
  if (smc.score > 0.6 && mtf.score > 0.6) prelimDir = 'long';
  else if (smc.score < 0.4 && mtf.score < 0.4) prelimDir = 'short';
  else if (smc.score > 0.55 || mtf.score > 0.55) prelimDir = 'long';
  else if (smc.score < 0.45 || mtf.score < 0.45) prelimDir = 'short';

  const volume = calculateVolumeScore(candles1h, candles4h, prelimDir);
  const momentum = calculateMomentumScore(candles1h, prelimDir);
  const session = calculateSessionScore(symbol, utcTime || new Date());
  const keyLevel = calculateKeyLevelScore(currentPrice, symbol, candles1d, candles1w, prelimDir);

  // Build checklist
  checklist.push({ system: 'Smart Money (SMC)', value: `${(smc.score * 100).toFixed(0)}%`, detail: `Structure: ${smc.trend1h || 'N/A'}, OBs: ${smc.activeOB ? 'yes' : 'no'}`, pass: smc.score > 0.55 || smc.score < 0.45 });
  checklist.push({ system: 'Multi-TF Trend', value: `${(mtf.score * 100).toFixed(0)}%`, detail: `Alignment: ${mtf.alignment || 'N/A'}`, pass: mtf.score > 0.55 || mtf.score < 0.45 });
  checklist.push({ system: 'Volume', value: `${(volume.score * 100).toFixed(0)}%`, detail: dataSource === 'SYNTHETIC' ? '⚠️ Synthetic volume' : 'Live volume', pass: volume.score > 0.5 });
  checklist.push({ system: 'Momentum', value: `${(momentum.score * 100).toFixed(0)}%`, detail: `Divergences: ${momentum.divergences?.length || 0}`, pass: momentum.score > 0.5 });
  checklist.push({ system: 'Session', value: session.valid ? `✅ ${session.session?.name}` : `❌ ${session.reason}`, detail: `Multiplier: ${session.multiplier}x`, pass: session.valid });
  checklist.push({ system: 'Key Levels', value: `${(keyLevel.score * 100).toFixed(0)}%`, detail: `Nearby levels: ${keyLevel.nearbyLevels?.length || 0}`, pass: keyLevel.score > 0.45 });

  // ─── Step 3: Fake move filter ──────────────────
  const fakeMove = detectFakeMoves(candles1h);

  // ─── Step 4: Regime-specific weighted scoring ──
  const scores = {
    smc: smc.score,
    mtf: mtf.score,
    volume: volume.score,
    momentum: momentum.score,
    keyLevel: keyLevel.score,
  };

  // Regime-specific weights (not fixed)
  let weights;
  switch (regime.regime) {
    case 'TRENDING':
      weights = { smc: 0.20, mtf: 0.30, volume: 0.15, momentum: 0.15, keyLevel: 0.10 };
      break;
    case 'RANGING':
      weights = { smc: 0.15, mtf: 0.10, volume: 0.15, momentum: 0.20, keyLevel: 0.30 };
      break;
    case 'VOLATILE':
      weights = { smc: 0.30, mtf: 0.15, volume: 0.20, momentum: 0.15, keyLevel: 0.10 };
      break;
    default:
      weights = config.weights;
  }

  let finalScore = 0;
  let totalWeight = 0;
  for (const [key, w] of Object.entries(weights)) {
    finalScore += (scores[key] || 0.5) * w;
    totalWeight += w;
  }
  finalScore /= totalWeight;

  // Apply session multiplier
  finalScore *= session.multiplier;

  // Regime damping
  if (regime.regime === 'VOLATILE') finalScore = 0.5 + (finalScore - 0.5) * 0.75;
  if (regime.regime === 'RANGING') finalScore = 0.5 + (finalScore - 0.5) * 0.85;

  // Synthetic data penalty (reduce confidence)
  if (dataSource === 'SYNTHETIC') {
    finalScore = 0.5 + (finalScore - 0.5) * 0.9;
  }

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

  if (!session.valid) { blocked = true; blockReason = session.reason; blockers.push(`Session filter: ${session.reason}`); }
  if (fakeMove.blocked) { blocked = true; blockReason = `Fake move: ${fakeMove.reasons[0]}`; blockers.push(`Fake move detected: ${fakeMove.reasons[0]}`); }

  if (direction === 'NO_SIGNAL') {
    blockers.push(`Confluence score ${(finalScore * 100).toFixed(0)}% in neutral zone (need >${(thresholds.long * 100).toFixed(0)}% for LONG or <${(thresholds.short * 100).toFixed(0)}% for SHORT)`);
  }

  if (blocked && direction !== 'NO_SIGNAL') {
    blockers.push(`Signal blocked: ${blockReason}`);
    direction = 'NO_SIGNAL';
  }

  // ─── Step 8: Assign tier ───────────────────────
  let tier = null;
  if (direction !== 'NO_SIGNAL') {
    const extremity = direction === 'LONG' ? finalScore : 1 - finalScore;
    if (extremity >= 0.85) tier = 'A+';
    else if (extremity >= 0.78) tier = 'A';
    else tier = 'B';
    checklist.push({ system: 'SIGNAL', value: `${direction} ${tier}`, detail: `Score: ${(finalScore * 100).toFixed(0)}%`, pass: true });
  }

  return buildResult(symbol, direction, tier, finalScore, scores, regime, fakeMove, session, null,
    { smc, mtf, volume, momentum, session, keyLevel, thresholds, weights },
    checklist, blockers, dataQuality, dataModeCurrent);
}

function calculateDynamicThresholds(symbol, regime) {
  let longMin = config.defaultThresholds.longMinScore;
  let shortMax = config.defaultThresholds.shortMaxScore;

  if (regime.regime === 'TRENDING') { longMin -= 0.03; shortMax += 0.03; }
  if (regime.regime === 'VOLATILE') { longMin += 0.05; shortMax -= 0.05; }
  if (regime.regime === 'RANGING') { longMin += 0.02; shortMax -= 0.02; }
  if (symbol !== 'XAUUSD') { longMin += 0.01; shortMax -= 0.01; }

  return {
    long: Math.round(Math.max(0.65, Math.min(0.85, longMin)) * 100) / 100,
    short: Math.round(Math.max(0.15, Math.min(0.35, shortMax)) * 100) / 100,
  };
}

function buildResult(symbol, direction, tier, finalScore, scores, regime, fakeMove, session, reason, details, checklist, blockers, dataQuality, dataMode) {
  return {
    symbol,
    direction,
    tier,
    finalScore: Math.round(finalScore * 100) / 100,
    thresholds: details?.thresholds || {},
    regime: { name: regime.regime, confidence: regime.confidence, metrics: regime.metrics },
    scores,
    dataMode: dataMode || 'UNKNOWN',
    dataQuality: dataQuality ? {
      overallPassed: dataQuality.overallPassed,
      grades: Object.fromEntries(Object.entries(dataQuality.reports || {}).map(([tf, r]) => [tf, r.grade])),
    } : null,
    filters: {
      sessionValid: session ? session.valid : true,
      fakeMoveBlocked: fakeMove ? fakeMove.blocked : false,
      fakeMoveProb: fakeMove ? fakeMove.probability : 0,
    },
    checklist: checklist || [],
    blockers: blockers || [],
    details: details ? {
      smcDetails: { trend1h: details.smc?.trend1h, trend4h: details.smc?.trend4h, activeOB: details.smc?.activeOB, activeFVGs: details.smc?.activeFVGs, recentSweeps: details.smc?.recentSweeps, premiumDiscount: details.smc?.premiumDiscount },
      mtfBreakdown: details.mtf?.breakdown,
      mtfAlignment: details.mtf?.alignment,
      volumeDetails: { cvdDivergence: details.volume?.cvdDivergence, vsaSignals: details.volume?.vsaSignals },
      momentumDetails: { divergences: details.momentum?.divergences?.length || 0, macd: details.momentum?.macd?.signal, stochastic: details.momentum?.stochastic, agreeing: details.momentum?.agreeing },
      sessionDetails: { name: details.session?.session?.name, multiplier: details.session?.multiplier },
      keyLevels: details.keyLevel?.nearbyLevels,
      fibonacci: details.keyLevel?.fibonacci,
      weights: details.weights,
    } : {},
    reason: reason || (direction === 'NO_SIGNAL'
      ? (blockers.length > 0 ? blockers[0] : 'Confluence score in neutral zone')
      : null),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { calculateFullConfluence };
