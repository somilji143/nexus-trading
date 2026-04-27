/**
 * NEXUS v3 — Analysis Writer
 * Generates professional, honest, explainable analysis text.
 * Never promises profits. Explains setup, risks, and invalidation.
 */

function writeTradeAnalysis(signal) {
  const { direction, symbol, regime, strategy, scores, risk, checklist, dataMode } = signal;

  if (direction === 'NO_SIGNAL' || !direction) {
    return writeNoTradeAnalysis(signal);
  }

  const dir = direction === 'LONG' ? 'bullish' : 'bearish';
  const action = direction === 'LONG' ? 'buy' : 'sell';
  const regimeName = regime?.name || 'unknown';
  const stratType = strategy?.label || 'Multi-factor';

  const parts = [];

  // Opening — what's happening
  parts.push(`${symbol} shows a ${dir} setup on the 1H timeframe (${stratType}).`);

  // Regime context
  if (regimeName === 'TRENDING') {
    parts.push(`Market is trending with ADX at ${regime.metrics?.adx?.toFixed(0) || 'N/A'}, supporting directional trades.`);
  } else if (regimeName === 'RANGING') {
    parts.push(`Market is range-bound. This is a mean-reversion setup at a range extreme.`);
  } else if (regimeName === 'VOLATILE') {
    parts.push(`Volatility is elevated. Position size has been reduced accordingly.`);
  }

  // Strategy reasons
  if (strategy?.reasons?.length > 0) {
    parts.push(strategy.reasons.join('. ') + '.');
  }

  // Risk levels
  if (risk) {
    parts.push(`Entry at $${risk.entry}, stop loss at $${risk.sl} (${risk.slMethod || 'structure-based'}), targeting $${risk.tp2} for ${risk.tp2R || '2.5'}R.`);
    parts.push(`Risk/reward ratio is ${risk.effectiveRR || 'N/A'}.`);
  }

  // Invalidation
  if (risk?.invalidationReason) {
    parts.push(risk.invalidationReason);
  }

  // Data mode warning
  if (dataMode === 'DEMO') {
    parts.push('⚠️ This analysis uses synthetic demo data and should not be treated as a real signal.');
  }

  return parts.join(' ');
}

function writeNoTradeAnalysis(signal) {
  const { symbol, blockers, regime, scores } = signal;
  const parts = [];

  parts.push(`No trade on ${symbol}.`);

  // Explain the main reason
  if (blockers && blockers.length > 0) {
    parts.push(blockers[0] + '.');
  }

  // Regime context
  const regimeName = regime?.name || 'unknown';
  if (regimeName === 'LOW_VOL') {
    parts.push('Market volatility is too low for reliable signal generation.');
  } else if (regimeName === 'RANGING') {
    const finalScore = signal.finalScore || 0;
    if (finalScore > 0.4 && finalScore < 0.6) {
      parts.push('Price is in the middle of a range — entry here gives poor risk/reward.');
    }
  } else if (regimeName === 'VOLATILE') {
    parts.push('Elevated volatility increases risk of false signals.');
  }

  // What would change the picture
  if (scores) {
    const weakest = Object.entries(scores).sort((a, b) => {
      const aDist = Math.abs(a[1] - 0.5);
      const bDist = Math.abs(b[1] - 0.5);
      return aDist - bDist;
    })[0];
    if (weakest) {
      parts.push(`Weakest factor: ${weakest[0]} at ${(weakest[1] * 100).toFixed(0)}%.`);
    }
  }

  parts.push('Waiting for a clearer setup before committing capital.');
  return parts.join(' ');
}

function writeSignalRisks(signal) {
  const risks = [];
  const { regime, scores, dataMode, direction } = signal;

  if (dataMode === 'DEMO') risks.push('Analysis based on synthetic data, not live market');
  if (regime?.name === 'VOLATILE') risks.push('High volatility may cause slippage beyond expected levels');
  if (scores?.volume < 0.5) risks.push('Volume confirmation is weak');
  if (scores?.momentum < 0.45) risks.push('Momentum is not fully aligned');
  if (regime?.metrics?.atrExpansion > 1.5) risks.push('ATR is elevated — wider stops may be needed');

  // Direction-specific
  if (direction === 'LONG' && scores?.mtf < 0.5) risks.push('Multi-timeframe trend is not fully bullish');
  if (direction === 'SHORT' && scores?.mtf > 0.5) risks.push('Multi-timeframe trend is not fully bearish');

  return risks.length > 0 ? risks : ['Standard market risk applies'];
}

module.exports = { writeTradeAnalysis, writeNoTradeAnalysis, writeSignalRisks };
