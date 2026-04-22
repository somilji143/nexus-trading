/**
 * NEXUS Platform — Database Layer (SQLite)
 * Production-structured models using better-sqlite3.
 * Mirrors PostgreSQL schema — drop-in replaceable.
 */
const Database = require('better-sqlite3');
const path = require('path');
const config = require('../core/config');
const logger = require('../core/logger');

let db = null;

function getDb() {
  if (db) return db;

  const dbDir = path.dirname(config.dbPath);
  const fs = require('fs');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  logger.info('DB', `Connected to ${config.dbPath}`);
  return db;
}

function runMigrations() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      current_price REAL DEFAULT 0,
      price_change_24h REAL DEFAULT 0,
      last_updated TEXT
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_symbol TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('LONG','SHORT')),
      tier TEXT NOT NULL CHECK(tier IN ('A+','A','B')),
      confluence_score REAL NOT NULL,
      entry_price REAL NOT NULL,
      sl_price REAL NOT NULL,
      tp1_price REAL NOT NULL,
      tp2_price REAL NOT NULL,
      tp3_price REAL NOT NULL,
      sl_distance REAL NOT NULL,
      atr_at_signal REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','TP1_HIT','TP2_HIT','WIN','LOSS','EXPIRED','CANCELLED')),
      outcome_r REAL DEFAULT NULL,
      pnl_usd REAL DEFAULT NULL,
      confluence_breakdown TEXT,  -- JSON
      regime TEXT,
      regime_confidence REAL,
      session_name TEXT,
      reasoning TEXT,
      expiry_time TEXT,
      trailing_sl REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (asset_symbol) REFERENCES assets(symbol)
    );

    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      price REAL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (signal_id) REFERENCES signals(id)
    );

    CREATE TABLE IF NOT EXISTS validation_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      total_trades INTEGER,
      win_rate REAL,
      profit_factor REAL,
      sharpe_ratio REAL,
      max_drawdown REAL,
      avg_rr REAL,
      is_valid INTEGER DEFAULT 0,
      failure_reasons TEXT,
      raw_stats TEXT,  -- JSON
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS system_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      symbol TEXT,
      result TEXT,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
    CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(asset_symbol);
    CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
    CREATE INDEX IF NOT EXISTS idx_signal_events_signal ON signal_events(signal_id);
  `);

  // Seed assets
  const upsert = d.prepare(`INSERT OR REPLACE INTO assets (symbol, name, type) VALUES (?, ?, ?)`);
  for (const [symbol, info] of Object.entries(config.assets)) {
    upsert.run(symbol, info.name, info.type);
  }

  logger.info('DB', 'Migrations complete');
}

// ─── Query Helpers ────────────────────────────────

function insertSignal(signal) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO signals (asset_symbol, direction, tier, confluence_score, entry_price,
      sl_price, tp1_price, tp2_price, tp3_price, sl_distance, atr_at_signal,
      confluence_breakdown, regime, regime_confidence, session_name, reasoning, expiry_time)
    VALUES (@asset_symbol, @direction, @tier, @confluence_score, @entry_price,
      @sl_price, @tp1_price, @tp2_price, @tp3_price, @sl_distance, @atr_at_signal,
      @confluence_breakdown, @regime, @regime_confidence, @session_name, @reasoning, @expiry_time)
  `);
  const result = stmt.run({
    ...signal,
    confluence_breakdown: JSON.stringify(signal.confluence_breakdown || {}),
  });
  return result.lastInsertRowid;
}

function updateSignal(id, updates) {
  const d = getDb();
  const sets = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  const stmt = d.prepare(`UPDATE signals SET ${sets}, updated_at = datetime('now') WHERE id = @id`);
  stmt.run({ id, ...updates });
}

function getOpenSignals(symbol) {
  const d = getDb();
  const where = symbol ? `AND asset_symbol = ?` : '';
  return d.prepare(`SELECT * FROM signals WHERE status IN ('OPEN','TP1_HIT','TP2_HIT') ${where} ORDER BY created_at DESC`).all(...(symbol ? [symbol] : []));
}

function getClosedSignals({ symbol, tier, limit = 100, offset = 0 } = {}) {
  const d = getDb();
  let where = `WHERE status IN ('WIN','LOSS','EXPIRED')`;
  const params = [];
  if (symbol) { where += ` AND asset_symbol = ?`; params.push(symbol); }
  if (tier) { where += ` AND tier = ?`; params.push(tier); }
  params.push(limit, offset);
  return d.prepare(`SELECT * FROM signals ${where} ORDER BY closed_at DESC LIMIT ? OFFSET ?`).all(...params);
}

function getSignalById(id) {
  return getDb().prepare(`SELECT * FROM signals WHERE id = ?`).get(id);
}

function countRecentSignals(symbol, direction, hoursBack) {
  const d = getDb();
  return d.prepare(`
    SELECT COUNT(*) as cnt FROM signals
    WHERE asset_symbol = ? AND direction = ? AND created_at > datetime('now', ?)
  `).get(symbol, direction, `-${hoursBack} hours`).cnt;
}

function insertSignalEvent(signalId, eventType, price, details) {
  getDb().prepare(`INSERT INTO signal_events (signal_id, event_type, price, details) VALUES (?, ?, ?, ?)`).run(signalId, eventType, price, details);
}

function getSignalEvents(signalId) {
  return getDb().prepare(`SELECT * FROM signal_events WHERE signal_id = ? ORDER BY created_at`).all(signalId);
}

function insertValidationReport(report) {
  const d = getDb();
  d.prepare(`
    INSERT INTO validation_reports (symbol, timeframe, total_trades, win_rate, profit_factor,
      sharpe_ratio, max_drawdown, avg_rr, is_valid, failure_reasons, raw_stats)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(report.symbol, report.timeframe, report.totalTrades, report.winRate, report.profitFactor,
    report.sharpeRatio, report.maxDrawdown, report.avgRR, report.isValid ? 1 : 0,
    report.failureReasons || null, JSON.stringify(report.rawStats || {}));
}

function insertSystemRun(run) {
  getDb().prepare(`INSERT INTO system_runs (run_type, symbol, result, duration_ms, error) VALUES (?, ?, ?, ?, ?)`).run(run.runType, run.symbol || null, run.result || null, run.durationMs || null, run.error || null);
}

function updateAssetPrice(symbol, price, change24h) {
  getDb().prepare(`UPDATE assets SET current_price = ?, price_change_24h = ?, last_updated = datetime('now') WHERE symbol = ?`).run(price, change24h || 0, symbol);
}

function getAllAssets() {
  return getDb().prepare(`SELECT * FROM assets`).all();
}

function getPerformanceStats({ symbol, tier, days } = {}) {
  const d = getDb();
  let where = `WHERE status IN ('WIN','LOSS')`;
  const params = [];
  if (symbol) { where += ` AND asset_symbol = ?`; params.push(symbol); }
  if (tier) { where += ` AND tier = ?`; params.push(tier); }
  if (days) { where += ` AND closed_at > datetime('now', ?)`; params.push(`-${days} days`); }

  const rows = d.prepare(`SELECT * FROM signals ${where} ORDER BY closed_at`).all(...params);
  if (rows.length === 0) return { totalSignals: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0, avgRR: 0, avgWinR: 0, avgLossR: 0, maxConsecWins: 0, maxConsecLosses: 0 };

  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0;
  let sumR = 0, sumWinR = 0, sumLossR = 0;
  let consecW = 0, consecL = 0, maxCW = 0, maxCL = 0;
  let equity = 0, maxEq = 0, maxDD = 0;
  const rValues = [];

  for (const s of rows) {
    const r = s.outcome_r || 0;
    rValues.push(r);
    sumR += r;
    equity += r;
    if (equity > maxEq) maxEq = equity;
    const dd = maxEq > 0 ? (maxEq - equity) / maxEq : 0;
    if (dd > maxDD) maxDD = dd;

    if (r > 0) {
      wins++; grossProfit += r; sumWinR += r;
      consecW++; consecL = 0;
      if (consecW > maxCW) maxCW = consecW;
    } else {
      losses++; grossLoss += Math.abs(r); sumLossR += Math.abs(r);
      consecL++; consecW = 0;
      if (consecL > maxCL) maxCL = consecL;
    }
  }

  const total = wins + losses;
  const avgR = total > 0 ? sumR / total : 0;
  const avgWinR = wins > 0 ? sumWinR / wins : 0;
  const avgLossR = losses > 0 ? sumLossR / losses : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const wr = total > 0 ? wins / total : 0;

  // Sharpe (annualized, daily proxy)
  let sharpe = 0;
  if (rValues.length > 1) {
    const mean = sumR / rValues.length;
    const variance = rValues.reduce((s, v) => s + (v - mean) ** 2, 0) / (rValues.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  }

  return {
    totalSignals: total, wins, losses,
    winRate: Math.round(wr * 1000) / 10,
    profitFactor: Math.round(pf * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    maxDrawdown: Math.round(maxDD * 1000) / 10,
    avgRR: Math.round(avgR * 100) / 100,
    avgWinR: Math.round(avgWinR * 100) / 100,
    avgLossR: Math.round(avgLossR * 100) / 100,
    maxConsecWins: maxCW,
    maxConsecLosses: maxCL,
    totalR: Math.round(sumR * 100) / 100,
  };
}

module.exports = {
  getDb, runMigrations,
  insertSignal, updateSignal, getOpenSignals, getClosedSignals, getSignalById,
  countRecentSignals, insertSignalEvent, getSignalEvents,
  insertValidationReport, insertSystemRun,
  updateAssetPrice, getAllAssets, getPerformanceStats,
};
