/**
 * NEXUS v3 — Strategy Classifier
 * Classifies each signal into a specific strategy type with reasons.
 * A. Trend Pullback  B. Liquidity Sweep Reversal  C. Breakout Retest
 * D. Range Mean Reversion  E. Momentum Continuation
 */

function classifyStrategy(regime, smc, mtf, momentum, candles1h, currentPrice) {
  const trend1h = smc.trend1h || 'ranging';
  const trend4h = smc.trend4h || 'ranging';
  const recentSweeps = smc.recentSweeps || [];
  const pd = smc.premiumDiscount || { zone: 'neutral' };
  const events = smc.structureEvents || [];
  const hasBOS = events.some(e => e.type.includes('BOS'));
  const hasCHoCH = events.some(e => e.type.includes('CHoCH'));
  const hasOB = !!smc.activeOB;

  // Check for EMA pullback
  let nearEMA = false;
  if (candles1h.length > 50) {
    const closes = candles1h.map(c => c.close);
    const ema20 = simpleEMA(closes, 20);
    const last = closes[closes.length - 1];
    const e20 = ema20[ema20.length - 1];
    const atr = avgRange(candles1h.slice(-14));
    nearEMA = Math.abs(last - e20) < atr * 1.5;
  }

  const strategies = [];

  // A. Trend Pullback
  if ((regime.regime === 'TRENDING' || regime.metrics?.adx > 22) &&
      (trend4h === 'bullish' || trend4h === 'bearish') &&
      nearEMA && !hasCHoCH) {
    strategies.push({
      type: 'TREND_PULLBACK',
      label: 'Trend Pullback',
      confidence: 0.85,
      reasons: [
        `${trend4h} trend on 4H with ADX ${regime.metrics?.adx?.toFixed(0)}`,
        'Price pulled back to value area (near EMA)',
        'Structure intact — no CHoCH detected',
      ],
    });
  }

  // B. Liquidity Sweep Reversal
  if (recentSweeps.length > 0 && recentSweeps[0].candlesSince < 8) {
    const sweep = recentSweeps[0];
    const dir = sweep.type === 'bullish_sweep' ? 'bullish' : 'bearish';
    strategies.push({
      type: 'LIQUIDITY_SWEEP',
      label: 'Liquidity Sweep Reversal',
      confidence: 0.80,
      reasons: [
        `${dir} liquidity sweep detected ${sweep.candlesSince} candles ago`,
        `Key level at ${sweep.level.toFixed(2)} was swept and reclaimed`,
        'Potential stop-hunt reversal setup',
      ],
    });
  }

  // C. Breakout Retest
  if (hasBOS && regime.metrics?.atrExpansion > 1.2 && !hasCHoCH) {
    const bosEvent = events.find(e => e.type.includes('BOS'));
    strategies.push({
      type: 'BREAKOUT_RETEST',
      label: 'Breakout Retest',
      confidence: 0.75,
      reasons: [
        `Break of structure detected at ${bosEvent?.price?.toFixed(2) || 'N/A'}`,
        `ATR expansion: ${regime.metrics?.atrExpansion?.toFixed(2)}x — confirms momentum`,
        'Waiting for retest of broken level',
      ],
    });
  }

  // D. Range Mean Reversion
  if (regime.regime === 'RANGING' && (pd.zone === 'discount' || pd.zone === 'premium')) {
    const atExtreme = pd.ratio < 0.25 || pd.ratio > 0.75;
    if (atExtreme) {
      strategies.push({
        type: 'RANGE_MEAN_REVERSION',
        label: 'Range Mean Reversion',
        confidence: 0.70,
        reasons: [
          `Price at ${pd.zone} zone (${(pd.ratio * 100).toFixed(0)}% of range)`,
          'Market regime is range-bound',
          'Setup at range extreme — not middle',
        ],
      });
    }
  }

  // E. Momentum Continuation
  if (regime.regime === 'TRENDING' && regime.metrics?.adx > 30 && trend1h === trend4h) {
    strategies.push({
      type: 'MOMENTUM_CONTINUATION',
      label: 'Momentum Continuation',
      confidence: 0.75,
      reasons: [
        `Strong trend — ADX ${regime.metrics?.adx?.toFixed(0)} with aligned 1H/4H`,
        `${trend1h} momentum continuing`,
        'High ADX supports continuation entry',
      ],
    });
  }

  // Sort by confidence and return best
  strategies.sort((a, b) => b.confidence - a.confidence);
  return strategies.length > 0 ? strategies[0] : {
    type: 'NONE',
    label: 'No Clear Strategy',
    confidence: 0,
    reasons: ['No valid strategy pattern detected in current conditions'],
  };
}

function simpleEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

function avgRange(candles) {
  return candles.reduce((s, c) => s + (c.high - c.low), 0) / candles.length;
}

module.exports = { classifyStrategy };
