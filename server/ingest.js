const crypto = require('node:crypto');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');

const TRACKING_PARAM_PREFIXES = ['utm_', 'mc_'];
const TRACKING_PARAM_EXACT = new Set([
  'ref',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref_src',
  'ref_url',
  '_hsenc',
  '_hsmi',
]);

function normalizeUrl(rawUrl) {
  const u = new URL(rawUrl);
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM_EXACT.has(key) || TRACKING_PARAM_PREFIXES.some((p) => key.startsWith(p))) {
      u.searchParams.delete(key);
    }
  }
  u.searchParams.sort();
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

const MIME_HEADER_PATTERN =
  /^(From|To|Subject|Date|Message-ID|Content-Type|Content-Transfer-Encoding|MIME-Version|Return-Path|Received|Reply-To|Cc|Bcc|Sender)\s*:/im;

function looksLikeMimeText(text) {
  return MIME_HEADER_PATTERN.test(text);
}

function decodeRawMime(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('raw_mime must be a string (raw MIME text or base64)');
  }
  const trimmed = raw.trim();
  if (looksLikeMimeText(trimmed)) {
    return raw;
  }
  try {
    const decoded = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (looksLikeMimeText(decoded)) {
      return decoded;
    }
  } catch {
    // fall through — treat as raw text below
  }
  return raw;
}

function fallbackMessageId({ fromAddress, subject, body }) {
  const hash = crypto.createHash('sha256');
  hash.update(`${fromAddress || ''}\n${subject || ''}\n${body || ''}`);
  return hash.digest('hex');
}

function extractLinks(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    const text = $(el).text().trim();
    links.push({
      urlOriginal: href,
      urlNormalized: normalizeUrl(href),
      extractedSummary: text || null,
    });
  });
  return links;
}

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
    `INSERT OR IGNORE INTO links (url_normalized, url_original) VALUES (?, ?)`
  );
  const selectLink = db.prepare(`SELECT id FROM links WHERE url_normalized = ?`);
  const insertSource = db.prepare(
    `INSERT OR IGNORE INTO link_sources (link_id, email_id, extracted_summary) VALUES (?, ?, ?)`
  );
  const markProcessed = db.prepare(`UPDATE emails SET processed_at = ? WHERE id = ?`);

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
      insertLink.run(link.urlNormalized, link.urlOriginal);
      const { id: linkId } = selectLink.get(link.urlNormalized);
      insertSource.run(linkId, emailId, link.extractedSummary);
    }
    markProcessed.run(new Date().toISOString(), emailId);

    return { message_id: messageId, status: 'ingested' };
  });

  return ingestTx();
}

async function ingestEmails(db, emails) {
  const results = [];
  for (const email of emails) {
    try {
      results.push(await ingestOne(db, email.raw_mime));
    } catch (err) {
      results.push({ message_id: null, status: 'error', error: err.message });
    }
  }
  return { results };
}

module.exports = { ingestEmails, normalizeUrl };
