const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb } = require('./db');
const { runEnrichmentPass, ENRICHMENT_SENTINEL } = require('./enrich');

function tmpDb() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-enrich-test-')), 'digest.sqlite');
  return openDb(dbPath);
}

// Seeds an email + link + link_source directly (bypassing ingest.js) so enrichment tests
// are isolated from ingestion behavior.
function seedLink(db, { processed = true, headline = 'Some Headline', sources = [{ from: 'Alice', summary: 'a blurb' }] } = {}) {
  const emailIds = sources.map((s, i) => {
    const info = db
      .prepare(
        `INSERT INTO emails (message_id, from_name, from_address, subject, processed_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(`msg-${Math.random()}-${i}`, s.from, `${s.from.toLowerCase()}@example.com`, 'Subj', processed ? new Date().toISOString() : null);
    return info.lastInsertRowid;
  });
  const linkInfo = db
    .prepare(`INSERT INTO links (url_normalized, url_original, headline) VALUES (?, ?, ?)`)
    .run(`https://example.com/${Math.random()}`, 'https://example.com/x', headline);
  const linkId = linkInfo.lastInsertRowid;
  sources.forEach((s, i) => {
    db.prepare(`INSERT INTO link_sources (link_id, email_id, extracted_summary) VALUES (?, ?, ?)`).run(
      linkId,
      emailIds[i],
      s.summary ?? null
    );
  });
  return linkId;
}

function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (req) => {
          calls.push(req);
          return responder(req, calls.length);
        },
      },
    },
  };
}

function jsonResponse(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

test('enriches a single-source link and upserts topics', async () => {
  const db = tmpDb();
  const linkId = seedLink(db, { sources: [{ from: 'Alice', summary: 'AI news roundup' }] });

  const client = fakeClient(() => jsonResponse({ summary: 'A great summary', topics: ['ai', 'news'], read_time: 4 }));

  await runEnrichmentPass(db, { client, model: 'test-model' });

  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(linkId);
  assert.equal(link.summary, 'A great summary');
  assert.equal(link.read_time, 4);
  assert.ok(link.enriched_at);

  const topics = db.prepare('SELECT topic FROM link_topics WHERE link_id = ? ORDER BY topic').all(linkId).map((r) => r.topic);
  assert.deepEqual(topics, ['ai', 'news']);

  db.close();
});

test('single source with an extracted summary: prompt tells the model to use it directly, not synthesize', async () => {
  const db = tmpDb();
  seedLink(db, { sources: [{ from: 'Alice', summary: 'The one and only excerpt' }] });

  const client = fakeClient(() => jsonResponse({ summary: 'x', topics: [], read_time: 1 }));
  await runEnrichmentPass(db, { client, model: 'test-model' });

  const userMessage = client.calls[0].messages.find((m) => m.role === 'user').content;
  assert.match(userMessage, /The one and only excerpt/);
  assert.doesNotMatch(userMessage, /synthesize/i);

  db.close();
});

test('multi-source link: prompt includes all extracted summaries and asks the model to synthesize', async () => {
  const db = tmpDb();
  seedLink(db, {
    sources: [
      { from: 'Alice', summary: 'First excerpt about the topic' },
      { from: 'Bob', summary: 'Second excerpt, different wording' },
    ],
  });

  const client = fakeClient(() => jsonResponse({ summary: 'combined', topics: ['ai'], read_time: 2 }));
  await runEnrichmentPass(db, { client, model: 'test-model' });

  const userMessage = client.calls[0].messages.find((m) => m.role === 'user').content;
  assert.match(userMessage, /First excerpt about the topic/);
  assert.match(userMessage, /Second excerpt, different wording/);
  assert.match(userMessage, /synthesize/i);

  db.close();
});

test('links with no source having processed_at set are skipped entirely', async () => {
  const db = tmpDb();
  const linkId = seedLink(db, { processed: false });

  const client = fakeClient(() => jsonResponse({ summary: 'nope', topics: [], read_time: 1 }));
  await runEnrichmentPass(db, { client, model: 'test-model' });

  assert.equal(client.calls.length, 0);
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(linkId);
  assert.equal(link.enriched_at, null);

  db.close();
});

test('already-enriched links are not re-processed', async () => {
  const db = tmpDb();
  const linkId = seedLink(db);
  db.prepare('UPDATE links SET enriched_at = ? WHERE id = ?').run(new Date().toISOString(), linkId);

  const client = fakeClient(() => jsonResponse({ summary: 'nope', topics: [], read_time: 1 }));
  await runEnrichmentPass(db, { client, model: 'test-model' });

  assert.equal(client.calls.length, 0);
  db.close();
});

test('failure increments enrich_attempts and retries on the next pass', async () => {
  const db = tmpDb();
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

  db.close();
});

test('after maxAttempts consecutive failures, enriched_at is set to a sentinel and the link stops being retried', async () => {
  const db = tmpDb();
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

  db.close();
});

test('malformed (non-JSON, or wrong-shaped JSON) LLM responses are treated as failures, not crashes', async () => {
  const db = tmpDb();
  const linkId = seedLink(db);

  const client = fakeClient(() => ({ choices: [{ message: { content: 'not json at all' } }] }));
  await runEnrichmentPass(db, { client, model: 'test-model' });

  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(linkId);
  assert.equal(link.enrich_attempts, 1);
  assert.equal(link.enriched_at, null);

  db.close();
});

test('bounded concurrency: no more than `concurrency` LLM calls are in flight at once', async () => {
  const db = tmpDb();
  for (let i = 0; i < 6; i++) seedLink(db);

  let inFlight = 0;
  let maxInFlight = 0;
  const client = fakeClient(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return jsonResponse({ summary: 's', topics: [], read_time: 1 });
  });

  await runEnrichmentPass(db, { client, model: 'test-model', concurrency: 2 });

  assert.ok(maxInFlight <= 2, `expected max 2 concurrent calls, got ${maxInFlight}`);
  assert.equal(client.calls.length, 6);

  db.close();
});

test('overlapping runEnrichmentPass calls do not double-process the same link', async () => {
  const db = tmpDb();
  const linkId = seedLink(db);

  let callCount = 0;
  const client = fakeClient(async () => {
    callCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse({ summary: 's', topics: [], read_time: 1 });
  });

  // Fire two passes concurrently, simulating an interval tick racing a second trigger.
  await Promise.all([
    runEnrichmentPass(db, { client, model: 'test-model' }),
    runEnrichmentPass(db, { client, model: 'test-model' }),
  ]);

  assert.equal(callCount, 1, 'the link must only be claimed and processed by one of the two overlapping passes');
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(linkId);
  assert.ok(link.enriched_at);

  db.close();
});

test('topics are normalized: trimmed, lowercased, empty/duplicate entries dropped', async () => {
  const db = tmpDb();
  const linkId = seedLink(db);

  const client = fakeClient(() =>
    jsonResponse({ summary: 's', topics: [' AI ', 'ai', '', '   ', 'News'], read_time: 1 })
  );
  await runEnrichmentPass(db, { client, model: 'test-model' });

  const topics = db.prepare('SELECT topic FROM link_topics WHERE link_id = ? ORDER BY topic').all(linkId).map((r) => r.topic);
  assert.deepEqual(topics, ['ai', 'news']);

  db.close();
});

test('one failing link in a batch does not stop the others from being enriched', async () => {
  const db = tmpDb();
  const failId = seedLink(db, { headline: 'Fails' });
  const okId = seedLink(db, { headline: 'Succeeds' });

  const client = fakeClient((req) => {
    if (req.messages.some((m) => m.content.includes('Fails'))) {
      throw new Error('boom');
    }
    return jsonResponse({ summary: 'ok', topics: [], read_time: 1 });
  });

  await runEnrichmentPass(db, { client, model: 'test-model' });

  const failLink = db.prepare('SELECT * FROM links WHERE id = ?').get(failId);
  const okLink = db.prepare('SELECT * FROM links WHERE id = ?').get(okId);
  assert.equal(failLink.enriched_at, null);
  assert.equal(failLink.enrich_attempts, 1);
  assert.ok(okLink.enriched_at);
  assert.equal(okLink.summary, 'ok');

  db.close();
});
