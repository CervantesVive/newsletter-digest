# Operational Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured, daily-rotating JSON logs (winston + winston-daily-rotate-file) for ingest, enrichment, HTTP, and crash events, with a clean seam to plug in real-time alerting later.

**Architecture:** A single `server/logger.js` module wraps a winston logger (JSON format, `DailyRotateFile` transport + console transport in non-production). Every other module requires the singleton `logger` export and calls `logger.info/warn/error(eventName, fields)` at the instrumentation points identified in the spec. No alerting is wired up — `logger.add()` is documented as the future extension point.

**Tech Stack:** Node.js, `winston` ^3.19, `winston-daily-rotate-file` ^5.0, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-25-operational-logging-design.md` — read it if any task here seems ambiguous.

## Global Constraints

- No new dependencies beyond `winston` and `winston-daily-rotate-file` — do not add `morgan`, `pino`, or anything else.
- `LOG_LEVEL` default `'info'`, `LOG_RETENTION_DAYS` default `14`, `LOG_DIR` default `data/logs` (relative to repo root, matching `DB_PATH`'s existing pattern in `server/config.js`).
- Log call shape everywhere: `logger.<level>(eventName, fieldsObject)` — `eventName` is a `snake_case` string logged as winston's `message` field; all other data goes in the fields object. Never interpolate values into the event-name string itself.
- Winston has no built-in `fatal` level — crash logging uses `logger.error()` with a `fatal: true` field, not a custom level.
- Every existing `console.log`/`console.warn`/`console.error` call in `server/index.js` and `server/enrich.js` must be replaced by the equivalent `logger` call — do not leave any bare `console.*` calls for application events in these two files.
- Follow existing test conventions exactly: each test file defines its own small helpers (`tmpDb()`, etc.) rather than importing from a shared test-helpers module — this repo has no such module and duplicating a ~10-line helper per file is the established pattern (see `tmpDb()` duplicated across `ingest.test.js`, `enrich.test.js`, `index.test.js`).
- Run the full suite with `npm test` (equivalent to `node --test server/*.test.js`) before every commit that touches test files.

---

### Task 1: Logger module — dependencies, config, and `server/logger.js`

**Files:**
- Modify: `package.json` (add dependencies)
- Modify: `server/config.js` (add `LOG_LEVEL`, `LOG_RETENTION_DAYS`, `LOG_DIR`)
- Modify: `.gitignore` (ignore rotated log files)
- Create: `server/logger.js`
- Test: `server/logger.test.js`

**Interfaces:**
- Produces: `server/logger.js` exports `{ logger, createLogger }`. `logger` is a ready-to-use winston `Logger` instance built from `server/config.js` defaults. `createLogger(opts)` accepts `{ level, dir, retentionDays, console }` (all optional, defaulting to config values / `process.env.NODE_ENV !== 'production'` for `console`) and returns a fresh winston `Logger` instance — used by tests to point logging at a temp directory instead of the real `data/logs`.
- Every later task consumes `const { logger } = require('./logger');` and calls `logger.info(event, fields)` / `logger.warn(event, fields)` / `logger.error(event, fields)`.

- [ ] **Step 1: Add dependencies to `package.json`**

Edit the `dependencies` block in `package.json` to add two entries (keep alphabetical order):

```json
  "dependencies": {
    "better-sqlite3": "^13.0.1",
    "cheerio": "^1.2.0",
    "express": "^5.2.1",
    "mailparser": "^3.9.14",
    "openai": "^6.49.0",
    "winston": "^3.19.0",
    "winston-daily-rotate-file": "^5.0.0"
  },
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `package-lock.json` updates, `node_modules/winston` and `node_modules/winston-daily-rotate-file` exist.

- [ ] **Step 3: Add config values**

Modify `server/config.js` — add after the existing `ENRICHMENT_MAX_ATTEMPTS` line (before `module.exports`):

```js
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS) || 14);
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'data', 'logs');
```

Update `module.exports` to include the three new names:

```js
module.exports = {
  DB_PATH,
  PORT,
  LLM_BASE_URL,
  LLM_API_KEY,
  LLM_MODEL,
  ENRICHMENT_INTERVAL_MS,
  ENRICHMENT_CONCURRENCY,
  ENRICHMENT_MAX_ATTEMPTS,
  LOG_LEVEL,
  LOG_RETENTION_DAYS,
  LOG_DIR,
};
```

- [ ] **Step 4: Ignore rotated log files**

Modify `.gitignore` — add a line after `data/*.sqlite*`:

```
data/logs/
```

- [ ] **Step 5: Write the failing test**

Create `server/logger.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createLogger } = require('./logger');

function tmpLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'digest-logger-test-'));
}

function readLogLines(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
  return files.flatMap((f) =>
    fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
}

function flush(logger) {
  return new Promise((resolve) => {
    logger.on('finish', resolve);
    logger.end();
  });
}

test('writes structured JSON lines to the configured directory', async () => {
  const dir = tmpLogDir();
  const logger = createLogger({ dir, level: 'info', console: false });

  logger.info('test_event', { foo: 1 });
  await flush(logger);

  const lines = readLogLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'test_event');
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].foo, 1);
  assert.ok(lines[0].timestamp);
});

test('LOG_LEVEL filtering: a debug call is dropped when level is info', async () => {
  const dir = tmpLogDir();
  const logger = createLogger({ dir, level: 'info', console: false });

  logger.debug('debug_event', {});
  logger.info('info_event', {});
  await flush(logger);

  const lines = readLogLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'info_event');
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test server/logger.test.js`
Expected: FAIL — `Cannot find module './logger'`

- [ ] **Step 7: Implement `server/logger.js`**

```js
const winston = require('winston');
require('winston-daily-rotate-file');
const config = require('./config');

function createLogger({
  level = config.LOG_LEVEL,
  dir = config.LOG_DIR,
  retentionDays = config.LOG_RETENTION_DAYS,
  console: withConsole = process.env.NODE_ENV !== 'production',
} = {}) {
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
  return winston.createLogger({
    level,
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports,
  });
}

const logger = createLogger();

// ponytail: extension seam for future alerting — logger.add(new SomeTransport({ level: 'error' }))
// to forward error-level entries to Slack/email/push once it's clear what should page.

module.exports = { logger, createLogger };
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test server/logger.test.js`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json server/config.js server/logger.js server/logger.test.js .gitignore
git commit -m "feat: add structured logging infrastructure (winston, daily rotation)"
```

---

### Task 2: Ingest instrumentation

**Files:**
- Modify: `server/ingest.js:1-2, 91-157`
- Test: `server/ingest.test.js` (extend two existing tests)

**Interfaces:**
- Consumes: `const { logger } = require('./logger');` from Task 1.
- Produces: no new exports — `ingestEmails`/`normalizeUrl` signatures and `ingestOne`'s return shape are unchanged.

- [ ] **Step 1: Extend the failing tests**

In `server/ingest.test.js`, add the capture helper near the top (after the existing imports, before `tmpDb()`):

```js
const winston = require('winston');
const { Writable } = require('node:stream');
const { logger } = require('./logger');

function captureLogs() {
  const entries = [];
  const transport = new winston.transports.Stream({
    stream: new Writable({
      write(chunk, enc, cb) {
        entries.push(JSON.parse(chunk.toString()));
        cb();
      },
    }),
  });
  logger.add(transport);
  return { entries, stop: () => logger.remove(transport) };
}
```

Extend the first test (`'ingests a single email: creates email row, extracts link, sets processed_at'`) — wrap it with log capture and add assertions right before `db.close();`:

```js
test('ingests a single email: creates email row, extracts link, sets processed_at', async () => {
  const db = tmpDb();
  const { entries, stop } = captureLogs();
  const raw = mime({
    messageId: '<one@example.com>',
    html: '<html><body><p>Check out <a href="https://example.com/article?utm_source=news&ref=abc">this cool article</a> about AI.</p></body></html>',
  });

  const { results } = await ingestEmails(db, [{ raw_mime: raw }]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'ingested');
  assert.equal(results[0].message_id, '<one@example.com>');

  const email = db.prepare('SELECT * FROM emails WHERE message_id = ?').get('<one@example.com>');
  assert.ok(email);
  assert.equal(email.from_address, 'alice@example.com');
  assert.equal(email.from_name, 'Alice');
  assert.equal(email.subject, 'Weekly Newsletter');
  assert.ok(email.processed_at);

  const link = db.prepare('SELECT * FROM links WHERE url_normalized = ?').get('https://example.com/article');
  assert.ok(link, 'link should be normalized (tracking params + none stripped, base kept)');
  assert.equal(link.url_original, 'https://example.com/article?utm_source=news&ref=abc');

  const source = db
    .prepare('SELECT * FROM link_sources WHERE link_id = ? AND email_id = ?')
    .get(link.id, email.id);
  assert.ok(source);
  assert.match(source.extracted_summary, /this cool article/);

  const logged = entries.find((e) => e.message === 'ingest_completed');
  assert.ok(logged, 'expected an ingest_completed log entry');
  assert.equal(logged.level, 'info');
  assert.equal(logged.linksFound, 1);
  assert.equal(logged.dupes, 0);

  stop();
  db.close();
});
```

Extend `'one bad email in a batch does not abort processing of the others'` the same way:

```js
test('one bad email in a batch does not abort processing of the others', async () => {
  const db = tmpDb();
  const { entries, stop } = captureLogs();
  const good = mime({ messageId: '<good@example.com>', html: '<a href="https://example.com/good">Good</a>' });

  const { results } = await ingestEmails(db, [{ raw_mime: 12345 }, { raw_mime: good }]);

  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'error');
  assert.ok(results[0].error);
  assert.equal(results[1].status, 'ingested');

  const email = db.prepare('SELECT * FROM emails WHERE message_id = ?').get('<good@example.com>');
  assert.ok(email);

  const logged = entries.find((e) => e.message === 'ingest_failed');
  assert.ok(logged, 'expected an ingest_failed log entry');
  assert.equal(logged.level, 'error');
  assert.ok(logged.err);

  stop();
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/ingest.test.js`
Expected: FAIL on the two new assertion blocks — `logged` is `undefined` (`ingest_completed`/`ingest_failed` never logged).

- [ ] **Step 3: Implement logging in `server/ingest.js`**

Add the import at the top (after existing requires, line 3):

```js
const { logger } = require('./logger');
```

Replace the body of `ingestOne` (lines 91-145) with:

```js
async function ingestOne(db, rawInput) {
  const raw = decodeRawMime(rawInput);
  const parsed = await simpleParser(raw);

  const fromAddress = parsed.from?.value?.[0]?.address || null;
  const fromName = parsed.from?.value?.[0]?.name || null;
  const subject = parsed.subject || null;
  const body = parsed.html || parsed.text || '';
  const messageId = parsed.messageId || fallbackMessageId({ fromAddress, subject, body });

  const links = extractLinks(parsed.html || parsed.textAsHtml || '');

  const insertEmail = db.prepare(
    `INSERT OR IGNORE INTO emails (message_id, from_address, from_name, subject, raw_mime, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO links (url_normalized, url_original, headline) VALUES (?, ?, ?)`
  );
  const selectLink = db.prepare(`SELECT id FROM links WHERE url_normalized = ?`);
  const insertSource = db.prepare(
    `INSERT OR IGNORE INTO link_sources (link_id, email_id, extracted_summary) VALUES (?, ?, ?)`
  );
  const markProcessed = db.prepare(`UPDATE emails SET processed_at = ? WHERE id = ?`);

  let dupeLinks = 0;

  // Whole ingest is one transaction: the email row, its links, and processed_at all
  // commit together, so a failure partway through never leaves an email row stuck
  // permanently unprocessed under a message_id that's now "taken" for dedup purposes.
  const ingestTx = db.transaction(() => {
    const info = insertEmail.run(
      messageId,
      fromAddress,
      fromName,
      subject,
      raw,
      parsed.date ? parsed.date.toISOString() : null
    );

    if (info.changes === 0) {
      return { message_id: messageId, status: 'duplicate' };
    }

    const emailId = info.lastInsertRowid;
    for (const link of links) {
      const linkInfo = insertLink.run(link.urlNormalized, link.urlOriginal, link.extractedSummary);
      if (linkInfo.changes === 0) dupeLinks += 1;
      const { id: linkId } = selectLink.get(link.urlNormalized);
      insertSource.run(linkId, emailId, link.extractedSummary);
    }
    markProcessed.run(new Date().toISOString(), emailId);

    return { message_id: messageId, status: 'ingested' };
  });

  const result = ingestTx();
  if (result.status === 'ingested') {
    logger.info('ingest_completed', { linksFound: links.length, dupes: dupeLinks });
  }
  return result;
}
```

Replace `ingestEmails` (lines 147-157) with:

```js
async function ingestEmails(db, emails) {
  const results = [];
  for (const email of emails) {
    try {
      results.push(await ingestOne(db, email.raw_mime));
    } catch (err) {
      logger.error('ingest_failed', { err: err.message, stack: err.stack });
      results.push({ message_id: null, status: 'error', error: err.message });
    }
  }
  return { results };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/ingest.test.js`
Expected: PASS (all tests, including the two extended ones)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (no regressions in other files)

- [ ] **Step 6: Commit**

```bash
git add server/ingest.js server/ingest.test.js
git commit -m "feat: log ingest_completed/ingest_failed events"
```

---

### Task 3: Enrichment per-link instrumentation

**Files:**
- Modify: `server/enrich.js:1, 127-156`
- Test: `server/enrich.test.js` (extend two existing tests, add one new)

**Interfaces:**
- Consumes: `const { logger } = require('./logger');` from Task 1.
- Produces: `persistFailure(db, linkId, maxAttempts)` now **returns** the new `attempts` count (previously returned nothing) — Task 4 does not depend on this, but note the signature change if touching this function later.

- [ ] **Step 1: Extend the failing tests**

In `server/enrich.test.js`, add the same capture helper used in Task 2, placed after the existing imports (before `tmpDb()`):

```js
const winston = require('winston');
const { Writable } = require('node:stream');
const { logger } = require('./logger');

function captureLogs() {
  const entries = [];
  const transport = new winston.transports.Stream({
    stream: new Writable({
      write(chunk, enc, cb) {
        entries.push(JSON.parse(chunk.toString()));
        cb();
      },
    }),
  });
  logger.add(transport);
  return { entries, stop: () => logger.remove(transport) };
}
```

Extend `'enriches a single-source link and upserts topics'` (add capture + assertion, keep everything else identical):

```js
test('enriches a single-source link and upserts topics', async () => {
  const db = tmpDb();
  const { entries, stop } = captureLogs();
  const linkId = seedLink(db, { sources: [{ from: 'Alice', summary: 'AI news roundup' }] });

  const client = fakeClient(() => jsonResponse({ summary: 'A great summary', topics: ['ai', 'news'], read_time: 4 }));

  await runEnrichmentPass(db, { client, model: 'test-model' });

  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(linkId);
  assert.equal(link.summary, 'A great summary');
  assert.equal(link.read_time, 4);
  assert.ok(link.enriched_at);

  const topics = db.prepare('SELECT topic FROM link_topics WHERE link_id = ? ORDER BY topic').all(linkId).map((r) => r.topic);
  assert.deepEqual(topics, ['ai', 'news']);

  const logged = entries.find((e) => e.message === 'enrichment_completed');
  assert.ok(logged, 'expected an enrichment_completed log entry');
  assert.equal(logged.level, 'info');
  assert.equal(logged.linkId, linkId);

  stop();
  db.close();
});
```

Extend `'failure increments enrich_attempts and retries on the next pass'`:

```js
test('failure increments enrich_attempts and retries on the next pass', async () => {
  const db = tmpDb();
  const { entries, stop } = captureLogs();
  const linkId = seedLink(db);

  const client = fakeClient(() => {
    throw new Error('LLM unavailable');
  });

  await runEnrichmentPass(db, { client, model: 'test-model' });
  let link = db.prepare('SELECT * FROM links WHERE id = ?').get(linkId);
  assert.equal(link.enrich_attempts, 1);
  assert.equal(link.enriched_at, null);

  await runEnrichmentPass(db, { client, model: 'test-model' });
  link = db.prepare('SELECT * FROM links WHERE id = ?').get(linkId);
  assert.equal(link.enrich_attempts, 2);
  assert.equal(link.enriched_at, null);

  const failedLogs = entries.filter((e) => e.message === 'enrichment_failed');
  assert.equal(failedLogs.length, 2);
  assert.equal(failedLogs[0].level, 'warn');
  assert.equal(failedLogs[0].linkId, linkId);
  assert.equal(failedLogs[1].attempt, 2);

  stop();
  db.close();
});
```

Extend `'after maxAttempts consecutive failures, enriched_at is set to a sentinel and the link stops being retried'`:

```js
test('after maxAttempts consecutive failures, enriched_at is set to a sentinel and the link stops being retried', async () => {
  const db = tmpDb();
  const { entries, stop } = captureLogs();
  const linkId = seedLink(db);

  const client = fakeClient(() => {
    throw new Error('LLM unavailable');
  });

  for (let i = 0; i < 5; i++) {
    await runEnrichmentPass(db, { client, model: 'test-model', maxAttempts: 5 });
  }

  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(linkId);
  assert.equal(link.enrich_attempts, 5);
  assert.equal(link.enriched_at, ENRICHMENT_SENTINEL);

  const callsBefore = client.calls.length;
  await runEnrichmentPass(db, { client, model: 'test-model', maxAttempts: 5 });
  assert.equal(client.calls.length, callsBefore, 'a sentinel-stopped link must not be selected again');

  const gaveUp = entries.find((e) => e.message === 'enrichment_gave_up');
  assert.ok(gaveUp, 'expected an enrichment_gave_up log entry');
  assert.equal(gaveUp.level, 'error');
  assert.equal(gaveUp.linkId, linkId);
  assert.equal(gaveUp.attempts, 5);

  stop();
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/enrich.test.js`
Expected: FAIL on the three extended assertion blocks (`logged`/`gaveUp` undefined, `failedLogs.length` is 0)

- [ ] **Step 3: Implement logging in `server/enrich.js`**

Add the import at the top (line 1, before `const ENRICHMENT_SENTINEL = 'gave_up';`):

```js
const { logger } = require('./logger');
```

Replace `persistFailure` (lines 127-142) — it now returns the updated attempts count:

```js
function persistFailure(db, linkId, maxAttempts) {
  let attempts;
  const tx = db.transaction(() => {
    const { enrich_attempts: prevAttempts } = db.prepare('SELECT enrich_attempts FROM links WHERE id = ?').get(linkId);
    attempts = prevAttempts + 1;
    if (attempts >= maxAttempts) {
      db.prepare('UPDATE links SET enrich_attempts = ?, enriched_at = ? WHERE id = ?').run(
        attempts,
        ENRICHMENT_SENTINEL,
        linkId
      );
    } else {
      db.prepare('UPDATE links SET enrich_attempts = ? WHERE id = ?').run(attempts, linkId);
    }
  });
  tx();
  return attempts;
}
```

Replace `enrichAndPersist` (lines 144-156):

```js
async function enrichAndPersist(db, client, model, link, maxAttempts) {
  const sources = selectSources(db, link.id);
  try {
    const parsed = await callLlm(client, model, link, sources);
    persistSuccess(db, link.id, parsed);
    logger.info('enrichment_completed', { linkId: link.id, attempt: link.enrich_attempts });
    return { linkId: link.id, status: 'enriched' };
  } catch (err) {
    const attempts = persistFailure(db, link.id, maxAttempts);
    logger.warn('enrichment_failed', { linkId: link.id, attempt: attempts, err: err.message });
    if (attempts >= maxAttempts) {
      logger.error('enrichment_gave_up', { linkId: link.id, attempts });
    }
    return { linkId: link.id, status: 'failed', error: err.message };
  } finally {
    inFlightLinkIds.delete(link.id);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/enrich.test.js`
Expected: PASS (all tests, including the three extended ones)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/enrich.js server/enrich.test.js
git commit -m "feat: log enrichment_completed/enrichment_failed/enrichment_gave_up events"
```

---

### Task 4: Enrichment loop instrumentation (start/stop/stall)

**Files:**
- Modify: `server/enrich.js:178-192`
- Test: `server/enrich.test.js` (add two new tests)

**Interfaces:**
- Consumes: `logger` from Task 1 (already imported in this file by Task 3).
- Produces: `startEnrichmentLoop`'s public signature and return value (a stop function) are unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `server/enrich.test.js`, after the last existing test:

```js
test('logs enrichment_loop_started and enrichment_loop_stopped', () => {
  const db = tmpDb();
  const { entries, stop } = captureLogs();
  const client = fakeClient(() => jsonResponse({ summary: 's', topics: [], read_time: 1 }));

  const stopLoop = startEnrichmentLoop(db, { client, model: 'test-model', intervalMs: 1000, concurrency: 2 });

  const started = entries.find((e) => e.message === 'enrichment_loop_started');
  assert.ok(started, 'expected an enrichment_loop_started log entry');
  assert.equal(started.intervalMs, 1000);
  assert.equal(started.concurrency, 2);

  stopLoop();

  assert.ok(entries.find((e) => e.message === 'enrichment_loop_stopped'));

  stop();
  db.close();
});

test('logs enrichment_loop_stalled when a pass hangs past 5x the interval', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const db = tmpDb();
  seedLink(db);
  const { entries, stop } = captureLogs();
  const hangingClient = { chat: { completions: { create: () => new Promise(() => {}) } } };

  const stopLoop = startEnrichmentLoop(db, { client: hangingClient, model: 'test-model', intervalMs: 1000 });

  t.mock.timers.tick(1000); // first pass starts and hangs
  t.mock.timers.tick(5000); // 5 more intervals with no completed pass

  const stalled = entries.find((e) => e.message === 'enrichment_loop_stalled');
  assert.ok(stalled, 'expected an enrichment_loop_stalled log entry');
  assert.equal(stalled.level, 'error');

  stopLoop();
  stop();
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/enrich.test.js`
Expected: FAIL — neither `enrichment_loop_started`/`stopped`/`stalled` is logged yet.

- [ ] **Step 3: Implement logging in `server/enrich.js`**

Replace `startEnrichmentLoop` (lines 178-192):

```js
function startEnrichmentLoop(db, { client, model, intervalMs = 30000, concurrency = 3, maxAttempts = 5 }) {
  let running = false;
  let lastPassAt = Date.now();
  let stalled = false;
  const stallThresholdMs = intervalMs * 5;

  logger.info('enrichment_loop_started', { intervalMs, concurrency });

  const timer = setInterval(async () => {
    if (!stalled && Date.now() - lastPassAt > stallThresholdMs) {
      stalled = true;
      logger.error('enrichment_loop_stalled', {
        minutesSinceLastPass: Math.round((Date.now() - lastPassAt) / 60000),
      });
    }

    if (running) return;
    running = true;
    try {
      await runEnrichmentPass(db, { client, model, concurrency, maxAttempts });
      lastPassAt = Date.now();
      stalled = false;
    } catch (err) {
      logger.error('enrichment_pass_failed', { err: err.message, stack: err.stack });
    } finally {
      running = false;
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
    logger.info('enrichment_loop_stopped', {});
  };
}
```

This also replaces the previous `console.error('enrichment pass failed:', err)` with a structured `enrichment_pass_failed` log — the last remaining `console.*` call in this file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/enrich.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/enrich.js server/enrich.test.js
git commit -m "feat: log enrichment loop start/stop and stall detection"
```

---

### Task 5: HTTP access logging and crash handlers in `server/index.js`

**Files:**
- Modify: `server/index.js` (entire file restructured slightly — see below)
- Test: `server/index.test.js` (add two new tests)

**Interfaces:**
- Consumes: `logger` from Task 1.
- Produces: `server/index.js` exports `{ createApp, registerCrashHandlers }` (new export). `registerCrashHandlers()` takes no arguments, registers `process.on('uncaughtException'/'unhandledRejection', ...)` handlers that log then `process.exit(1)`, and **returns an unregister function** (`() => void`) so tests can remove the listeners afterward.

- [ ] **Step 1: Write the failing tests**

Add to `server/index.test.js`, after the existing imports (before `tmpDb()`):

```js
const winston = require('winston');
const { Writable } = require('node:stream');
const { logger } = require('./logger');
const { registerCrashHandlers } = require('./index');

function captureLogs() {
  const entries = [];
  const transport = new winston.transports.Stream({
    stream: new Writable({
      write(chunk, enc, cb) {
        entries.push(JSON.parse(chunk.toString()));
        cb();
      },
    }),
  });
  logger.add(transport);
  return { entries, stop: () => logger.remove(transport) };
}
```

Add two new tests at the end of the file:

```js
test('HTTP requests are logged with method, path, status, and duration', async () => {
  const db = tmpDb();
  const app = createApp(db);
  const server = app.listen(0);
  const { port } = server.address();
  const { entries, stop } = captureLogs();

  await fetch(`http://127.0.0.1:${port}/api/links`);

  const logged = entries.find((e) => e.message === 'http_request');
  assert.ok(logged, 'expected an http_request log entry');
  assert.equal(logged.method, 'GET');
  assert.equal(logged.path, '/api/links');
  assert.equal(logged.status, 200);
  assert.equal(typeof logged.durationMs, 'number');

  stop();
  server.close();
  db.close();
});

test('registerCrashHandlers logs a fatal event and exits on uncaughtException', (t) => {
  const exitCalls = [];
  t.mock.method(process, 'exit', (code) => {
    exitCalls.push(code);
  });
  const { entries, stop } = captureLogs();

  const unregister = registerCrashHandlers();
  process.emit('uncaughtException', new Error('boom'));
  unregister();
  stop();

  assert.deepEqual(exitCalls, [1]);
  const logged = entries.find((e) => e.message === 'uncaught_exception');
  assert.ok(logged, 'expected an uncaught_exception log entry');
  assert.equal(logged.level, 'error');
  assert.equal(logged.fatal, true);
  assert.match(logged.err, /boom/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/index.test.js`
Expected: FAIL — `registerCrashHandlers` is not exported, `http_request` is never logged.

- [ ] **Step 3: Implement in `server/index.js`**

Replace the full file contents:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/index.test.js`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all `server/*.test.js` files pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/index.test.js
git commit -m "feat: log HTTP requests and crash-handle uncaught exceptions/rejections"
```

---

## Post-plan: PR

After Task 5's commit lands and `npm test` is green, open a PR from the feature branch to `main` summarizing the change (structured logging for ingest/enrichment/HTTP/crashes, daily rotation, configurable retention, no alerting wired up yet) and linking the design spec at `docs/superpowers/specs/2026-07-25-operational-logging-design.md`.
