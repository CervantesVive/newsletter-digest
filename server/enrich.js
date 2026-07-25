const ENRICHMENT_SENTINEL = 'gave_up';

// This app is architected as a single Node process (see AGENTS.md), so the only realistic
// way runEnrichmentPass could overlap itself is a bug in this same process (e.g. two
// startEnrichmentLoop timers, or a manual trigger racing the interval) — not a second OS
// process. A module-level in-flight set is sufficient to make that safe: it stops two
// concurrent passes from both selecting and double-processing the same link (duplicate
// LLM calls, duplicate writes), without needing cross-process locking machinery this app
// doesn't otherwise have.
const inFlightLinkIds = new Set();

function selectPendingLinks(db) {
  return db
    .prepare(
      `SELECT DISTINCT links.* FROM links
       JOIN link_sources ON link_sources.link_id = links.id
       JOIN emails ON emails.id = link_sources.email_id
       WHERE links.enriched_at IS NULL AND emails.processed_at IS NOT NULL`
    )
    .all();
}

function selectSources(db, linkId) {
  return db
    .prepare(
      `SELECT emails.from_name, emails.from_address, link_sources.extracted_summary
       FROM link_sources
       JOIN emails ON emails.id = link_sources.email_id
       WHERE link_sources.link_id = ?`
    )
    .all(linkId)
    .map((row) => ({
      sourceName: row.from_name || row.from_address || 'unknown source',
      extractedSummary: row.extracted_summary,
    }));
}

function buildMessages(link, sources) {
  const withSummary = sources.filter((s) => s.extractedSummary);
  const sourceNames = [...new Set(sources.map((s) => s.sourceName))];

  let instruction;
  if (withSummary.length === 0) {
    instruction =
      'No extracted excerpt text is available for this link. Use only the headline and source names to write a concise, honest summary — do not fabricate specifics you cannot support.';
  } else if (withSummary.length === 1) {
    instruction =
      'Use the single extracted excerpt below directly as the basis for the summary — do not invent details beyond what it says.';
  } else {
    instruction =
      'Synthesize one final summary from the following extracted excerpts, grounded in their text — do not invent details beyond what they say.';
  }

  const excerpts = withSummary
    .map((s, i) => `Excerpt ${i + 1} (from ${s.sourceName}): ${s.extractedSummary}`)
    .join('\n');

  const userContent = [
    `Headline: ${link.headline || '(none)'}`,
    `Source names: ${sourceNames.join(', ')}`,
    instruction,
    excerpts,
    'Respond with strict JSON only, no markdown fences: {"summary": string, "topics": string[], "read_time": integer minutes}.',
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    {
      role: 'system',
      content:
        'You summarize and topic-classify links shared in newsletters for a personal reading digest. Always respond with strict JSON matching the requested shape.',
    },
    { role: 'user', content: userContent },
  ];
}

function parseLlmResponse(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LLM response missing choices[0].message.content');
  }
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('LLM response was not valid JSON');
  }
  if (
    typeof parsed.summary !== 'string' ||
    !Array.isArray(parsed.topics) ||
    !parsed.topics.every((t) => typeof t === 'string') ||
    typeof parsed.read_time !== 'number'
  ) {
    throw new Error('LLM response JSON did not match the expected {summary, topics, read_time} shape');
  }
  return parsed;
}

async function callLlm(client, model, link, sources) {
  const messages = buildMessages(link, sources);
  const response = await client.chat.completions.create({ model, messages });
  return parseLlmResponse(response);
}

function persistSuccess(db, linkId, parsed) {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE links SET summary = ?, read_time = ?, enriched_at = ? WHERE id = ?`).run(
      parsed.summary,
      parsed.read_time,
      new Date().toISOString(),
      linkId
    );
    const upsertTopic = db.prepare(`INSERT OR IGNORE INTO link_topics (link_id, topic) VALUES (?, ?)`);
    const seen = new Set();
    for (const topic of parsed.topics) {
      const normalized = topic.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      upsertTopic.run(linkId, normalized);
    }
  });
  tx();
}

function persistFailure(db, linkId, maxAttempts) {
  const tx = db.transaction(() => {
    const { enrich_attempts: prevAttempts } = db.prepare('SELECT enrich_attempts FROM links WHERE id = ?').get(linkId);
    const attempts = prevAttempts + 1;
    if (attempts >= maxAttempts) {
      db.prepare('UPDATE links SET enrich_attempts = ?, enriched_at = ? WHERE id = ?').run(
        attempts,
        ENRICHMENT_SENTINEL,
        linkId
      );
    } else {
      db.prepare('UPDATE links SET enrich_attempts = ? WHERE id = ?').run(attempts, linkId);
    }
  });
  tx();
}

async function enrichAndPersist(db, client, model, link, maxAttempts) {
  const sources = selectSources(db, link.id);
  try {
    const parsed = await callLlm(client, model, link, sources);
    persistSuccess(db, link.id, parsed);
    return { linkId: link.id, status: 'enriched' };
  } catch (err) {
    persistFailure(db, link.id, maxAttempts);
    return { linkId: link.id, status: 'failed', error: err.message };
  } finally {
    inFlightLinkIds.delete(link.id);
  }
}

async function runEnrichmentPass(db, { client, model, concurrency = 3, maxAttempts = 5 }) {
  const pending = selectPendingLinks(db).filter((link) => !inFlightLinkIds.has(link.id));
  pending.forEach((link) => inFlightLinkIds.add(link.id));
  let cursor = 0;
  const results = [];

  async function worker() {
    while (cursor < pending.length) {
      const link = pending[cursor];
      cursor += 1;
      results.push(await enrichAndPersist(db, client, model, link, maxAttempts));
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, pending.length));
  if (pending.length === 0) return results;
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function startEnrichmentLoop(db, { client, model, intervalMs = 30000, concurrency = 3, maxAttempts = 5 }) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runEnrichmentPass(db, { client, model, concurrency, maxAttempts });
    } catch (err) {
      console.error('enrichment pass failed:', err);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

module.exports = {
  runEnrichmentPass,
  startEnrichmentLoop,
  buildMessages,
  parseLlmResponse,
  ENRICHMENT_SENTINEL,
};
