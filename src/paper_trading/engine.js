/**
 * NEXUS — Auto Paper Trading Engine
 * Automatically opens trades from generated signals.
 * Tracks P&L, equity, partial exits, trailing stops in real-time.
 * Simulates realistic execution (spread, slippage).
 */
const config = require('../core/config');
const logger = require('../core/logger');
const { getLatestPrice } = require('../data_engine/fetcher');
const { fetchOHLCV } = require('../data_engine/fetcher');
const { calcATR } = require('../analysis_engine/indicators');
const MOD = 'PaperTrader';

// ─── State ──────────────────────────────────────
const state = {
  enabled: true,
  startingEquity: 10000,
  equity: 10000,
  peakEquity: 10000,
  maxDrawdown: 0,
  totalPnL: 0,
  activeTrades: [],      // Currently open
  closedTrades: [],      // History
  tradeIdCounter: 1,
  totalWins: 0,
  totalLosses: 0,
  totalBreakeven: 0,
  totalR: 0,
  consecutiveWins: 0,
  consecutiveLosses: 0,
  maxConsecWins: 0,
  maxConsecLosses: 0,
  lastTickTime: null,
  tickCount: 0,
  startedAt: new Date().toISOString(),
};

// ─── Open Trade from Signal ─────────────────────
function openTradeFromSignal(signal) {
  if (!state.enabled) return null;

  // Check max active trades
  if (state.activeTrades.length >= 3) {
    logger.info(MOD, `Max active trades reached (${state.activeTrades.length}), skipping`);
    return null;
  }

  // Check duplicate symbol
  const existingForSymbol = state.activeTrades.filter(t => t.symbol === signal.asset_symbol);
  if (existingForSymbol.length >= 1) {
    logger.info(MOD, `Already have trade for ${signal.asset_symbol}, skipping`);
    return null;
  }

  const assetCfg = config.assets[signal.asset_symbol] || {};
  const spread = assetCfg.spread || 0.5;
  const isBuy = signal.direction === 'LONG';

  // Simulate entry with spread
  const entryPrice = signal.entry_price + (isBuy ? spread / 2 : -spread / 2);

  // Position sizing: risk 1% of current equity
  const riskAmount = state.equity * config.risk.riskPerTrade;
  const slDistance = Math.abs(entryPrice - signal.sl_price);
  const positionSize = slDistance > 0 ? riskAmount / slDistance : 0;

  const trade = {
    id: state.tradeIdCounter++,
    signalId: signal.id,
    symbol: signal.asset_symbol,
    direction: signal.direction,
    tier: signal.tier,
    confluenceScore: signal.confluence_score,

    // Prices
    entryPrice: round(entryPrice),
    slPrice: round(signal.sl_price),
    tp1Price: round(signal.tp1_price),
    tp2Price: round(signal.tp2_price),
    tp3Price: round(signal.tp3_price),
    currentSL: round(signal.sl_price),
    trailingSL: null,

    // Position
    positionSize: round(positionSize),
    riskAmount: round(riskAmount),
    slDistance: round(slDistance),

    // Status
    status: 'OPEN',        // OPEN, TP1_HIT, TP2_HIT, CLOSED
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,

    // Partial exit tracking (50% at TP1, 30% at TP2, 20% at TP3)
    remainingSize: 1.0,    // 100% at start
    realizedPnL: 0,        // From partial exits

    // Tracking
    currentPrice: entryPrice,
    unrealizedPnL: 0,
    unrealizedR: 0,
    maxFavorableExcursion: 0,
    maxAdverseExcursion: 0,
    barsHeld: 0,

    // Timestamps
    openedAt: new Date().toISOString(),
    closedAt: null,
    lastUpdateAt: new Date().toISOString(),

    // Result (filled on close)
    closeReason: null,
    totalPnL: 0,
    totalR: 0,
    exitPrice: null,
  };

  state.activeTrades.push(trade);

  logger.info(MOD, `📈 PAPER TRADE OPENED: ${trade.direction} ${trade.symbol} #${trade.id}`, {
    entry: trade.entryPrice, sl: trade.slPrice, tp1: trade.tp1Price, tp2: trade.tp2Price,
    size: trade.positionSize, risk: trade.riskAmount,
  });

  return trade;
}

// ─── Tick — Process all active trades ───────────
async function tick() {
  if (!state.enabled || state.activeTrades.length === 0) return;

  state.tickCount++;
  state.lastTickTime = new Date().toISOString();

  for (let i = state.activeTrades.length - 1; i >= 0; i--) {
    const trade = state.activeTrades[i];
    try {
      const { price } = await getLatestPrice(trade.symbol);
      if (!price || price <= 0) continue;

      trade.currentPrice = price;
      trade.barsHeld++;
      trade.lastUpdateAt = new Date().toISOString();

      const isBuy = trade.direction === 'LONG';
      const priceDiff = isBuy ? price - trade.entryPrice : trade.entryPrice - price;

      // Update MFE/MAE
      if (priceDiff > trade.maxFavorableExcursion) trade.maxFavorableExcursion = round(priceDiff);
      if (priceDiff < trade.maxAdverseExcursion) trade.maxAdverseExcursion = round(priceDiff);

      // Update unrealized P&L
      trade.unrealizedPnL = round(priceDiff * trade.positionSize * trade.remainingSize);
      trade.unrealizedR = trade.slDistance > 0 ? round(priceDiff / trade.slDistance) : 0;

      // ─── Check Stop Loss ──────────────────────
      const sl = trade.trailingSL || trade.currentSL;
      if ((isBuy && price <= sl) || (!isBuy && price >= sl)) {
        // Slippage on SL
        const slippage = trade.slDistance * 0.01;
        const exitPrice = isBuy ? sl - slippage : sl + slippage;
        const slPnLPerUnit = isBuy ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
        const slPnL = slPnLPerUnit * trade.positionSize * trade.remainingSize;

        trade.realizedPnL += slPnL;
        trade.totalPnL = round(trade.realizedPnL);
        trade.totalR = trade.slDistance > 0 ? round(trade.totalPnL / (trade.slDistance * trade.positionSize)) : 0;
        trade.exitPrice = round(exitPrice);

        if (trade.tp1Hit) {
          trade.closeReason = 'TRAILING_SL';
          closeTrade(trade, i, 'BE/PARTIAL');
        } else {
          trade.closeReason = 'SL_HIT';
          closeTrade(trade, i, 'LOSS');
        }
        continue;
      }

      // ─── Check TP1 ────────────────────────────
      if (!trade.tp1Hit) {
        if ((isBuy && price >= trade.tp1Price) || (!isBuy && price <= trade.tp1Price)) {
          trade.tp1Hit = true;
          trade.status = 'TP1_HIT';

          // Partial exit: close 50%
          const tp1PnLPerUnit = isBuy ? trade.tp1Price - trade.entryPrice : trade.entryPrice - trade.tp1Price;
          const tp1PnL = tp1PnLPerUnit * trade.positionSize * 0.5;
          trade.realizedPnL += tp1PnL;
          trade.remainingSize = 0.5;

          // Move SL to breakeven
          trade.currentSL = trade.entryPrice;
          trade.trailingSL = trade.entryPrice;

          logger.info(MOD, `🎯 TP1 HIT: ${trade.symbol} #${trade.id} — 50% closed @ ${trade.tp1Price}, SL → BE (${trade.entryPrice})`);
        }
      }

      // ─── Check TP2 ────────────────────────────
      if (trade.tp1Hit && !trade.tp2Hit) {
        if ((isBuy && price >= trade.tp2Price) || (!isBuy && price <= trade.tp2Price)) {
          trade.tp2Hit = true;
          trade.status = 'TP2_HIT';

          // Partial exit: close 30% (of original)
          const tp2PnLPerUnit = isBuy ? trade.tp2Price - trade.entryPrice : trade.entryPrice - trade.tp2Price;
          const tp2PnL = tp2PnLPerUnit * trade.positionSize * 0.3;
          trade.realizedPnL += tp2PnL;
          trade.remainingSize = 0.2;

          // ATR trailing stop
          try {
            const candles = await fetchOHLCV(trade.symbol, '1h', 50);
            if (candles && candles.length > 14) {
              const atr = calcATR(candles, 14);
              const currentATR = atr[atr.length - 1] || trade.slDistance;
              trade.trailingSL = isBuy ? price - currentATR * 2 : price + currentATR * 2;
            }
          } catch (e) {
            trade.trailingSL = isBuy ? price - trade.slDistance : price + trade.slDistance;
          }

          logger.info(MOD, `🎯🎯 TP2 HIT: ${trade.symbol} #${trade.id} — 30% closed @ ${trade.tp2Price}, trailing SL active`);
        }
      }

      // ─── Check TP3 (Full Win) ─────────────────
      if (trade.tp2Hit) {
        if ((isBuy && price >= trade.tp3Price) || (!isBuy && price <= trade.tp3Price)) {
          trade.tp3Hit = true;
          const tp3PnLPerUnit = isBuy ? trade.tp3Price - trade.entryPrice : trade.entryPrice - trade.tp3Price;
          const tp3PnL = tp3PnLPerUnit * trade.positionSize * trade.remainingSize;
          trade.realizedPnL += tp3PnL;
          trade.remainingSize = 0;
          trade.totalPnL = round(trade.realizedPnL);
          trade.totalR = trade.slDistance > 0 ? round(trade.totalPnL / (trade.slDistance * trade.positionSize)) : 0;
          trade.exitPrice = round(trade.tp3Price);
          trade.closeReason = 'TP3_HIT';

          closeTrade(trade, i, 'WIN');
          continue;
        }

        // Update trailing SL for remaining position after TP2
        if (trade.trailingSL) {
          if (isBuy) {
            const newTrail = price - trade.slDistance * 1.5;
            if (newTrail > trade.trailingSL) trade.trailingSL = round(newTrail);
          } else {
            const newTrail = price + trade.slDistance * 1.5;
            if (newTrail < trade.trailingSL) trade.trailingSL = round(newTrail);
          }
        }
      }

      // ─── Check Expiry (24 hours) ──────────────
      const ageMs = Date.now() - new Date(trade.openedAt).getTime();
      if (ageMs > 24 * 60 * 60 * 1000 && !trade.tp1Hit) {
        // Close at market if no TP hit within 24h
        const exitPnLPerUnit = isBuy ? price - trade.entryPrice : trade.entryPrice - price;
        const exitPnL = exitPnLPerUnit * trade.positionSize * trade.remainingSize;
        trade.realizedPnL += exitPnL;
        trade.totalPnL = round(trade.realizedPnL);
        trade.totalR = trade.slDistance > 0 ? round(trade.totalPnL / (trade.slDistance * trade.positionSize)) : 0;
        trade.exitPrice = round(price);
        trade.closeReason = 'EXPIRED';
        closeTrade(trade, i, trade.totalPnL >= 0 ? 'BE' : 'LOSS');
        continue;
      }

    } catch (err) {
      logger.error(MOD, `Tick error for trade #${trade.id}`, { error: err.message });
    }
  }

  // Update equity
  const unrealizedTotal = state.activeTrades.reduce((s, t) => s + t.unrealizedPnL, 0);
  const currentEquity = state.startingEquity + state.totalPnL + unrealizedTotal;
  state.equity = round(currentEquity);
  if (state.equity > state.peakEquity) state.peakEquity = state.equity;
  const dd = state.peakEquity > 0 ? (state.peakEquity - state.equity) / state.peakEquity : 0;
  if (dd > state.maxDrawdown) state.maxDrawdown = round(dd * 100);
}

// ─── Close Trade ────────────────────────────────
function closeTrade(trade, index, outcome) {
  trade.status = 'CLOSED';
  trade.closedAt = new Date().toISOString();

  // Update stats
  state.totalPnL = round(state.totalPnL + trade.totalPnL);
  state.totalR = round(state.totalR + trade.totalR);
  state.equity = round(state.startingEquity + state.totalPnL);

  if (outcome === 'WIN' || (outcome === 'BE/PARTIAL' && trade.totalPnL > 0)) {
    state.totalWins++;
    state.consecutiveWins++;
    state.consecutiveLosses = 0;
    if (state.consecutiveWins > state.maxConsecWins) state.maxConsecWins = state.consecutiveWins;
  } else if (outcome === 'LOSS') {
    state.totalLosses++;
    state.consecutiveLosses++;
    state.consecutiveWins = 0;
    if (state.consecutiveLosses > state.maxConsecLosses) state.maxConsecLosses = state.consecutiveLosses;
  } else {
    state.totalBreakeven++;
  }

  // Move to closed
  state.activeTrades.splice(index, 1);
  state.closedTrades.unshift(trade); // Most recent first
  if (state.closedTrades.length > 500) state.closedTrades.pop(); // Cap history

  const icon = outcome === 'WIN' ? '✅' : outcome === 'LOSS' ? '❌' : '🟡';
  logger.info(MOD, `${icon} TRADE CLOSED: ${trade.symbol} #${trade.id} — ${outcome} | P&L: $${trade.totalPnL} (${trade.totalR}R) | Reason: ${trade.closeReason}`);
  logger.info(MOD, `💰 Equity: $${state.equity} | W/L: ${state.totalWins}/${state.totalLosses} | Total R: ${state.totalR}`);
}

// ─── Get Full State (for API) ───────────────────
function getState() {
  const totalTrades = state.totalWins + state.totalLosses + state.totalBreakeven;
  const winRate = totalTrades > 0 ? round((state.totalWins / totalTrades) * 100) : 0;
  const avgR = totalTrades > 0 ? round(state.totalR / totalTrades) : 0;

  return {
    enabled: state.enabled,
    equity: state.equity,
    startingEquity: state.startingEquity,
    pnl: state.totalPnL,
    pnlPercent: round((state.totalPnL / state.startingEquity) * 100),
    totalR: state.totalR,
    peakEquity: state.peakEquity,
    maxDrawdown: state.maxDrawdown,

    totalTrades,
    wins: state.totalWins,
    losses: state.totalLosses,
    breakeven: state.totalBreakeven,
    winRate,
    avgR,

    maxConsecWins: state.maxConsecWins,
    maxConsecLosses: state.maxConsecLosses,

    activeTrades: state.activeTrades.map(formatTrade),
    activeCount: state.activeTrades.length,
    recentClosed: state.closedTrades.slice(0, 20).map(formatTrade),

    tickCount: state.tickCount,
    lastTick: state.lastTickTime,
    startedAt: state.startedAt,
    uptime: Math.round((Date.now() - new Date(state.startedAt).getTime()) / 60000),
  };
}

function formatTrade(t) {
  return {
    id: t.id,
    symbol: t.symbol,
    direction: t.direction,
    tier: t.tier,
    entryPrice: t.entryPrice,
    currentPrice: t.currentPrice,
    slPrice: t.currentSL,
    trailingSL: t.trailingSL,
    tp1Price: t.tp1Price,
    tp2Price: t.tp2Price,
    tp3Price: t.tp3Price,
    status: t.status,
    tp1Hit: t.tp1Hit,
    tp2Hit: t.tp2Hit,
    tp3Hit: t.tp3Hit,
    remainingSize: round(t.remainingSize * 100),
    unrealizedPnL: t.unrealizedPnL,
    unrealizedR: t.unrealizedR,
    realizedPnL: round(t.realizedPnL),
    totalPnL: t.totalPnL,
    totalR: t.totalR,
    closeReason: t.closeReason,
    exitPrice: t.exitPrice,
    barsHeld: t.barsHeld,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    riskAmount: t.riskAmount,
    confluenceScore: t.confluenceScore,
  };
}

// ─── Manual Controls ────────────────────────────
function toggleEnabled(enabled) {
  state.enabled = enabled;
  logger.info(MOD, `Paper trading ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

function closeAllTrades() {
  logger.info(MOD, `Force closing all ${state.activeTrades.length} trades`);
  for (let i = state.activeTrades.length - 1; i >= 0; i--) {
    const trade = state.activeTrades[i];
    const isBuy = trade.direction === 'LONG';
    const pnl = (isBuy ? trade.currentPrice - trade.entryPrice : trade.entryPrice - trade.currentPrice) * trade.positionSize * trade.remainingSize;
    trade.realizedPnL += pnl;
    trade.totalPnL = round(trade.realizedPnL);
    trade.totalR = trade.slDistance > 0 ? round(trade.totalPnL / (trade.slDistance * trade.positionSize)) : 0;
    trade.exitPrice = trade.currentPrice;
    trade.closeReason = 'MANUAL_CLOSE';
    closeTrade(trade, i, trade.totalPnL >= 0 ? 'BE' : 'LOSS');
  }
}

function resetPaperTrading() {
  state.equity = state.startingEquity;
  state.peakEquity = state.startingEquity;
  state.maxDrawdown = 0;
  state.totalPnL = 0;
  state.activeTrades = [];
  state.closedTrades = [];
  state.totalWins = 0;
  state.totalLosses = 0;
  state.totalBreakeven = 0;
  state.totalR = 0;
  state.consecutiveWins = 0;
  state.consecutiveLosses = 0;
  state.maxConsecWins = 0;
  state.maxConsecLosses = 0;
  state.tickCount = 0;
  state.startedAt = new Date().toISOString();
  logger.info(MOD, '🔄 Paper trading RESET');
}

function round(v) { return Math.round(v * 100) / 100; }

module.exports = {
  openTradeFromSignal, tick, getState,
  toggleEnabled, closeAllTrades, resetPaperTrading,
};
