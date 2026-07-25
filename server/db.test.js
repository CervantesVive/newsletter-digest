const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb } = require('./db');

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-db-test-')), 'digest.sqlite');
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

test('openDb creates all tables from the schema on a fresh file', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
    .sort();

  assert.deepEqual(tables, ['emails', 'link_sources', 'link_topics', 'links']);

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('emails table has expected columns', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  assert.deepEqual(
    columnNames(db, 'emails').sort(),
    [
      'id',
      'message_id',
      'from_address',
      'from_name',
      'subject',
      'raw_mime',
      'received_at',
      'processed_at',
    ].sort()
  );

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('links table has expected columns and defaults', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  assert.deepEqual(
    columnNames(db, 'links').sort(),
    [
      'id',
      'url_normalized',
      'url_original',
      'headline',
      'summary',
      'read_time',
      'enriched_at',
      'enrich_attempts',
      'read',
      'dismissed',
      'saved_instapaper',
    ].sort()
  );

  db.prepare("INSERT INTO links (url_normalized, url_original) VALUES ('https://a.example/', 'https://a.example/')").run();
  const row = db.prepare("SELECT * FROM links WHERE url_normalized = 'https://a.example/'").get();
  assert.equal(row.enrich_attempts, 0);
  assert.equal(row.read, 0);
  assert.equal(row.dismissed, 0);
  assert.equal(row.saved_instapaper, 0);

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('link_sources and link_topics have expected columns and unique constraints', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  assert.deepEqual(
    columnNames(db, 'link_sources').sort(),
    ['link_id', 'email_id', 'extracted_summary'].sort()
  );
  assert.deepEqual(columnNames(db, 'link_topics').sort(), ['link_id', 'topic'].sort());

  db.prepare(
    "INSERT INTO emails (message_id, from_address, from_name, subject, raw_mime, received_at) VALUES ('m1', 'a@example.com', 'A', 'Subj', 'raw', '2026-07-25')"
  ).run();
  db.prepare("INSERT INTO links (url_normalized, url_original) VALUES ('https://b.example/', 'https://b.example/')").run();

  db.prepare('INSERT INTO link_sources (link_id, email_id, extracted_summary) VALUES (1, 1, NULL)').run();
  assert.throws(() => {
    db.prepare('INSERT INTO link_sources (link_id, email_id, extracted_summary) VALUES (1, 1, NULL)').run();
  }, /UNIQUE constraint failed/);

  db.prepare("INSERT INTO link_topics (link_id, topic) VALUES (1, 'ai')").run();
  assert.throws(() => {
    db.prepare("INSERT INTO link_topics (link_id, topic) VALUES (1, 'ai')").run();
  }, /UNIQUE constraint failed/);

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('emails.message_id is unique and links.url_normalized is unique', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  db.prepare("INSERT INTO emails (message_id) VALUES ('dup')").run();
  assert.throws(() => {
    db.prepare("INSERT INTO emails (message_id) VALUES ('dup')").run();
  }, /UNIQUE constraint failed/);

  db.prepare("INSERT INTO links (url_normalized, url_original) VALUES ('https://c.example/', 'https://c.example/')").run();
  assert.throws(() => {
    db.prepare("INSERT INTO links (url_normalized, url_original) VALUES ('https://c.example/', 'https://c.example/other')").run();
  }, /UNIQUE constraint failed/);

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('foreign_keys pragma is active — inserting a link_sources row with a nonexistent link_id/email_id is rejected', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  assert.throws(() => {
    db.prepare('INSERT INTO link_sources (link_id, email_id) VALUES (999, 999)').run();
  }, /FOREIGN KEY constraint failed/);

  assert.throws(() => {
    db.prepare("INSERT INTO link_topics (link_id, topic) VALUES (999, 'ai')").run();
  }, /FOREIGN KEY constraint failed/);

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('WAL mode is actually active on the opened connection', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('NOT NULL is enforced on required columns', () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  assert.throws(() => {
    db.prepare('INSERT INTO emails (message_id) VALUES (NULL)').run();
  }, /NOT NULL constraint failed/);

  assert.throws(() => {
    db.prepare("INSERT INTO links (url_normalized, url_original) VALUES (NULL, 'https://x.example/')").run();
  }, /NOT NULL constraint failed/);

  assert.throws(() => {
    db.prepare("INSERT INTO links (url_normalized, url_original) VALUES ('https://x.example/', NULL)").run();
  }, /NOT NULL constraint failed/);

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('data persists across close/reopen (process restart)', () => {
  const dbPath = tmpDbPath();
  const db1 = openDb(dbPath);
  db1.prepare("INSERT INTO links (url_normalized, url_original, headline) VALUES ('https://persist.example/', 'https://persist.example/', 'Hello')").run();
  db1.close();

  const db2 = openDb(dbPath);
  const row = db2.prepare("SELECT * FROM links WHERE url_normalized = 'https://persist.example/'").get();
  assert.equal(row.headline, 'Hello');

  db2.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('openDb is idempotent — reopening an existing db does not error or duplicate tables', () => {
  const dbPath = tmpDbPath();
  const db1 = openDb(dbPath);
  db1.close();

  const db2 = openDb(dbPath);
  const tables = db2
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
    .sort();
  assert.deepEqual(tables, ['emails', 'link_sources', 'link_topics', 'links']);

  db2.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});
