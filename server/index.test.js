const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb } = require('./db');
const { createApp } = require('./index');

function tmpDb() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-index-test-')), 'digest.sqlite');
  return openDb(dbPath);
}

test('POST /ingest accepts a batch and returns per-email results', async () => {
  const db = tmpDb();
  const app = createApp(db);
  const server = app.listen(0);
  const { port } = server.address();

  const raw = [
    'Message-ID: <index-test@example.com>',
    'From: "Alice" <alice@example.com>',
    'Subject: Hi',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<a href="https://example.com/x">X</a>',
  ].join('\r\n');

  const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [{ raw_mime: raw }] }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].status, 'ingested');

  server.close();
  db.close();
});

test('POST /ingest with a malformed body returns 400', async () => {
  const db = tmpDb();
  const app = createApp(db);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notEmails: true }),
  });

  assert.equal(res.status, 400);

  server.close();
  db.close();
});

test('POST /ingest with syntactically malformed JSON returns 400 JSON, not a crash or HTML error page', async () => {
  const db = tmpDb();
  const app = createApp(db);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);

  server.close();
  db.close();
});
