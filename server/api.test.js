const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb } = require('./db');
const { getLinks } = require('./api');
const { ENRICHMENT_SENTINEL } = require('./enrich');

function tmpDb() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-api-test-')), 'digest.sqlite');
  return openDb(dbPath);
}

let emailSeq = 0;
function seedEmail(db, { from = 'Alice', processed = true } = {}) {
  emailSeq += 1;
  const info = db
    .prepare(`INSERT INTO emails (message_id, from_name, from_address, subject, processed_at) VALUES (?, ?, ?, ?, ?)`)
    .run(`msg-${emailSeq}`, from, `${from.toLowerCase()}@example.com`, 'Subj', processed ? new Date().toISOString() : null);
  return info.lastInsertRowid;
}

function seedLink(db, {
  headline = 'Headline',
  summary = null,
  readTime = null,
  read = 0,
  dismissed = 0,
  savedInstapaper = 0,
  enrichedAt = null,
  topics = [],
  sourceEmailIds = [],
  urlOriginal,
} = {}) {
  const url = urlOriginal || `https://example.com/${Math.random()}`;
  const info = db
    .prepare(
      `INSERT INTO links (url_normalized, url_original, headline, summary, read_time, read, dismissed, saved_instapaper, enriched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(url, url, headline, summary, readTime, read, dismissed, savedInstapaper, enrichedAt);
  const linkId = info.lastInsertRowid;
  const emailIds = sourceEmailIds.length ? sourceEmailIds : [seedEmail(db)];
  for (const emailId of emailIds) {
    db.prepare(`INSERT INTO link_sources (link_id, email_id) VALUES (?, ?)`).run(linkId, emailId);
  }
  for (const topic of topics) {
    db.prepare(`INSERT INTO link_topics (link_id, topic) VALUES (?, ?)`).run(linkId, topic);
  }
  return linkId;
}

test('dismissed links never appear regardless of filters', () => {
  const db = tmpDb();
  seedLink(db, { headline: 'Visible' });
  seedLink(db, { headline: 'Gone', dismissed: 1 });

  const result = getLinks(db, {});
  const headlines = result.groups.flatMap((g) => g.items.map((i) => i.headline));
  assert.deepEqual(headlines.sort(), ['Visible']);

  db.close();
});

test('hideRead=true excludes read links; omitted/false includes them', () => {
  const db = tmpDb();
  seedLink(db, { headline: 'Unread' });
  seedLink(db, { headline: 'Read', read: 1 });

  const all = getLinks(db, {});
  assert.deepEqual(
    all.groups.flatMap((g) => g.items.map((i) => i.headline)).sort(),
    ['Read', 'Unread']
  );

  const hidden = getLinks(db, { hideRead: 'true' });
  assert.deepEqual(
    hidden.groups.flatMap((g) => g.items.map((i) => i.headline)),
    ['Unread']
  );

  db.close();
});

test('search matches headline, summary, topic, and source name (case-insensitive)', () => {
  const db = tmpDb();
  seedLink(db, { headline: 'Aggregation theory revisited', summary: 'about platforms' });
  seedLink(db, { headline: 'Nothing related', summary: 'a summary mentioning STRATEGY here', topics: ['strategy'] });
  seedLink(db, { headline: 'Another one', topics: ['ai'] });
  seedLink(db, { headline: 'From Bob', sourceEmailIds: [seedEmail(db, { from: 'Bob Thompson' })] });

  const byHeadline = getLinks(db, { search: 'aggregation' });
  assert.deepEqual(byHeadline.groups.flatMap((g) => g.items.map((i) => i.headline)), ['Aggregation theory revisited']);

  const byTopic = getLinks(db, { search: 'strategy' });
  assert.ok(byTopic.groups.flatMap((g) => g.items.map((i) => i.headline)).includes('Nothing related'));

  const bySource = getLinks(db, { search: 'bob' });
  assert.deepEqual(bySource.groups.flatMap((g) => g.items.map((i) => i.headline)), ['From Bob']);

  db.close();
});

test('group=source: a link with multiple sources appears in each source group', () => {
  const db = tmpDb();
  const emailA = seedEmail(db, { from: 'Alice' });
  const emailB = seedEmail(db, { from: 'Bob' });
  seedLink(db, { headline: 'Shared', sourceEmailIds: [emailA, emailB] });
  seedLink(db, { headline: 'Alice only', sourceEmailIds: [seedEmail(db, { from: 'Alice' })] });

  const result = getLinks(db, { group: 'source' });
  const byGroup = Object.fromEntries(result.groups.map((g) => [g.name, g.items.map((i) => i.headline).sort()]));
  assert.deepEqual(byGroup.Alice.sort(), ['Alice only', 'Shared']);
  assert.deepEqual(byGroup.Bob, ['Shared']);

  db.close();
});

test('group=topic: links without any topic land in an Uncategorized group', () => {
  const db = tmpDb();
  seedLink(db, { headline: 'Tagged', topics: ['ai', 'business'] });
  seedLink(db, { headline: 'Untagged' });
  seedLink(db, { headline: 'Gave up', enrichedAt: ENRICHMENT_SENTINEL });

  const result = getLinks(db, { group: 'topic' });
  const byGroup = Object.fromEntries(result.groups.map((g) => [g.name, g.items.map((i) => i.headline).sort()]));
  assert.deepEqual(byGroup.ai, ['Tagged']);
  assert.deepEqual(byGroup.business, ['Tagged']);
  assert.deepEqual(byGroup.Uncategorized.sort(), ['Gave up', 'Untagged']);

  db.close();
});

test('an unsupported group value (e.g. "type") throws a descriptive error rather than silently misbehaving', () => {
  const db = tmpDb();
  seedLink(db, { headline: 'X' });

  assert.throws(() => getLinks(db, { group: 'type' }), /group/i);

  db.close();
});

test('unreadCount/totalCount reflect all non-dismissed links, unaffected by search/hideRead', () => {
  const db = tmpDb();
  seedLink(db, { headline: 'A', read: 0 });
  seedLink(db, { headline: 'B', read: 1 });
  seedLink(db, { headline: 'C', read: 0, dismissed: 1 });

  const result = getLinks(db, { search: 'nonexistent-term', hideRead: 'true' });
  assert.equal(result.totalCount, 2);
  assert.equal(result.unreadCount, 1);

  db.close();
});

test('each item exposes multiple sources and topics without collapsing them', () => {
  const db = tmpDb();
  const emailA = seedEmail(db, { from: 'Alice' });
  const emailB = seedEmail(db, { from: 'Bob' });
  seedLink(db, {
    headline: 'Multi',
    topics: ['ai', 'business'],
    sourceEmailIds: [emailA, emailB],
  });

  const result = getLinks(db, {});
  const item = result.groups.flatMap((g) => g.items).find((i) => i.headline === 'Multi');
  assert.deepEqual(item.topics.sort(), ['ai', 'business']);
  assert.deepEqual(item.sources.sort(), ['Alice', 'Bob']);

  db.close();
});

test('hideRead accepts common truthy encodings (1, TRUE) and treats malformed values as false', () => {
  const db = tmpDb();
  seedLink(db, { headline: 'Unread' });
  seedLink(db, { headline: 'Read', read: 1 });

  for (const value of ['1', 'TRUE', 'True']) {
    const result = getLinks(db, { hideRead: value });
    assert.deepEqual(
      result.groups.flatMap((g) => g.items.map((i) => i.headline)),
      ['Unread'],
      `hideRead=${value} should hide read links`
    );
  }

  for (const value of ['', 'false', 'nonsense']) {
    const result = getLinks(db, { hideRead: value });
    assert.deepEqual(
      result.groups.flatMap((g) => g.items.map((i) => i.headline)).sort(),
      ['Read', 'Unread'],
      `hideRead=${JSON.stringify(value)} should not hide read links`
    );
  }

  db.close();
});

test('group is case-insensitive ("Source" behaves like "source")', () => {
  const db = tmpDb();
  seedLink(db, { headline: 'X', sourceEmailIds: [seedEmail(db, { from: 'Alice' })] });

  const result = getLinks(db, { group: 'Source' });
  assert.ok(result.groups.some((g) => g.name === 'Alice'));

  db.close();
});

test('a search term containing literal LIKE wildcards (%, _) is matched literally, not as a wildcard', () => {
  const db = tmpDb();
  seedLink(db, { headline: '50% off widgets' });
  seedLink(db, { headline: 'totally unrelated headline' });

  const result = getLinks(db, { search: '50%' });
  assert.deepEqual(
    result.groups.flatMap((g) => g.items.map((i) => i.headline)),
    ['50% off widgets']
  );

  db.close();
});

test('a gave_up (sentinel) link is included in results but reports as not enriched', () => {
  const db = tmpDb();
  seedLink(db, { headline: 'Stuck', enrichedAt: ENRICHMENT_SENTINEL });

  const result = getLinks(db, {});
  const item = result.groups.flatMap((g) => g.items).find((i) => i.headline === 'Stuck');
  assert.equal(item.enriched, false);

  db.close();
});
