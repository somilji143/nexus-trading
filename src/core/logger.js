/**
 * NEXUS Platform — Structured Logger
 * Rotating file logs + console. Every event is structured JSON.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Ensure log directory exists
const logDir = config.logPath;
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const LOG_FILE = path.join(logDir, 'nexus.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

function rotateIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + '.' + Date.now();
        fs.renameSync(LOG_FILE, rotated);
      }
    }
  } catch (e) { /* ignore rotation errors */ }
}

function formatEntry(level, module, message, data) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    module,
    msg: message,
    ...(data ? { data } : {}),
  });
}

function writeLog(level, module, message, data) {
  const entry = formatEntry(level, module, message, data);
  const consoleColor = { ERROR: '\x1b[31m', WARN: '\x1b[33m', INFO: '\x1b[36m', DEBUG: '\x1b[90m' };
  const reset = '\x1b[0m';
  const color = consoleColor[level] || '';

  if (level !== 'DEBUG' || config.env === 'development') {
    console.log(`${color}[${level}]${reset} [${module}] ${message}${data ? ' ' + JSON.stringify(data) : ''}`);
  }

  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, entry + '\n');
  } catch (e) { /* ignore file write errors */ }
}

const logger = {
  info: (module, msg, data) => writeLog('INFO', module, msg, data),
  warn: (module, msg, data) => writeLog('WARN', module, msg, data),
  error: (module, msg, data) => writeLog('ERROR', module, msg, data),
  debug: (module, msg, data) => writeLog('DEBUG', module, msg, data),
};

module.exports = logger;
