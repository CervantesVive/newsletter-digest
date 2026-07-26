const path = require('node:path');
const express = require('express');
const OpenAI = require('openai');
const { openDb } = require('./db');
const { ingestEmails } = require('./ingest');
const { startEnrichmentLoop } = require('./enrich');
const { createReadRoutes } = require('./api');
const { logger } = require('./logger');
const {
  DB_PATH,
  PORT,
  LLM_BASE_URL,
  LLM_API_KEY,
  LLM_MODEL,
  ENRICHMENT_INTERVAL_MS,
  ENRICHMENT_CONCURRENCY,
  ENRICHMENT_MAX_ATTEMPTS,
} = require('./config');

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info('http_request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  app.post('/ingest', async (req, res, next) => {
    const emails = req.body?.emails;
    if (!Array.isArray(emails)) {
      res.status(400).json({ error: 'body must be { emails: [{ raw_mime }, ...] }' });
      return;
    }
    try {
      const { results } = await ingestEmails(db, emails);
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  app.use(createReadRoutes(db));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: err.message });
  });

  return app;
}

function registerCrashHandlers() {
  const onUncaught = (err) => {
    logger.error('uncaught_exception', { err: err.message, stack: err.stack, fatal: true });
    process.exit(1);
  };
  const onRejection = (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandled_rejection', { err: err.message, stack: err.stack, fatal: true });
    process.exit(1);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  };
}

if (require.main === module) {
  registerCrashHandlers();

  const db = openDb(DB_PATH);
  const app = createApp(db);
  app.listen(PORT, () => {
    logger.info('server_started', { port: PORT });
  });

  if (LLM_BASE_URL && LLM_MODEL) {
    const client = new OpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY || 'unused' });
    startEnrichmentLoop(db, {
      client,
      model: LLM_MODEL,
      intervalMs: ENRICHMENT_INTERVAL_MS,
      concurrency: ENRICHMENT_CONCURRENCY,
      maxAttempts: ENRICHMENT_MAX_ATTEMPTS,
    });
    logger.info('enrichment_configured', { baseUrl: LLM_BASE_URL, model: LLM_MODEL });
  } else {
    logger.warn('enrichment_disabled', {
      reason: 'LLM_BASE_URL/LLM_MODEL not set — links will stay unenriched',
    });
  }
}

module.exports = { createApp, registerCrashHandlers };
