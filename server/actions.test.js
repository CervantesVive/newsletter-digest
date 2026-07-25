const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb } = require('./db');
const { getLinks, dismissLink, toggleRead, toggleSaved, bulkDismiss, bulkMarkRead, bulkMarkSaved } = require('./api');
const { ingestEmails } = require('./ingest');

function tmpDb() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-actions-test-')), 'digest.sqlite');
  return openDb(dbPath);
}

function seedLink(db, { read = 0, dismissed = 0, savedInstapaper = 0, url } = {}) {
  const normalized = url || `https://example.com/${Math.random()}`;
  const info = db
    .prepare(
      `INSERT INTO links (url_normalized, url_original, headline, read, dismissed, saved_instapaper) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(normalized, normalized, 'H', read, dismissed, savedInstapaper);
  return info.lastInsertRowid;
}

test('dismissLink sets dismissed permanently and returns the new state', () => {
  const db = tmpDb();
  const id = seedLink(db);

  const result = dismissLink(db, id);
  assert.deepEqual(result, { id, dismissed: true });

  const row = db.prepare('SELECT dismissed FROM links WHERE id = ?').get(id);
  assert.equal(row.dismissed, 1);

  db.close();
});

test('dismissLink on a nonexistent id returns null', () => {
  const db = tmpDb();
  assert.equal(dismissLink(db, 999), null);
  db.close();
});

test('toggleRead flips read on each call', () => {
  const db = tmpDb();
  const id = seedLink(db);

  const first = toggleRead(db, id);
  assert.deepEqual(first, { id, read: true });

  const second = toggleRead(db, id);
  assert.deepEqual(second, { id, read: false });

  db.close();
});

test('toggleSaved flips saved_instapaper on each call', () => {
  const db = tmpDb();
  const id = seedLink(db);

  const first = toggleSaved(db, id);
  assert.deepEqual(first, { id, savedInstapaper: true });

  const second = toggleSaved(db, id);
  assert.deepEqual(second, { id, savedInstapaper: false });

  db.close();
});

test('bulk variants apply to every given id and report which ones existed', () => {
  const db = tmpDb();
  const a = seedLink(db);
  const b = seedLink(db);

  const dismissResult = bulkDismiss(db, [a, b, 9999]);
  assert.deepEqual(
    dismissResult.updated.map((u) => u.id).sort((x, y) => x - y),
    [a, b].sort((x, y) => x - y)
  );
  assert.ok(dismissResult.updated.every((u) => u.dismissed === true));

  const rowA = db.prepare('SELECT dismissed FROM links WHERE id = ?').get(a);
  const rowB = db.prepare('SELECT dismissed FROM links WHERE id = ?').get(b);
  assert.equal(rowA.dismissed, 1);
  assert.equal(rowB.dismissed, 1);

  db.close();
});

test('duplicate ids in a bulk request are deduped in the response, not double-reported', () => {
  const db = tmpDb();
  const a = seedLink(db);

  const result = bulkMarkRead(db, [a, a, a]);
  assert.deepEqual(result.updated, [{ id: a, read: true }]);

  db.close();
});

test('toggleRead/toggleSaved/bulk actions may still mutate an already-dismissed link (intentional: dismiss only ever affects the dismissed column, and the UI has no path to a dismissed id anyway)', () => {
  const db = tmpDb();
  const id = seedLink(db, { dismissed: 1 });

  const readResult = toggleRead(db, id);
  assert.deepEqual(readResult, { id, read: true });

  const row = db.prepare('SELECT dismissed, read FROM links WHERE id = ?').get(id);
  assert.equal(row.dismissed, 1, 'dismissed must remain untouched');
  assert.equal(row.read, 1);

  db.close();
});

test('bulkMarkRead force-sets read=1 (not a toggle) for all given ids', () => {
  const db = tmpDb();
  const a = seedLink(db, { read: 1 });
  const b = seedLink(db, { read: 0 });

  bulkMarkRead(db, [a, b]);

  const rowA = db.prepare('SELECT read FROM links WHERE id = ?').get(a);
  const rowB = db.prepare('SELECT read FROM links WHERE id = ?').get(b);
  assert.equal(rowA.read, 1);
  assert.equal(rowB.read, 1);

  db.close();
});

test('bulkMarkSaved force-sets saved_instapaper=1 for all given ids', () => {
  const db = tmpDb();
  const a = seedLink(db);
  const b = seedLink(db, { savedInstapaper: 1 });

  bulkMarkSaved(db, [a, b]);

  const rowA = db.prepare('SELECT saved_instapaper FROM links WHERE id = ?').get(a);
  const rowB = db.prepare('SELECT saved_instapaper FROM links WHERE id = ?').get(b);
  assert.equal(rowA.saved_instapaper, 1);
  assert.equal(rowB.saved_instapaper, 1);

  db.close();
});

test('dismiss is permanent per URL: re-ingesting the same URL from a new email does not undo it', async () => {
  const db = tmpDb();
  const raw1 = [
    'Message-ID: <first@example.com>',
    'From: "Alice" <alice@example.com>',
    'Subject: One',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<a href="https://example.com/permanent">Link</a>',
  ].join('\r\n');

  await ingestEmails(db, [{ raw_mime: raw1 }]);
  const link = db.prepare('SELECT * FROM links WHERE url_normalized = ?').get('https://example.com/permanent');
  dismissLink(db, link.id);

  const raw2 = [
    'Message-ID: <second@example.com>',
    'From: "Bob" <bob@example.com>',
    'Subject: Two, same link re-mentioned',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<a href="https://example.com/permanent">Link again</a>',
  ].join('\r\n');
  await ingestEmails(db, [{ raw_mime: raw2 }]);

  const linkAfter = db.prepare('SELECT * FROM links WHERE url_normalized = ?').get('https://example.com/permanent');
  assert.equal(linkAfter.dismissed, 1, 'dismissed must survive a fresh mention of the same URL');

  const result = getLinks(db, {});
  const headlines = result.groups.flatMap((g) => g.items.map((i) => i.id));
  assert.ok(!headlines.includes(link.id), 'a dismissed link must not reappear in the feed');

  db.close();
});
