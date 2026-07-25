const express = require('express');
const { ENRICHMENT_SENTINEL } = require('./enrich');

const VALID_GROUPS = new Set(['source', 'topic']);
const UNCATEGORIZED = 'Uncategorized';

function selectFilteredLinks(db, { search, hideRead }) {
  const conditions = ['dismissed = 0'];
  const params = {};

  if (hideRead) {
    conditions.push('read = 0');
  }

  if (search) {
    const escaped = search.toLowerCase().replace(/[%_\\]/g, '\\$&');
    params.search = `%${escaped}%`;
    conditions.push(`(
      lower(coalesce(headline, '')) LIKE @search ESCAPE '\\'
      OR lower(coalesce(summary, '')) LIKE @search ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM link_topics
        WHERE link_topics.link_id = links.id AND lower(link_topics.topic) LIKE @search ESCAPE '\\'
      )
      OR EXISTS (
        SELECT 1 FROM link_sources
        JOIN emails ON emails.id = link_sources.email_id
        WHERE link_sources.link_id = links.id
          AND (lower(coalesce(emails.from_name, '')) LIKE @search ESCAPE '\\' OR lower(coalesce(emails.from_address, '')) LIKE @search ESCAPE '\\')
      )
    )`);
  }

  const sql = `SELECT * FROM links WHERE ${conditions.join(' AND ')} ORDER BY links.id DESC`;
  return db.prepare(sql).all(params);
}

function attachSourcesAndTopics(db, link) {
  const topics = db
    .prepare(`SELECT topic FROM link_topics WHERE link_id = ? ORDER BY topic`)
    .all(link.id)
    .map((row) => row.topic);

  const sources = db
    .prepare(
      `SELECT DISTINCT coalesce(emails.from_name, emails.from_address) AS name
       FROM link_sources
       JOIN emails ON emails.id = link_sources.email_id
       WHERE link_sources.link_id = ?
       ORDER BY name`
    )
    .all(link.id)
    .map((row) => row.name);

  return {
    id: link.id,
    url: link.url_original,
    headline: link.headline,
    summary: link.summary,
    readTime: link.read_time,
    read: Boolean(link.read),
    dismissed: Boolean(link.dismissed),
    savedInstapaper: Boolean(link.saved_instapaper),
    enriched: link.enriched_at !== null && link.enriched_at !== ENRICHMENT_SENTINEL,
    gaveUp: link.enriched_at === ENRICHMENT_SENTINEL,
    topics,
    sources,
  };
}

function groupItems(items, groupBy) {
  const buckets = new Map();

  const addTo = (name, item) => {
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(item);
  };

  for (const item of items) {
    if (groupBy === 'source') {
      item.sources.forEach((name) => addTo(name, item));
    } else if (groupBy === 'topic') {
      if (item.topics.length === 0) {
        addTo(UNCATEGORIZED, item);
      } else {
        item.topics.forEach((topic) => addTo(topic, item));
      }
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED) return -1;
      return a.localeCompare(b);
    })
    .map(([name, groupItemsList]) => ({ name, count: groupItemsList.length, items: groupItemsList }));
}

const TRUTHY_VALUES = new Set(['true', '1', 'yes']);

function getLinks(db, { search, group, hideRead } = {}) {
  const groupBy = group === undefined ? 'source' : typeof group === 'string' ? group.toLowerCase() : group;
  if (!VALID_GROUPS.has(groupBy)) {
    throw new Error(
      `Unsupported group value "${group}" — must be one of: ${[...VALID_GROUPS].join(', ')}`
    );
  }

  const hideReadBool = typeof hideRead === 'string' && TRUTHY_VALUES.has(hideRead.toLowerCase());
  const normalizedSearch = typeof search === 'string' ? search.trim() : '';

  const rows = selectFilteredLinks(db, { search: normalizedSearch, hideRead: hideReadBool });
  const items = rows.map((row) => attachSourcesAndTopics(db, row));

  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM links WHERE dismissed = 0`).get();
  const unreadRow = db.prepare(`SELECT COUNT(*) AS c FROM links WHERE dismissed = 0 AND read = 0`).get();

  return {
    groups: groupItems(items, groupBy),
    totalCount: totalRow.c,
    unreadCount: unreadRow.c,
  };
}

function createReadRoutes(db) {
  const router = express.Router();

  router.get('/api/links', (req, res) => {
    try {
      const { search, group, hideRead } = req.query;
      const result = getLinks(db, { search, group, hideRead });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { getLinks, createReadRoutes };
