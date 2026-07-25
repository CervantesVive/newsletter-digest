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

test('POST /api/links/:id/dismiss and bulk /api/links/read are wired end-to-end', async () => {
  const db = tmpDb();
  const app = createApp(db);
  const server = app.listen(0);
  const { port } = server.address();

  const info = db
    .prepare(`INSERT INTO links (url_normalized, url_original, headline) VALUES ('https://x.example/', 'https://x.example/', 'H')`)
    .run();
  const id = info.lastInsertRowid;

  const dismissRes = await fetch(`http://127.0.0.1:${port}/api/links/${id}/dismiss`, { method: 'POST' });
  assert.equal(dismissRes.status, 200);
  const dismissBody = await dismissRes.json();
  assert.deepEqual(dismissBody, { id, dismissed: true });

  const info2 = db
    .prepare(`INSERT INTO links (url_normalized, url_original, headline) VALUES ('https://y.example/', 'https://y.example/', 'H2')`)
    .run();
  const id2 = info2.lastInsertRowid;

  const bulkRes = await fetch(`http://127.0.0.1:${port}/api/links/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [id2] }),
  });
  assert.equal(bulkRes.status, 200);
  const bulkBody = await bulkRes.json();
  assert.deepEqual(bulkBody, { updated: [{ id: id2, read: true }] });

  server.close();
  db.close();
});

test('action routes reject invalid input with 400 and unknown ids with 404', async () => {
  const db = tmpDb();
  const app = createApp(db);
  const server = app.listen(0);
  const { port } = server.address();

  const badId = await fetch(`http://127.0.0.1:${port}/api/links/not-a-number/dismiss`, { method: 'POST' });
  assert.equal(badId.status, 400);

  const missingId = await fetch(`http://127.0.0.1:${port}/api/links/999999/read`, { method: 'POST' });
  assert.equal(missingId.status, 404);

  const badBulkBody = await fetch(`http://127.0.0.1:${port}/api/links/mark-saved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: 'not-an-array' }),
  });
  assert.equal(badBulkBody.status, 400);

  server.close();
  db.close();
});

test('GET /api/links is wired and returns the read API shape', async () => {
  const db = tmpDb();
  const app = createApp(db);
  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/links`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.groups));
  assert.equal(typeof body.totalCount, 'number');

  server.close();
  db.close();
});
