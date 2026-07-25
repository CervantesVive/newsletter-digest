const express = require('express');
const { openDb } = require('./db');
const { ingestEmails } = require('./ingest');
const { DB_PATH, PORT } = require('./config');

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
}

module.exports = { createApp };
