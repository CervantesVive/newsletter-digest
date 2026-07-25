const path = require('node:path');
const express = require('express');
const OpenAI = require('openai');
const { openDb } = require('./db');
const { ingestEmails } = require('./ingest');
const { startEnrichmentLoop } = require('./enrich');
const { createReadRoutes } = require('./api');
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

if (require.main === module) {
  const db = openDb(DB_PATH);
  const app = createApp(db);
  app.listen(PORT, () => {
    console.log(`newsletter-digest listening on :${PORT}`);
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
    console.log(`enrichment loop started against ${LLM_BASE_URL} (model: ${LLM_MODEL})`);
  } else {
    console.warn('LLM_BASE_URL/LLM_MODEL not set — enrichment loop disabled, links will stay unenriched');
  }
}

module.exports = { createApp };
