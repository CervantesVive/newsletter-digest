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

function dismissLink(db, id) {
  const info = db.prepare('UPDATE links SET dismissed = 1 WHERE id = ?').run(id);
  if (info.changes === 0) return null;
  return { id, dismissed: true };
}

function toggleRead(db, id) {
  const link = db.prepare('SELECT read FROM links WHERE id = ?').get(id);
  if (!link) return null;
  const next = link.read ? 0 : 1;
  db.prepare('UPDATE links SET read = ? WHERE id = ?').run(next, id);
  return { id, read: Boolean(next) };
}

function toggleSaved(db, id) {
  const link = db.prepare('SELECT saved_instapaper FROM links WHERE id = ?').get(id);
  if (!link) return null;
  const next = link.saved_instapaper ? 0 : 1;
  db.prepare('UPDATE links SET saved_instapaper = ? WHERE id = ?').run(next, id);
  return { id, savedInstapaper: Boolean(next) };
}

function bulkSetColumn(db, ids, column, field) {
  const uniqueIds = [...new Set(ids)];
  const stmt = db.prepare(`UPDATE links SET ${column} = 1 WHERE id = ?`);
  const tx = db.transaction((idList) => idList.map((id) => stmt.run(id).changes > 0));
  const applied = tx(uniqueIds);
  const updated = uniqueIds.filter((_, i) => applied[i]).map((id) => ({ id, [field]: true }));
  return { updated };
}

function bulkDismiss(db, ids) {
  return bulkSetColumn(db, ids, 'dismissed', 'dismissed');
}

function bulkMarkRead(db, ids) {
  return bulkSetColumn(db, ids, 'read', 'read');
}

function bulkMarkSaved(db, ids) {
  return bulkSetColumn(db, ids, 'saved_instapaper', 'savedInstapaper');
}

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'id must be a positive integer' });
    return null;
  }
  return id;
}

function parseIds(req, res) {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Number.isInteger(id) && id > 0)) {
    res.status(400).json({ error: 'body must be { ids: [<positive integer>, ...] }' });
    return null;
  }
  return ids;
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

  router.post('/api/links/:id/dismiss', (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const result = dismissLink(db, id);
    if (!result) return res.status(404).json({ error: 'link not found' });
    res.json(result);
  });

  router.post('/api/links/:id/read', (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const result = toggleRead(db, id);
    if (!result) return res.status(404).json({ error: 'link not found' });
    res.json(result);
  });

  router.post('/api/links/:id/mark-saved', (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const result = toggleSaved(db, id);
    if (!result) return res.status(404).json({ error: 'link not found' });
    res.json(result);
  });

  router.post('/api/links/dismiss', (req, res) => {
    const ids = parseIds(req, res);
    if (ids === null) return;
    res.json(bulkDismiss(db, ids));
  });

  router.post('/api/links/read', (req, res) => {
    const ids = parseIds(req, res);
    if (ids === null) return;
    res.json(bulkMarkRead(db, ids));
  });

  router.post('/api/links/mark-saved', (req, res) => {
    const ids = parseIds(req, res);
    if (ids === null) return;
    res.json(bulkMarkSaved(db, ids));
  });

  return router;
}

module.exports = {
  getLinks,
  createReadRoutes,
  dismissLink,
  toggleRead,
  toggleSaved,
  bulkDismiss,
  bulkMarkRead,
  bulkMarkSaved,
};
