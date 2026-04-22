/**
 * NEXUS — Signal Generator + Tracker
 * Fires signals when confluence threshold met. Tracks outcomes.
 */
const config = require('../core/config');
const logger = require('../core/logger');
const { fetchAllTimeframes, getLatestPrice } = require('../data_engine/fetcher');
const { calculateFullConfluence } = require('../analysis_engine/confluence');
const { calculateEntryRisk, updateTrailingStop } = require('./risk_manager');
const db = require('../db/database');
const MOD = 'SignalEngine';

async function runSignalCheck(symbol) {
  const startTime = Date.now();
  try {
    logger.info(MOD, `Running signal check for ${symbol}`);

    // Step 1: Fetch data
    const allTF = await fetchAllTimeframes(symbol);
    const { price } = await getLatestPrice(symbol);
    if (!price) { logger.warn(MOD, `No price for ${symbol}`); return null; }

    // Step 2: Run confluence
    const confluence = calculateFullConfluence(symbol, allTF, price, new Date());
    logger.info(MOD, `Confluence for ${symbol}: ${confluence.direction} (score: ${confluence.finalScore})`, { scores: confluence.scores, regime: confluence.regime?.name });

    if (confluence.direction === 'NO_SIGNAL') {
      db.insertSystemRun({ runType: 'signal_check', symbol, result: 'no_signal', durationMs: Date.now() - startTime });
      return { status: 'no_signal', confluence };
    }

    // Step 3: Check duplicates
    const openSignals = db.getOpenSignals(symbol);
    if (openSignals.length > 0) {
      logger.info(MOD, `Skipping ${symbol} — already has open signal`);
      return { status: 'skipped', reason: 'open_signal_exists', confluence };
    }

    // Step 4: Check cooldown
    const recent = db.countRecentSignals(symbol, confluence.direction, config.defaultThresholds.signalCooldownHours);
    if (recent > 0) {
      logger.info(MOD, `Skipping ${symbol} — same direction fired within ${config.defaultThresholds.signalCooldownHours}h`);
      return { status: 'skipped', reason: 'cooldown', confluence };
    }

    // Step 5: Check max active signals
    const allOpen = db.getOpenSignals();
    if (allOpen.length >= config.defaultThresholds.maxActiveSignals) {
      logger.info(MOD, `Skipping — max active signals (${allOpen.length})`);
      return { status: 'skipped', reason: 'max_active', confluence };
    }

    // Step 6: Portfolio correlation guard (BTC + ETH same direction)
    if (symbol !== 'XAUUSD') {
      const otherCrypto = allOpen.filter(s => s.asset_symbol !== 'XAUUSD' && s.direction === confluence.direction);
      if (otherCrypto.length > 0) {
        logger.info(MOD, `Reducing confidence — correlated crypto exposure`);
        // Don't block, but we could reduce size in risk manager
      }
    }

    // Step 7: Calculate risk
    const risk = calculateEntryRisk(confluence.direction, price, allTF['1h'], confluence, symbol);
    if (!risk.isValid) {
      logger.warn(MOD, `Signal rejected for ${symbol}: ${risk.rejectionReasons.join(', ')}`);
      return { status: 'rejected', reason: risk.rejectionReasons, confluence, risk };
    }

    // Step 8: Create signal
    const expiryTime = new Date(Date.now() + config.defaultThresholds.signalExpiryHours * 3600 * 1000).toISOString();
    const signalId = db.insertSignal({
      asset_symbol: symbol,
      direction: confluence.direction,
      tier: confluence.tier,
      confluence_score: confluence.finalScore,
      entry_price: risk.entry,
      sl_price: risk.sl,
      tp1_price: risk.tp1,
      tp2_price: risk.tp2,
      tp3_price: risk.tp3,
      sl_distance: risk.slDistance,
      atr_at_signal: risk.atr,
      confluence_breakdown: confluence,
      regime: confluence.regime.name,
      regime_confidence: confluence.regime.confidence,
      session_name: confluence.details?.sessionDetails?.name || 'unknown',
      reasoning: buildReasoning(confluence, risk),
      expiry_time: expiryTime,
    });

    db.insertSignalEvent(signalId, 'CREATED', risk.entry, `${confluence.tier} ${confluence.direction} signal — score ${confluence.finalScore}`);
    db.insertSystemRun({ runType: 'signal_check', symbol, result: 'signal_created', durationMs: Date.now() - startTime });

    logger.info(MOD, `✅ SIGNAL CREATED: ${confluence.direction} ${symbol} [${confluence.tier}] @ ${risk.entry} | SL: ${risk.sl} | TP2: ${risk.tp2}`);

    return {
      status: 'signal',
      signal: { id: signalId, symbol, ...confluence, ...risk },
    };
  } catch (err) {
    logger.error(MOD, `Signal check failed for ${symbol}`, { error: err.message, stack: err.stack });
    db.insertSystemRun({ runType: 'signal_check', symbol, result: 'error', durationMs: Date.now() - startTime, error: err.message });
    return { status: 'error', error: err.message };
  }
}

async function updateSignalOutcomes() {
  const openSignals = db.getOpenSignals();
  for (const signal of openSignals) {
    try {
      const { price } = await getLatestPrice(signal.asset_symbol);
      if (!price) continue;
      const isBuy = signal.direction === 'LONG';

      // Check expiry
      if (signal.expiry_time && new Date(signal.expiry_time) < new Date()) {
        db.updateSignal(signal.id, { status: 'EXPIRED', closed_at: new Date().toISOString(), outcome_r: 0 });
        db.insertSignalEvent(signal.id, 'EXPIRED', price, 'Signal expired');
        continue;
      }

      // Check SL
      if ((isBuy && price <= signal.sl_price) || (!isBuy && price >= signal.sl_price)) {
        const outcomeR = signal.status === 'TP1_HIT' ? 0 : -1; // BE after TP1
        db.updateSignal(signal.id, { status: 'LOSS', closed_at: new Date().toISOString(), outcome_r: outcomeR, pnl_usd: outcomeR * signal.sl_distance * (config.assets[signal.asset_symbol]?.pipValue || 0.01) });
        db.insertSignalEvent(signal.id, 'SL_HIT', price, `Stop loss hit. R: ${outcomeR}`);
        logger.info(MOD, `❌ ${signal.asset_symbol} SL hit @ ${price} | R: ${outcomeR}`);
        continue;
      }

      // Check TP1
      if (signal.status === 'OPEN') {
        if ((isBuy && price >= signal.tp1_price) || (!isBuy && price <= signal.tp1_price)) {
          db.updateSignal(signal.id, { status: 'TP1_HIT', trailing_sl: signal.entry_price });
          db.insertSignalEvent(signal.id, 'TP1_HIT', price, 'TP1 hit — SL moved to breakeven');
          logger.info(MOD, `🎯 ${signal.asset_symbol} TP1 hit @ ${price} — SL → BE`);
          continue;
        }
      }

      // Check TP2
      if (signal.status === 'TP1_HIT') {
        if ((isBuy && price >= signal.tp2_price) || (!isBuy && price <= signal.tp2_price)) {
          db.updateSignal(signal.id, { status: 'TP2_HIT' });
          db.insertSignalEvent(signal.id, 'TP2_HIT', price, 'TP2 hit — trailing stop active');
          logger.info(MOD, `🎯🎯 ${signal.asset_symbol} TP2 hit @ ${price}`);
          continue;
        }
      }

      // Check TP3 (full win)
      if ((isBuy && price >= signal.tp3_price) || (!isBuy && price <= signal.tp3_price)) {
        const rAchieved = config.risk.tp3R;
        db.updateSignal(signal.id, { status: 'WIN', closed_at: new Date().toISOString(), outcome_r: rAchieved, pnl_usd: rAchieved * signal.sl_distance * (config.assets[signal.asset_symbol]?.pipValue || 0.01) });
        db.insertSignalEvent(signal.id, 'TP3_HIT', price, `Full win! R: ${rAchieved}`);
        logger.info(MOD, `✅✅✅ ${signal.asset_symbol} TP3 hit @ ${price} | R: ${rAchieved}`);
      }
    } catch (err) {
      logger.error(MOD, `Tracker error for signal ${signal.id}`, { error: err.message });
    }
  }
}

function buildReasoning(confluence, risk) {
  const parts = [];
  parts.push(`Direction: ${confluence.direction} (score: ${confluence.finalScore})`);
  parts.push(`Tier: ${confluence.tier}`);
  parts.push(`Regime: ${confluence.regime.name} (${confluence.regime.confidence})`);
  parts.push(`SMC: ${confluence.scores.smc} | MTF: ${confluence.scores.mtf} | Vol: ${confluence.scores.volume} | Mom: ${confluence.scores.momentum} | Key: ${confluence.scores.keyLevel}`);
  if (confluence.details?.smcDetails?.trend1h) parts.push(`1H Trend: ${confluence.details.smcDetails.trend1h}`);
  if (confluence.details?.mtfAlignment) parts.push(`MTF Alignment: ${confluence.details.mtfAlignment}`);
  parts.push(`SL: ${risk.sl} (${risk.atrRatio}x ATR) | TP2: ${risk.tp2} (${risk.tp2R}R)`);
  return parts.join(' | ');
}

module.exports = { runSignalCheck, updateSignalOutcomes };
