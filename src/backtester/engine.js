/**
 * NEXUS — Backtester Engine
 * Bar-by-bar simulation. No lookahead. Realistic execution.
 * Mirrors live signal engine logic exactly.
 */
const config = require('../core/config');
const logger = require('../core/logger');
const { calcEMA, calcATR, calcRSI, calcMACD, calcStochastic, calcADX, calcBBWidth, calcOBV, calcCVD, calcRollingStdDev } = require('../analysis_engine/indicators');
const MOD = 'Backtester';

function runBacktest({ candles, symbol, commission = 0.0002, slippagePct = 0.0001 }) {
  if (!candles || candles.length < 200) return { error: 'Insufficient data', totalTrades: 0 };

  const warmup = 60;
  let equity = 1000;
  let maxEquity = 1000;
  let activeTrade = null;
  const trades = [];
  const equityCurve = [{ time: candles[warmup]?.time, equity }];
  let cooldown = 0;
  const assetCfg = config.assets[symbol] || {};
  const spread = assetCfg.spread || 0.5;

  // Pre-compute indicators
  const closes = candles.map(c => c.close);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const atr = calcATR(candles, 14);
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const adx = calcADX(candles, 14);
  const bbw = calcBBWidth(closes, 20, 2);
  const obv = calcOBV(candles);
  const cvd = calcCVD(candles);
  const rvol = calcRollingStdDev(closes, 20);

  for (let i = warmup; i < candles.length - 1; i++) {
    const c = candles[i];
    const next = candles[i + 1];

    // ─── Process active trade ────────────────────
    if (activeTrade) {
      const result = processTradeBar(activeTrade, next, spread);
      if (result.closed) {
        equity += result.pnl;
        if (equity > maxEquity) maxEquity = equity;
        activeTrade.pnl = result.pnl;
        activeTrade.outcome = result.outcome;
        activeTrade.exitPrice = result.exitPrice;
        activeTrade.barsHeld = i - activeTrade.entryIdx;
        activeTrade.mae = result.mae;
        activeTrade.mfe = result.mfe;
        trades.push(activeTrade);
        activeTrade = null;
        cooldown = 3;
      } else {
        // Update MAE/MFE
        if (activeTrade.direction === 'LONG') {
          activeTrade._mfe = Math.max(activeTrade._mfe || 0, next.high - activeTrade.entryPrice);
          activeTrade._mae = Math.min(activeTrade._mae || 0, next.low - activeTrade.entryPrice);
        } else {
          activeTrade._mfe = Math.max(activeTrade._mfe || 0, activeTrade.entryPrice - next.low);
          activeTrade._mae = Math.min(activeTrade._mae || 0, activeTrade.entryPrice - next.high);
        }
      }
      equityCurve.push({ time: c.time, equity });
      continue;
    }

    if (cooldown > 0) { cooldown--; equityCurve.push({ time: c.time, equity }); continue; }

    // ─── Signal Logic (no lookahead) ─────────────
    const e20 = ema20[i], e50 = ema50[i], e200 = ema200[i];
    const curATR = atr[i] || 1;
    const curRSI = rsi[i];
    const curADX = adx[Math.min(i, adx.length - 1)] || 20;
    const curBBW = bbw[i] || 0;
    const avgBBW = i > 50 ? bbw.slice(i - 50, i).reduce((s, v) => s + v, 0) / 50 : curBBW;

    // Regime check
    const atrAvg = i > 50 ? atr.slice(i - 50, i).reduce((s, v) => s + v, 0) / 50 : curATR;
    const atrExp = atrAvg > 0 ? curATR / atrAvg : 1;
    const isLowVol = atrExp < 0.6 && curADX < 15;
    const isVolatile = atrExp > 1.8;
    const isTrending = curADX > 22 && Math.abs(e20 - e50) > curATR * 0.1;
    const isRanging = curADX < 18 && Math.abs(e20 - e50) < curATR * 0.05;

    if (isLowVol) { equityCurve.push({ time: c.time, equity }); continue; }

    // ─── Multi-factor confluence ─────────────────
    let bullScore = 0, bearScore = 0;

    // Factor 1: EMA alignment (trend)
    if (e20 > e50 && e50 > e200) bullScore += 2;
    else if (e20 > e50) bullScore += 1;
    if (e20 < e50 && e50 < e200) bearScore += 2;
    else if (e20 < e50) bearScore += 1;

    // Factor 2: Price position relative to EMAs
    if (c.close > e20 && c.close > e50) bullScore += 1;
    if (c.close < e20 && c.close < e50) bearScore += 1;

    // Factor 3: EMA pullback zone
    const emaZone = curATR * 1.5;
    const nearEMA20Bull = c.low <= e20 + emaZone && c.low >= e20 - emaZone && c.close > e20 && c.close > c.open;
    const nearEMA20Bear = c.high >= e20 - emaZone && c.high <= e20 + emaZone && c.close < e20 && c.close < c.open;
    if (nearEMA20Bull && e20 > e50) bullScore += 2;
    if (nearEMA20Bear && e20 < e50) bearScore += 2;

    // Factor 4: RSI
    if (curRSI > 40 && curRSI < 60) { /* neutral */ }
    else if (curRSI > 50 && curRSI < 72) bullScore += 1;
    else if (curRSI < 50 && curRSI > 28) bearScore += 1;

    // Factor 5: MACD histogram momentum
    const hist = macd.histogram[i];
    const prevHist = macd.histogram[i - 1];
    if (hist > 0 && hist > prevHist) bullScore += 1;
    if (hist < 0 && hist < prevHist) bearScore += 1;

    // Factor 6: Volume confirmation
    let volAvg = 0;
    for (let k = Math.max(1, i - 20); k < i; k++) volAvg += candles[k].volume;
    volAvg /= Math.min(20, Math.max(1, i));
    if (c.volume > volAvg * 1.3 && c.close > c.open) bullScore += 1;
    if (c.volume > volAvg * 1.3 && c.close < c.open) bearScore += 1;

    // Factor 7: ADX trend strength
    if (curADX > 25) { if (e20 > e50) bullScore += 1; else bearScore += 1; }

    // Regime adjustments
    const minScore = isVolatile ? 6 : isTrending ? 4 : isRanging ? 6 : 5;

    let direction = null;
    if (bullScore >= minScore && bullScore > bearScore + 1) direction = 'LONG';
    else if (bearScore >= minScore && bearScore > bullScore + 1) direction = 'SHORT';

    if (!direction) { equityCurve.push({ time: c.time, equity }); continue; }

    // ─── Fake move check (simplified) ────────────
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);
    if (upperWick > body * 2.5 || lowerWick > body * 2.5) { equityCurve.push({ time: c.time, equity }); continue; }

    // ─── SL/TP ───────────────────────────────────
    const isBuy = direction === 'LONG';
    const entryPrice = next.open + (isBuy ? spread * 0.01 : -spread * 0.01); // Next bar open + spread

    // SL: structural or ATR-based
    let sl;
    if (isBuy) {
      let swLow = Infinity;
      for (let j = Math.max(0, i - 10); j <= i; j++) swLow = Math.min(swLow, candles[j].low);
      sl = Math.max(swLow - curATR * 0.3, entryPrice - curATR * 2.5);
      sl = Math.min(sl, entryPrice - curATR * 0.5);
    } else {
      let swHigh = -Infinity;
      for (let j = Math.max(0, i - 10); j <= i; j++) swHigh = Math.max(swHigh, candles[j].high);
      sl = Math.min(swHigh + curATR * 0.3, entryPrice + curATR * 2.5);
      sl = Math.max(sl, entryPrice + curATR * 0.5);
    }

    const slDist = Math.abs(entryPrice - sl);
    if (slDist < curATR * 0.3 || slDist > curATR * 3) { equityCurve.push({ time: c.time, equity }); continue; }

    const tp1 = isBuy ? entryPrice + slDist * 1.5 : entryPrice - slDist * 1.5;
    const tp2 = isBuy ? entryPrice + slDist * 2.5 : entryPrice - slDist * 2.5;
    const tp3 = isBuy ? entryPrice + slDist * 4.0 : entryPrice - slDist * 4.0;

    activeTrade = {
      entryIdx: i, entryTime: next.time, direction,
      entryPrice: r(entryPrice), sl: r(sl), tp1: r(tp1), tp2: r(tp2), tp3: r(tp3),
      slDist: r(slDist), tp1Hit: false, tp2Hit: false,
      currentSL: r(sl), _mfe: 0, _mae: 0,
    };

    equityCurve.push({ time: c.time, equity });
  }

  // Close any remaining trade
  if (activeTrade) {
    const lastPrice = candles[candles.length - 1].close;
    const isBuy = activeTrade.direction === 'LONG';
    const pnl = isBuy ? (lastPrice - activeTrade.entryPrice) / activeTrade.slDist : (activeTrade.entryPrice - lastPrice) / activeTrade.slDist;
    activeTrade.pnl = r(pnl);
    activeTrade.outcome = pnl > 0 ? 'WIN' : 'LOSS';
    activeTrade.exitPrice = lastPrice;
    trades.push(activeTrade);
    equity += pnl;
  }

  return computeStats(trades, equityCurve, symbol, equity, maxEquity);
}

function processTradeBar(trade, bar, spread) {
  const isBuy = trade.direction === 'LONG';
  const slippage = spread * 0.005;

  // Check SL first (worst case)
  if ((isBuy && bar.low <= trade.currentSL) || (!isBuy && bar.high >= trade.currentSL)) {
    const exitPrice = isBuy ? trade.currentSL - slippage : trade.currentSL + slippage;
    let pnl;
    if (trade.tp1Hit) pnl = 0.5; // Partial from TP1 + BE on rest
    else if (trade.tp2Hit) pnl = 1.5; // TP1 partial + TP2 partial + BE
    else pnl = -1; // Full loss
    return { closed: true, outcome: trade.tp1Hit ? 'BE' : 'LOSS', exitPrice: r(exitPrice), pnl: r(pnl), mae: trade._mae, mfe: trade._mfe };
  }

  // Check TP1
  if (!trade.tp1Hit) {
    if ((isBuy && bar.high >= trade.tp1) || (!isBuy && bar.low <= trade.tp1)) {
      trade.tp1Hit = true;
      trade.currentSL = trade.entryPrice; // Move to BE
    }
  }

  // Check TP2
  if (trade.tp1Hit && !trade.tp2Hit) {
    if ((isBuy && bar.high >= trade.tp2) || (!isBuy && bar.low <= trade.tp2)) {
      trade.tp2Hit = true;
    }
  }

  // Check TP3 (full win)
  if ((isBuy && bar.high >= trade.tp3) || (!isBuy && bar.low <= trade.tp3)) {
    const exitPrice = isBuy ? trade.tp3 - slippage : trade.tp3 + slippage;
    // Weighted: 50% at TP1 (1.5R) + 30% at TP2 (2.5R) + 20% at TP3 (4R)
    const pnl = 0.5 * 1.5 + 0.3 * 2.5 + 0.2 * 4.0; // = 0.75 + 0.75 + 0.8 = 2.3R
    return { closed: true, outcome: 'WIN', exitPrice: r(exitPrice), pnl: r(pnl), mae: trade._mae, mfe: trade._mfe };
  }

  return { closed: false };
}

function computeStats(trades, equityCurve, symbol, finalEquity, maxEquity) {
  if (trades.length === 0) return { totalTrades: 0, winRate: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0, avgRR: 0, totalR: 0, equityCurve, trades };

  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, totalR = 0;
  const rValues = [];
  let consecW = 0, consecL = 0, maxCW = 0, maxCL = 0;
  let eq = 0, maxEq = 0, maxDD = 0;

  for (const t of trades) {
    const pnl = t.pnl || 0;
    rValues.push(pnl);
    totalR += pnl;
    eq += pnl;
    if (eq > maxEq) maxEq = eq;
    const dd = maxEq > 0 ? (maxEq - eq) / maxEq : 0;
    if (dd > maxDD) maxDD = dd;

    if (pnl > 0) { wins++; grossProfit += pnl; consecW++; consecL = 0; if (consecW > maxCW) maxCW = consecW; }
    else { losses++; grossLoss += Math.abs(pnl); consecL++; consecW = 0; if (consecL > maxCL) maxCL = consecL; }
  }

  const total = wins + losses;
  const wr = total > 0 ? wins / total : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const avgR = total > 0 ? totalR / total : 0;
  const avgWinR = wins > 0 ? grossProfit / wins : 0;
  const avgLossR = losses > 0 ? grossLoss / losses : 0;

  let sharpe = 0;
  if (rValues.length > 1) {
    const mean = totalR / rValues.length;
    const variance = rValues.reduce((s, v) => s + (v - mean) ** 2, 0) / (rValues.length - 1);
    sharpe = Math.sqrt(variance) > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;
  }

  // Validation
  const isValid = wr >= config.backtest.minWinRate && pf >= config.backtest.minProfitFactor && maxDD <= config.backtest.maxDrawdown && sharpe >= config.backtest.minSharpe && total >= config.backtest.minTradesForValidation;
  const failures = [];
  if (wr < config.backtest.minWinRate) failures.push(`Win rate ${(wr * 100).toFixed(1)}% < ${config.backtest.minWinRate * 100}%`);
  if (pf < config.backtest.minProfitFactor) failures.push(`PF ${pf.toFixed(2)} < ${config.backtest.minProfitFactor}`);
  if (maxDD > config.backtest.maxDrawdown) failures.push(`DD ${(maxDD * 100).toFixed(1)}% > ${config.backtest.maxDrawdown * 100}%`);
  if (sharpe < config.backtest.minSharpe) failures.push(`Sharpe ${sharpe.toFixed(2)} < ${config.backtest.minSharpe}`);
  if (total < config.backtest.minTradesForValidation) failures.push(`Trades ${total} < ${config.backtest.minTradesForValidation}`);
  // Sortino ratio (downside deviation only)
  let sortino = 0;
  if (rValues.length > 1) {
    const mean = totalR / rValues.length;
    const downside = rValues.filter(v => v < 0);
    if (downside.length > 0) {
      const downsideVar = downside.reduce((s, v) => s + v ** 2, 0) / downside.length;
      sortino = Math.sqrt(downsideVar) > 0 ? (mean / Math.sqrt(downsideVar)) * Math.sqrt(252) : 0;
    } else if (mean > 0) sortino = 99;
  }

  // Monthly returns (from trade timestamps)
  const monthlyReturns = {};
  for (const t of trades) {
    if (!t.entryTime) continue;
    const d = new Date(t.entryTime * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyReturns[key]) monthlyReturns[key] = 0;
    monthlyReturns[key] += t.pnl || 0;
  }
  // Round monthly values
  for (const k of Object.keys(monthlyReturns)) monthlyReturns[k] = Math.round(monthlyReturns[k] * 100) / 100;

  return {
    totalTrades: total, wins, losses,
    winRate: Math.round(wr * 1000) / 10,
    profitFactor: pf === Infinity ? '∞' : Math.round(pf * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    sortino: Math.round(sortino * 100) / 100,
    maxDrawdown: Math.round(maxDD * 1000) / 10,
    avgRR: Math.round(avgR * 100) / 100,
    avgWinR: Math.round(avgWinR * 100) / 100,
    avgLossR: Math.round(avgLossR * 100) / 100,
    totalR: Math.round(totalR * 100) / 100,
    maxConsecWins: maxCW, maxConsecLosses: maxCL,
    expectancy: Math.round((wr * avgWinR - (1 - wr) * avgLossR) * 100) / 100,
    monthlyReturns,
    isValid, failures,
    equityCurve, trades,
  };
}

function runMonteCarlo(trades, simulations = 1000, startingEquity = 1000) {
  if (trades.length < 5) return null;
  const pnls = trades.map(t => t.pnl || 0);
  const results = [];
  for (let s = 0; s < simulations; s++) {
    let eq = startingEquity, maxEq = startingEquity, maxDD = 0;
    const shuffled = [...pnls].sort(() => Math.random() - 0.5);
    for (const pnl of shuffled) {
      eq += pnl;
      if (eq > maxEq) maxEq = eq;
      const dd = maxEq > 0 ? (maxEq - eq) / maxEq : 0;
      if (dd > maxDD) maxDD = dd;
    }
    results.push({ equity: r(eq), maxDrawdown: r(maxDD * 100) });
  }
  results.sort((a, b) => a.equity - b.equity);
  const profitable = results.filter(r2 => r2.equity > startingEquity).length;
  return {
    simulations,
    percentile5: results[Math.floor(simulations * 0.05)],
    percentile25: results[Math.floor(simulations * 0.25)],
    median: results[Math.floor(simulations * 0.5)],
    percentile75: results[Math.floor(simulations * 0.75)],
    percentile95: results[Math.floor(simulations * 0.95)],
    profitableSims: Math.round(profitable / simulations * 1000) / 10,
    avgMaxDD: r(results.reduce((s, x) => s + x.maxDrawdown, 0) / simulations),
    riskOfRuin: Math.round(results.filter(x => x.equity < startingEquity * 0.5).length / simulations * 1000) / 10,
  };
}

function r(v) { return Math.round(v * 100) / 100; }

module.exports = { runBacktest, runMonteCarlo };
