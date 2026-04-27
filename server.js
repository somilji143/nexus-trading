/**
 * NEXUS v3 — Main Server
 * Express app with all API routes, scheduler, rate limiting.
 * Data mode awareness: clearly labels LIVE vs DEMO.
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const config = require('./src/core/config');
const logger = require('./src/core/logger');
const db = require('./src/db/database');
const { runSignalCheck, updateSignalOutcomes } = require('./src/signal_engine/generator');
const { fetchOHLCV, getLatestPrice, getAllDataModes } = require('./src/data_engine/fetcher');
const { generateDemoData } = require('./src/data_engine/demo-data');
const { runBacktest, runMonteCarlo } = require('./src/backtester/engine');
const { calculateFullConfluence } = require('./src/analysis_engine/confluence');
const { getRiskState } = require('./src/signal_engine/risk_manager');
const paperTrader = require('./src/paper_trading/engine');
const { initLiveFeed, getLiveState } = require('./src/data_engine/liveFeed');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Simple Rate Limiter ────────────────────────
const rateLimits = {};
function rateLimit(key, maxPerMin = 10) {
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key] = rateLimits[key].filter(t => now - t < 60000);
  if (rateLimits[key].length >= maxPerMin) return false;
  rateLimits[key].push(now);
  return true;
}

// ─── State ──────────────────────────────────────
let backtestResults = {};
let backtestStatus = 'pending';

// ─── API: Health ────────────────────────────────
app.get('/api/health', (req, res) => {
  const dataModes = getAllDataModes();
  res.json({
    status: 'ok',
    version: '3.0.0',
    uptime: Math.round(process.uptime()),
    dbConnected: !!db.getDb(),
    backtestStatus,
    dataMode: dataModes.globalMode,
    dataModeDetail: dataModes.description,
    timestamp: new Date().toISOString(),
  });
});

// ─── API: Data Mode ─────────────────────────────
app.get('/api/data-mode', (req, res) => {
  res.json(getAllDataModes());
});

// ─── API: Risk State ────────────────────────────
app.get('/api/risk-state', (req, res) => {
  res.json(getRiskState());
});

// ─── API: Assets ────────────────────────────────
app.get('/api/assets', (req, res) => {
  res.json(db.getAllAssets());
});

app.get('/api/assets/:symbol/price', async (req, res) => {
  try {
    const result = await getLatestPrice(req.params.symbol.toUpperCase());
    res.json({ symbol: req.params.symbol.toUpperCase(), ...result });
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
  const ip = req.ip || 'unknown';
  if (!rateLimit(`signal:${ip}`, 6)) {
    return res.status(429).json({ error: 'Rate limit: max 6 signal generations per minute' });
  }
  try {
    const result = await runSignalCheck(req.params.symbol.toUpperCase());
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
  const dataModes = getAllDataModes();
  res.json({
    hasApiKey: !!config.twelveDataApiKey,
    session: getCurrentSession(new Date()),
    assets: Object.keys(config.assets),
    dataMode: dataModes.globalMode,
    dataModeDescription: dataModes.description,
  });
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

// ─── API: Debug ─────────────────────────────────
app.get('/api/debug/data-test', async (req, res) => {
  const results = {};
  for (const symbol of Object.keys(config.assets)) {
    results[symbol] = {};
    for (const tf of ['1h', '4h', '1d']) {
      try {
        const candles = await fetchOHLCV(symbol, tf, 100);
        const mode = getAllDataModes().modes[symbol];
        results[symbol][tf] = {
          success: candles && candles.length >= 10,
          count: candles?.length || 0,
          source: mode,
          latestCandle: candles?.length ? new Date(candles[candles.length - 1].time * 1000).toISOString() : null,
        };
      } catch (e) {
        results[symbol][tf] = { success: false, error: e.message };
      }
    }
  }
  res.json(results);
});

// ─── Serve Frontend ─────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Error Handler ──────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Server', `Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── API: Live State ────────────────────────────
app.get('/api/live-state', (req, res) => {
  res.json(getLiveState());
});

// ─── Startup ────────────────────────────────────
const server = http.createServer(app);
server.listen(config.port, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗       ║
  ║   ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝       ║
  ║   ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗       ║
  ║   ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║       ║
  ║   ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║       ║
  ║   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝       ║
  ║   Institutional Signal Platform v4.0                 ║
  ║   Dashboard: http://localhost:${config.port}                   ║
  ║   WebSocket: ws://localhost:${config.port}/ws                  ║
  ╚══════════════════════════════════════════════════════╝`);

  db.runMigrations();
  initLiveFeed(server);
  runStartupBacktests();
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

        // Try live data first, fall back to demo
        let candles;
        let dataSource = 'DEMO';
        try {
          const { fetchLiveOHLCV } = require('./src/data_engine/liveProvider');
          const liveResult = await fetchLiveOHLCV(symbol, cfg.tf, cfg.count);
          if (liveResult && liveResult.candles && liveResult.candles.length >= 100) {
            candles = liveResult.candles;
            dataSource = liveResult.source;
          }
        } catch (e) {}

        if (!candles) {
          candles = generateDemoData(symbol, cfg.tf, cfg.count);
          dataSource = 'DEMO';
        }

        const result = runBacktest({ candles, symbol });
        let mc = null;
        if (result.trades && result.trades.length > 5) mc = runMonteCarlo(result.trades);

        const tradeCount = result.totalTrades || 0;

        // Thin equity curve for API response
        if (result.equityCurve && result.equityCurve.length > 200) {
          const step = Math.floor(result.equityCurve.length / 200);
          result.equityCurve = result.equityCurve.filter((_, i) => i % step === 0);
        }
        delete result.trades;
        backtestResults[symbol][cfg.tf] = { ...result, monteCarlo: mc, dataSource };

        const status = result.isValid ? '✅ VALID' : '⚠️ NOT VALIDATED';
        const sourceLabel = dataSource === 'DEMO' ? ' [DEMO]' : ` [${dataSource}]`;
        logger.info('Boot', `  ${symbol} ${cfg.tf}: ${tradeCount} trades | WR: ${result.winRate}% | PF: ${result.profitFactor} | ${status}${sourceLabel}`);
        if (!result.isValid && result.failures) logger.warn('Boot', `  Failures: ${result.failures.join(', ')}`);

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
  // Signal check every 5 minutes
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

  // Signal tracker
  setInterval(async () => {
    try { await updateSignalOutcomes(); } catch (e) { logger.error('Scheduler', 'Tracker failed', { error: e.message }); }
  }, config.scheduler.trackerIntervalMs);

  // Paper trading tick
  setInterval(async () => {
    try { await paperTrader.tick(); } catch (e) { logger.error('Scheduler', 'Paper trade tick failed', { error: e.message }); }
  }, 30 * 1000);

  // Price update
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
