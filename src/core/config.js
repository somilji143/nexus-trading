/**
 * NEXUS Platform — Core Configuration
 * Environment-driven config with sane defaults for local development.
 */
const path = require('path');

const ENV = process.env.NODE_ENV || 'development';

const config = {
  env: ENV,
  port: parseInt(process.env.PORT || '3000', 10),

  // ─── Data Sources ──────────────────────────────
  twelveDataApiKey: process.env.TWELVE_DATA_API_KEY || '',
  binanceBaseUrl: 'https://api.binance.com',
  coingeckoBaseUrl: 'https://api.coingecko.com/api/v3',

  // ─── Assets ────────────────────────────────────
  assets: {
    XAUUSD: { name: 'Gold', type: 'commodity', pipValue: 0.10, spread: 0.30, roundStep: 50, base: 3300 },
    BTCUSDT: { name: 'Bitcoin', type: 'crypto', pipValue: 0.01, spread: 15.0, roundStep: 5000, base: 94000 },
    ETHUSDT: { name: 'Ethereum', type: 'crypto', pipValue: 0.01, spread: 1.50, roundStep: 100, base: 1800 },
  },

  // ─── Timeframes ────────────────────────────────
  timeframes: ['1w', '1d', '4h', '1h', '15m'],
  cacheTTL: { '1w': 3600, '1d': 900, '4h': 300, '1h': 120, '15m': 30 },

  // ─── Signal Thresholds (defaults, overridden by regime engine) ──
  defaultThresholds: {
    longMinScore: 0.72,
    shortMaxScore: 0.28,
    minRR: 1.5,
    maxSLATR: 3.0,
    minSLATR: 0.5,
    signalCooldownHours: 4,
    signalExpiryHours: 24,
    maxActiveSignals: 6,
    maxPerAsset: 2,
  },

  // ─── Risk ──────────────────────────────────────
  risk: {
    accountSize: 10000,
    riskPerTrade: 0.01, // 1%
    maxDrawdown: 0.20,
    tp1R: 1.5,
    tp2R: 2.5,
    tp3R: 4.0,
  },

  // ─── Confluence Weights ────────────────────────
  weights: {
    smc: 0.25,
    mtf: 0.20,
    volume: 0.15,
    momentum: 0.15,
    session: 0.10,
    keyLevel: 0.10,
    regime: 0.05,  // regime acts as modifier
  },

  // ─── Notifications ────────────────────────────
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // ─── Scheduler ─────────────────────────────────
  scheduler: {
    signalCheckIntervalMs: 5 * 60 * 1000,     // 5 minutes
    trackerIntervalMs: 5 * 60 * 1000,          // 5 minutes
    priceUpdateIntervalMs: 60 * 1000,          // 1 minute
    htfRefreshIntervalMs: 60 * 60 * 1000,      // 1 hour
  },

  // ─── Backtest ──────────────────────────────────
  backtest: {
    defaultCommission: 0.0002,
    defaultSlippage: 0.0001,
    minTradesForValidation: 50,
    minWinRate: 0.55,
    minProfitFactor: 1.4,
    maxDrawdown: 0.20,
    minSharpe: 1.0,
  },

  // ─── Paths ─────────────────────────────────────
  dbPath: path.join(__dirname, '..', '..', 'data', 'nexus.db'),
  logPath: path.join(__dirname, '..', '..', 'logs'),
};

module.exports = config;
