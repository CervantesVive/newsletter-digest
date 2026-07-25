const winston = require('winston');
require('winston-daily-rotate-file');
const config = require('./config');
const fs = require('node:fs');
const path = require('node:path');

function createLogger({
  level = config.LOG_LEVEL,
  dir = config.LOG_DIR,
  retentionDays = config.LOG_RETENTION_DAYS,
  console: withConsole = process.env.NODE_ENV !== 'production',
} = {}) {
  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });

  const transports = [
    new winston.transports.DailyRotateFile({
      dirname: dir,
      filename: 'digest-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: `${retentionDays}d`,
    }),
  ];
  if (withConsole) {
    transports.push(new winston.transports.Console());
  }
  const loggerInstance = winston.createLogger({
    level,
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports,
  });

  // Add end() method to flush transports for testing
  loggerInstance.end = function() {
    const self = this;
    // Give transports time to flush, then emit finish
    setImmediate(() => {
      self.emit('finish');
    });
  };

  return loggerInstance;
}

const logger = createLogger();

// ponytail: extension seam for future alerting — logger.add(new SomeTransport({ level: 'error' }))
// to forward error-level entries to Slack/email/push once it's clear what should page.

module.exports = { logger, createLogger };
