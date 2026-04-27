/**
 * NEXUS v3 — Signal Generator + Tracker
 * Risk-first. Strategy-classified. Fully explainable.
 * Fires signals only when confluence + data quality + risk all pass.
 */
const config = require('../core/config');
const logger = require('../core/logger');
const { fetchAllTimeframes, getLatestPrice, getDataMode } = require('../data_engine/fetcher');
const { calculateFullConfluence } = require('../analysis_engine/confluence');
const { calculateEntryRisk, updateTrailingStop, recordLoss } = require('./risk_manager');
const { classifyStrategy } = require('../strategy/strategyClassifier');
const { writeTradeAnalysis, writeSignalRisks } = require('../strategy/analysisWriter');
const db = require('../db/database');
const MOD = 'SignalEngine';

async function runSignalCheck(symbol) {
  const startTime = Date.now();
  try {
    logger.info(MOD, `Running signal check for ${symbol}`);

    // Step 1: Fetch data
    const allTF = await fetchAllTimeframes(symbol);
    const { price, source: priceSource } = await getLatestPrice(symbol);
    if (!price) { logger.warn(MOD, `No price for ${symbol}`); return { status: 'no_signal', reason: 'No price data' }; }
    const dataMode = getDataMode(symbol);

    // Step 2: Run confluence (includes data quality gate)
    const confluence = calculateFullConfluence(symbol, allTF, price, new Date());
    logger.info(MOD, `Confluence for ${symbol}: ${confluence.direction} (score: ${confluence.finalScore})`,
      { regime: confluence.regime?.name, dataMode });

    // Step 3: Classify strategy
    const strategy = classifyStrategy(
      confluence.regime || {},
      confluence.details?.smcDetails || {},
      confluence.details?.mtfBreakdown || {},
      confluence.details?.momentumDetails || {},
      allTF['1h'] || [],
      price
    );

    if (confluence.direction === 'NO_SIGNAL') {
      const analysis = writeTradeAnalysis({ ...confluence, symbol, strategy, dataMode });
      db.insertSystemRun({ runType: 'signal_check', symbol, result: 'no_signal', durationMs: Date.now() - startTime });
      return {
        status: 'no_signal',
        confluence,
        strategy,
        analysis,
        dataMode,
        priceSource,
      };
    }

    // Step 4: Check duplicates
    const openSignals = db.getOpenSignals(symbol);
    if (openSignals.length > 0) {
      return { status: 'skipped', reason: 'open_signal_exists', confluence, strategy, dataMode };
    }

    // Step 5: Cooldown
    const recent = db.countRecentSignals(symbol, confluence.direction, config.defaultThresholds.signalCooldownHours);
    if (recent > 0) {
      return { status: 'skipped', reason: 'cooldown', confluence, strategy, dataMode };
    }

    // Step 6: Max active signals
    const allOpen = db.getOpenSignals();
    if (allOpen.length >= config.defaultThresholds.maxActiveSignals) {
      return { status: 'skipped', reason: 'max_active', confluence, strategy, dataMode };
    }

    // Step 7: Calculate risk (includes daily/weekly loss limits, correlation guard)
    const risk = calculateEntryRisk(confluence.direction, price, allTF['1h'], confluence, symbol, allOpen);
    if (!risk.isValid) {
      logger.warn(MOD, `Signal rejected for ${symbol}: ${risk.rejectionReasons.join(', ')}`);
      const analysis = writeTradeAnalysis({ ...confluence, symbol, strategy, risk, dataMode });
      return { status: 'rejected', reason: risk.rejectionReasons, confluence, risk, strategy, analysis, dataMode };
    }

    // Step 8: Strategy confidence check — no trade if strategy type is NONE
    if (strategy.type === 'NONE') {
      return {
        status: 'no_signal',
        reason: 'No clear strategy pattern',
        confluence, risk, strategy, dataMode,
        analysis: `${symbol}: Confluence score passed but no identifiable strategy pattern. Waiting for clearer setup.`,
      };
    }

    // Step 9: Build analysis and risks
    const signalData = { ...confluence, symbol, strategy, risk, dataMode };
    const analysis = writeTradeAnalysis(signalData);
    const risks = writeSignalRisks(signalData);

    // Step 10: Create signal
    const expiryTime = new Date(Date.now() + config.defaultThresholds.signalExpiryHours * 3600000).toISOString();
    const reasoning = buildReasoning(confluence, risk, strategy, analysis);
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
      reasoning,
      expiry_time: expiryTime,
    });

    db.insertSignalEvent(signalId, 'CREATED', risk.entry, `${confluence.tier} ${confluence.direction} | ${strategy.label} | Score ${confluence.finalScore}`);
    db.insertSystemRun({ runType: 'signal_check', symbol, result: 'signal_created', durationMs: Date.now() - startTime });

    logger.info(MOD, `✅ SIGNAL: ${confluence.direction} ${symbol} [${confluence.tier}] | ${strategy.label} | Entry: ${risk.entry} | SL: ${risk.sl} | TP2: ${risk.tp2}`);

    return {
      status: 'signal',
      signal: { id: signalId, symbol, ...confluence, ...risk, strategy, analysis, risks },
      dataMode,
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

      // Expiry
      if (signal.expiry_time && new Date(signal.expiry_time) < new Date()) {
        db.updateSignal(signal.id, { status: 'EXPIRED', closed_at: new Date().toISOString(), outcome_r: 0 });
        db.insertSignalEvent(signal.id, 'EXPIRED', price, 'Signal expired');
        continue;
      }

      // SL hit
      if ((isBuy && price <= signal.sl_price) || (!isBuy && price >= signal.sl_price)) {
        const outcomeR = signal.status === 'TP1_HIT' ? 0 : -1;
        const pnl = outcomeR * signal.sl_distance * (config.assets[signal.asset_symbol]?.pipValue || 0.01);
        db.updateSignal(signal.id, { status: 'LOSS', closed_at: new Date().toISOString(), outcome_r: outcomeR, pnl_usd: pnl });
        db.insertSignalEvent(signal.id, 'SL_HIT', price, `Stop loss hit. R: ${outcomeR}`);
        if (outcomeR < 0) recordLoss(Math.abs(pnl));
        continue;
      }

      // TP1
      if (signal.status === 'OPEN') {
        if ((isBuy && price >= signal.tp1_price) || (!isBuy && price <= signal.tp1_price)) {
          db.updateSignal(signal.id, { status: 'TP1_HIT', trailing_sl: signal.entry_price });
          db.insertSignalEvent(signal.id, 'TP1_HIT', price, 'TP1 hit — SL moved to breakeven');
          continue;
        }
      }

      // TP2
      if (signal.status === 'TP1_HIT') {
        if ((isBuy && price >= signal.tp2_price) || (!isBuy && price <= signal.tp2_price)) {
          db.updateSignal(signal.id, { status: 'TP2_HIT' });
          db.insertSignalEvent(signal.id, 'TP2_HIT', price, 'TP2 hit — trailing active');
          continue;
        }
      }

      // TP3
      if ((isBuy && price >= signal.tp3_price) || (!isBuy && price <= signal.tp3_price)) {
        const rAchieved = config.risk.tp3R;
        db.updateSignal(signal.id, { status: 'WIN', closed_at: new Date().toISOString(), outcome_r: rAchieved });
        db.insertSignalEvent(signal.id, 'TP3_HIT', price, `Full win! R: ${rAchieved}`);
      }
    } catch (err) {
      logger.error(MOD, `Tracker error for signal ${signal.id}`, { error: err.message });
    }
  }
}

function buildReasoning(confluence, risk, strategy, analysis) {
  const parts = [];
  parts.push(`Strategy: ${strategy.label}`);
  parts.push(`Direction: ${confluence.direction} (score: ${confluence.finalScore})`);
  parts.push(`Tier: ${confluence.tier} | Regime: ${confluence.regime.name}`);
  if (strategy.reasons) parts.push(`Setup: ${strategy.reasons[0]}`);
  parts.push(`SL: ${risk.sl} (${risk.slMethod}) | TP2: ${risk.tp2} (${risk.tp2R}R)`);
  parts.push(`R:R: ${risk.effectiveRR} | Data: ${confluence.dataMode}`);
  return parts.join(' | ');
}

module.exports = { runSignalCheck, updateSignalOutcomes };
