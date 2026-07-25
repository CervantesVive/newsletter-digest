const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb } = require('./db');
const { ingestEmails, normalizeUrl } = require('./ingest');

function tmpDb() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-ingest-test-')), 'digest.sqlite');
  return openDb(dbPath);
}

function mime({ messageId, from, subject, html }) {
  const headers = [
    messageId ? `Message-ID: ${messageId}` : null,
    `From: ${from || '"Alice" <alice@example.com>'}`,
    `Subject: ${subject || 'Weekly Newsletter'}`,
    'Content-Type: text/html; charset=utf-8',
  ].filter(Boolean);
  return [...headers, '', html].join('\r\n');
}

test('ingests a single email: creates email row, extracts link, sets processed_at', async () => {
  const db = tmpDb();
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

  db.close();
});

test('duplicate Message-ID is reported as duplicate and not double-processed', async () => {
  const db = tmpDb();
  const raw = mime({
    messageId: '<dup@example.com>',
    html: '<a href="https://example.com/a">A</a>',
  });

  const first = await ingestEmails(db, [{ raw_mime: raw }]);
  assert.equal(first.results[0].status, 'ingested');

  const second = await ingestEmails(db, [{ raw_mime: raw }]);
  assert.equal(second.results[0].status, 'duplicate');
  assert.equal(second.results[0].message_id, '<dup@example.com>');

  const emailCount = db.prepare('SELECT COUNT(*) AS c FROM emails WHERE message_id = ?').get('<dup@example.com>').c;
  assert.equal(emailCount, 1);

  db.close();
});

test('two emails sharing a URL (after normalization) merge into one link with two sources', async () => {
  const db = tmpDb();
  const rawA = mime({
    messageId: '<a@example.com>',
    from: '"Alice" <alice@example.com>',
    html: '<a href="https://example.com/shared?utm_campaign=x">Shared link</a>',
  });
  const rawB = mime({
    messageId: '<b@example.com>',
    from: '"Bob" <bob@example.com>',
    html: '<a href="https://example.com/shared/?ref=y">Shared link again</a>',
  });

  await ingestEmails(db, [{ raw_mime: rawA }, { raw_mime: rawB }]);

  const links = db.prepare('SELECT * FROM links WHERE url_normalized = ?').all('https://example.com/shared');
  assert.equal(links.length, 1);

  const sources = db.prepare('SELECT * FROM link_sources WHERE link_id = ?').all(links[0].id);
  assert.equal(sources.length, 2);

  db.close();
});

test('missing Message-ID falls back to a stable SHA-256(from+subject+body) dedup key', async () => {
  const db = tmpDb();
  const raw = mime({
    messageId: null,
    from: '"Carol" <carol@example.com>',
    subject: 'No message id here',
    html: '<a href="https://example.com/x">X</a>',
  });

  const { results } = await ingestEmails(db, [{ raw_mime: raw }]);
  assert.equal(results[0].status, 'ingested');
  assert.match(results[0].message_id, /^[a-f0-9]{64}$/);

  // re-ingesting the identical content should be recognized as the same fallback key => duplicate
  const second = await ingestEmails(db, [{ raw_mime: raw }]);
  assert.equal(second.results[0].status, 'duplicate');

  db.close();
});

test('one bad email in a batch does not abort processing of the others', async () => {
  const db = tmpDb();
  const good = mime({ messageId: '<good@example.com>', html: '<a href="https://example.com/good">Good</a>' });

  const { results } = await ingestEmails(db, [{ raw_mime: 12345 }, { raw_mime: good }]);

  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'error');
  assert.ok(results[0].error);
  assert.equal(results[1].status, 'ingested');

  const email = db.prepare('SELECT * FROM emails WHERE message_id = ?').get('<good@example.com>');
  assert.ok(email);

  db.close();
});

test('accepts base64-encoded raw_mime as an alternative to raw text', async () => {
  const db = tmpDb();
  const raw = mime({ messageId: '<b64@example.com>', html: '<a href="https://example.com/b64">B64</a>' });
  const encoded = Buffer.from(raw, 'utf8').toString('base64');

  const { results } = await ingestEmails(db, [{ raw_mime: encoded }]);
  assert.equal(results[0].status, 'ingested');

  const email = db.prepare('SELECT * FROM emails WHERE message_id = ?').get('<b64@example.com>');
  assert.ok(email);

  db.close();
});

test('non-http(s) links (mailto, tel, javascript, anchors) are ignored', async () => {
  const db = tmpDb();
  const raw = mime({
    messageId: '<nohttp@example.com>',
    html: `
      <a href="mailto:someone@example.com">Email us</a>
      <a href="tel:+15551234567">Call us</a>
      <a href="javascript:void(0)">Click</a>
      <a href="#top">Top</a>
      <a href="https://example.com/real">Real link</a>
    `,
  });

  await ingestEmails(db, [{ raw_mime: raw }]);

  const allLinks = db.prepare('SELECT url_normalized FROM links').all();
  assert.deepEqual(
    allLinks.map((l) => l.url_normalized),
    ['https://example.com/real']
  );

  db.close();
});

test('a new link is seeded with the anchor text as its headline (first-seen wins)', async () => {
  const db = tmpDb();
  const rawA = mime({
    messageId: '<headline-a@example.com>',
    html: '<a href="https://example.com/headline?utm_source=x">Anthropic ships Claude 5</a>',
  });
  const rawB = mime({
    messageId: '<headline-b@example.com>',
    html: '<a href="https://example.com/headline/?ref=y">A completely different anchor text</a>',
  });

  await ingestEmails(db, [{ raw_mime: rawA }]);
  const link = db.prepare('SELECT * FROM links WHERE url_normalized = ?').get('https://example.com/headline');
  assert.equal(link.headline, 'Anthropic ships Claude 5');

  // re-mentioning the same URL from a different email must not clobber the first headline
  await ingestEmails(db, [{ raw_mime: rawB }]);
  const linkAfter = db.prepare('SELECT * FROM links WHERE url_normalized = ?').get('https://example.com/headline');
  assert.equal(linkAfter.headline, 'Anthropic ships Claude 5');

  db.close();
});

test('mbox-style leading line does not cause raw MIME text to be misdetected as base64', async () => {
  const db = tmpDb();
  const raw =
    'From alice@example.com Mon Jan  1 00:00:00 2026\r\n' +
    mime({ messageId: '<mbox@example.com>', html: '<a href="https://example.com/mbox">Mbox</a>' });

  const { results } = await ingestEmails(db, [{ raw_mime: raw }]);
  assert.equal(results[0].status, 'ingested');

  const email = db.prepare('SELECT * FROM emails WHERE message_id = ?').get('<mbox@example.com>');
  assert.ok(email, 'email headers after the mbox line should still be parsed correctly, not base64-mangled');
  assert.equal(email.subject, 'Weekly Newsletter');

  db.close();
});

test('a failure partway through ingestion does not permanently strand the email as an un-retryable duplicate', async () => {
  const db = tmpDb();
  const raw = mime({ messageId: '<atomic@example.com>', html: '<a href="https://example.com/atomic">Atomic</a>' });

  // Simulate a downstream failure (e.g. a constraint violation) by making link_sources
  // writes impossible mid-transaction, then confirm the whole thing rolled back cleanly
  // rather than leaving a committed email row with no links/processed_at.
  const originalPrepare = db.prepare.bind(db);
  let calls = 0;
  db.prepare = (sql) => {
    if (sql.includes('INSERT OR IGNORE INTO link_sources')) {
      calls += 1;
      throw new Error('simulated failure');
    }
    return originalPrepare(sql);
  };

  await assert.rejects(() => ingestEmails(db, [{ raw_mime: raw }]).then(({ results }) => {
    if (results[0].status === 'error') throw new Error(results[0].error);
  }));

  db.prepare = originalPrepare;

  const email = db.prepare('SELECT * FROM emails WHERE message_id = ?').get('<atomic@example.com>');
  assert.equal(email, undefined, 'email row must not exist after a failed ingest (transaction rolled back)');

  // retrying the same email should now succeed cleanly, proving it wasn't stuck as a phantom duplicate
  const retry = await ingestEmails(db, [{ raw_mime: raw }]);
  assert.equal(retry.results[0].status, 'ingested');

  db.close();
});

test('normalizeUrl strips tracking params, fragment, and trailing slash', () => {
  assert.equal(
    normalizeUrl('https://Example.com/Path/?utm_source=a&utm_medium=b&fbclid=z&keep=1#section'),
    'https://example.com/Path?keep=1'
  );
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
});
