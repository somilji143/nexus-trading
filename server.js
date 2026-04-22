/**
 * NEXUS — Main Server
 * Express app with all API routes, scheduler, and WebSocket.
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./src/core/config');
const logger = require('./src/core/logger');
const db = require('./src/db/database');
const { runSignalCheck, updateSignalOutcomes } = require('./src/signal_engine/generator');
const { fetchOHLCV, getLatestPrice } = require('./src/data_engine/fetcher');
const { generateDemoData } = require('./src/data_engine/demo-data');
const { runBacktest, runMonteCarlo } = require('./src/backtester/engine');
const { calculateFullConfluence } = require('./src/analysis_engine/confluence');
const paperTrader = require('./src/paper_trading/engine');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ──────────────────────────────────────
let backtestResults = {};
let backtestStatus = 'pending';

// ─── API: Health ────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), dbConnected: !!db.getDb(), backtestStatus, timestamp: new Date().toISOString() });
});

// ─── API: Assets ────────────────────────────────
app.get('/api/assets', (req, res) => {
  res.json(db.getAllAssets());
});

app.get('/api/assets/:symbol/price', async (req, res) => {
  try {
    const { price, change24h } = await getLatestPrice(req.params.symbol.toUpperCase());
    res.json({ symbol: req.params.symbol.toUpperCase(), price, change24h });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/:symbol/confluence', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const { fetchAllTimeframes } = require('./src/data_engine/fetcher');
    const allTF = await fetchAllTimeframes(symbol);
    const { price } = await getLatestPrice(symbol);
    const result = calculateFullConfluence(symbol, allTF, price, new Date());
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Signals ───────────────────────────────
app.get('/api/signals/live', (req, res) => {
  const signals = db.getOpenSignals(req.query.symbol);
  res.json(signals);
});

app.get('/api/signals/history', (req, res) => {
  const { symbol, tier, limit, offset } = req.query;
  const signals = db.getClosedSignals({ symbol, tier, limit: parseInt(limit) || 100, offset: parseInt(offset) || 0 });
  res.json(signals);
});

app.get('/api/signals/:id', (req, res) => {
  const signal = db.getSignalById(parseInt(req.params.id));
  if (!signal) return res.status(404).json({ error: 'Signal not found' });
  const events = db.getSignalEvents(signal.id);
  res.json({ ...signal, events, confluence_breakdown: JSON.parse(signal.confluence_breakdown || '{}') });
});

app.post('/api/signals/generate/:symbol', async (req, res) => {
  try {
    const result = await runSignalCheck(req.params.symbol.toUpperCase());
    // Auto-open paper trade if signal generated
    if (result.status === 'signal' && result.signal) {
      const signal = db.getSignalById(result.signal.id);
      if (signal) paperTrader.openTradeFromSignal(signal);
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Performance ───────────────────────────
app.get('/api/performance', (req, res) => {
  const { symbol, tier, days } = req.query;
  const stats = db.getPerformanceStats({ symbol, tier, days: days ? parseInt(days) : undefined });
  res.json(stats);
});

app.get('/api/performance/:symbol', (req, res) => {
  const stats = db.getPerformanceStats({ symbol: req.params.symbol.toUpperCase() });
  res.json(stats);
});

// ─── API: Backtest ──────────────────────────────
app.get('/api/backtest', (req, res) => {
  res.json({ status: backtestStatus, results: backtestResults });
});

// ─── API: Chart Data ────────────────────────────
app.get('/api/ohlcv/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const tf = req.query.tf || '1h';
    const count = parseInt(req.query.count) || 300;
    const candles = await fetchOHLCV(symbol, tf, count);
    res.json(candles);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Config ────────────────────────────────
app.get('/api/config', (req, res) => {
  const { getCurrentSession } = require('./src/analysis_engine/session');
  res.json({ hasApiKey: !!config.twelveDataApiKey, session: getCurrentSession(new Date()), assets: Object.keys(config.assets) });
});

app.post('/api/config', (req, res) => {
  if (req.body.apiKey) config.twelveDataApiKey = req.body.apiKey;
  res.json({ success: true });
});

// ─── API: Paper Trading ─────────────────────────
app.get('/api/paper-trading', (req, res) => {
  res.json(paperTrader.getState());
});

app.post('/api/paper-trading/toggle', (req, res) => {
  const enabled = req.body.enabled !== false;
  paperTrader.toggleEnabled(enabled);
  res.json({ success: true, enabled });
});

app.post('/api/paper-trading/close-all', (req, res) => {
  paperTrader.closeAllTrades();
  res.json({ success: true, state: paperTrader.getState() });
});

app.post('/api/paper-trading/reset', (req, res) => {
  paperTrader.resetPaperTrading();
  res.json({ success: true, state: paperTrader.getState() });
});

// ─── Serve Frontend ─────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Startup ────────────────────────────────────
app.listen(config.port, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗       ║
  ║   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝       ║
  ║   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗       ║
  ║   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║       ║
  ║   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║       ║
  ║   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝       ║
  ║   Institutional Signal Platform v2.0                 ║
  ║   Dashboard: http://localhost:${config.port}                   ║
  ╚══════════════════════════════════════════════════════╝`);

  // Initialize DB
  db.runMigrations();

  // Run backtests
  runStartupBacktests();

  // Start scheduler
  startScheduler();
});

async function runStartupBacktests() {
  backtestStatus = 'running';
  logger.info('Boot', 'Running startup backtests...');
  const symbols = Object.keys(config.assets);
  const configs = [
    { tf: '1h', count: 8760, label: '1 Year H1' },
    { tf: '4h', count: 2190, label: '1 Year H4' },
    { tf: '1d', count: 730, label: '2 Year Daily' },
  ];

  for (const symbol of symbols) {
    backtestResults[symbol] = {};
    for (const cfg of configs) {
      try {
        logger.info('Boot', `Backtesting ${symbol} ${cfg.label}...`);
        const candles = generateDemoData(symbol, cfg.tf, cfg.count);
        const result = runBacktest({ candles, symbol });
        let mc = null;
        if (result.trades && result.trades.length > 5) mc = runMonteCarlo(result.trades);
        const tradeCount = result.totalTrades || 0;
        // Thin equity curve
        if (result.equityCurve && result.equityCurve.length > 200) {
          const step = Math.floor(result.equityCurve.length / 200);
          result.equityCurve = result.equityCurve.filter((_, i) => i % step === 0);
        }
        delete result.trades;
        backtestResults[symbol][cfg.tf] = { ...result, monteCarlo: mc };
        const status = result.isValid ? '✅ VALID' : '⚠️ NOT VALIDATED';
        logger.info('Boot', `  ${symbol} ${cfg.tf}: ${tradeCount} trades | WR: ${result.winRate}% | PF: ${result.profitFactor} | ${status}`);
        if (!result.isValid && result.failures) logger.warn('Boot', `  Failures: ${result.failures.join(', ')}`);

        // Save validation report
        db.insertValidationReport({ symbol, timeframe: cfg.tf, totalTrades: tradeCount, winRate: result.winRate, profitFactor: typeof result.profitFactor === 'string' ? 999 : result.profitFactor, sharpeRatio: result.sharpe, maxDrawdown: result.maxDrawdown, avgRR: result.avgRR, isValid: result.isValid, failureReasons: result.failures?.join(', '), rawStats: result });
      } catch (err) {
        logger.error('Boot', `Backtest failed: ${symbol} ${cfg.tf}`, { error: err.message });
        backtestResults[symbol][cfg.tf] = { error: err.message };
      }
    }
  }
  backtestStatus = 'done';
  logger.info('Boot', 'All backtests complete');
}

function startScheduler() {
  // Signal check every 5 minutes — auto-open paper trades
  setInterval(async () => {
    for (const symbol of Object.keys(config.assets)) {
      try {
        const result = await runSignalCheck(symbol);
        if (result && result.status === 'signal' && result.signal) {
          const signal = db.getSignalById(result.signal.id);
          if (signal) paperTrader.openTradeFromSignal(signal);
        }
      } catch (e) { logger.error('Scheduler', `Signal check failed: ${symbol}`, { error: e.message }); }
    }
  }, config.scheduler.signalCheckIntervalMs);

  // Tracker every 5 minutes
  setInterval(async () => {
    try { await updateSignalOutcomes(); } catch (e) { logger.error('Scheduler', 'Tracker failed', { error: e.message }); }
  }, config.scheduler.trackerIntervalMs);

  // Paper trading tick every 30 seconds
  setInterval(async () => {
    try { await paperTrader.tick(); } catch (e) { logger.error('Scheduler', 'Paper trade tick failed', { error: e.message }); }
  }, 30 * 1000);

  // Price update every minute
  setInterval(async () => {
    for (const symbol of Object.keys(config.assets)) {
      try {
        const { price, change24h } = await getLatestPrice(symbol);
        if (price) db.updateAssetPrice(symbol, price, change24h);
      } catch (e) { /* silent */ }
    }
  }, config.scheduler.priceUpdateIntervalMs);

  logger.info('Scheduler', 'Started: signals 5m, tracker 5m, paper-tick 30s, prices 1m');
}
