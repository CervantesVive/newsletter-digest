# AGENTS.md

## What this is

A personal newsletter triage app that receives raw emails then extracts/dedupes/categorizes/summarizes links into a single feed with dismiss/read/save
actions.

Full design and phased implementation plan:
`docs/plan/2026-07-25-newsletter-digest-design.md` — read it before making architectural
changes. It has the SQLite schema, ingestion/enrichment flows, API surface, and repo layout.

## Key decisions (don't re-derive these)

- **This service does not retrieve email.** Retrieval is a pluggable port — never build
  IMAP/retrieval logic into this service.
- **Single Node.js process**, SQLite via `better-sqlite3` (synchronous — this is what makes
  concurrent `/ingest` POSTs safe without an explicit lock; don't switch to an async SQLite
  driver without re-adding write serialization).
- **No app-level auth.** Don't add a login system unless the access model changes.
- **LLM calls go through an OpenAI-compatible client** configured via env vars pointed - never hardcode a specific LLM provider/SDK.
- **Instapaper save is 100% client-side.** A configurable URL template
  (`instapaper.com/edit?url=&title=`) opened via `window.open`; auth rides the browser's
  existing Instapaper session cookie. No credentials are ever stored server-side. This URL
  mechanism is unverified against the live site — treat it as needing a real smoke test,
  not an assumption.
- **Dismiss is permanent per URL**, not per newsletter mention — a dismissed link stays
  dismissed even if a later newsletter cites the same URL again.
- **A link can have multiple sources and multiple topics** (`link_sources`, `link_topics`
  join tables) — don't collapse these back to single-value columns.
- **The frontend is plain HTML + vanilla JS, no build step, no framework** — reuses the
  `nocturne/` design system's CSS classes and `NewsletterDigest.dc.html`'s markup as a
  structural reference, but that `.dc.html` file itself (and `support.js`) is a
  prototyping-tool preview runtime, not production code — don't extend it, replace it.

## Repo layout

```
server/    Node.js backend (db.js, ingest.js, enrich.js, api.js, config.js)
public/    Frontend (index.html, app.js, nocturne/ design system)
data/      SQLite file (gitignored)
docs/plan/ Design docs and implementation plans
```

## Phase notes / gotchas

- **Phase 1 (`server/db.js`)**: `link_sources`/`link_topics` join-column FKs are declared `NOT NULL`
  (design doc's SQL leaves them nullable — deviation is intentional, keep it). `foreign_keys = ON`
  is a per-connection pragma, not persisted in the DB file — every `openDb()` call sets it before
  running the schema, and it's covered by a test that inserts a dangling FK and expects rejection;
  don't refactor `openDb()` in a way that opens a raw `Database()` without that pragma. WAL mode is
  also verified by a real test (`db.pragma('journal_mode', {simple:true})`), not assumed. No
  `ON DELETE` behavior is defined anywhere (nothing in the app ever deletes emails/links rows today
  — dismiss is a flag) — if a future retention/cleanup job needs to delete old rows, decide
  cascade/restrict behavior then, don't assume `NO ACTION` will do the right thing.
- **Phase 2 (`server/ingest.js`, `server/index.js`)**: `raw_mime` may be raw MIME text or
  base64 per the ingestion port contract; detection checks for known MIME header names
  anywhere in the text (multiline regex), not just a header-shaped first line — an mbox-style
  `From alice@x Mon Jan 1...` envelope line (no colon) as the first line is common from some
  retrievers and must not be misdetected as base64. `ingestOne`'s email insert, link/link_sources
  writes, and `processed_at` update are one `db.transaction()` — if anything throws partway,
  the whole email rolls back so a redelivery isn't permanently treated as a duplicate of a
  half-processed row. `node --test <directory>` (as opposed to an explicit glob) requires
  **every** `.js` file in that directory as a test file, including `index.js` — which then runs
  its `require.main === module` startup code and hangs listening on a real port. `npm test`
  must stay pinned to `node --test server/*.test.js` (or another explicit test-file list), never
  a bare directory path. URL normalization strips `utm_*`/`mc_*`-prefixed and a fixed set of known
  tracking params (`ref`, `fbclid`, `gclid`, etc.), the fragment, and a trailing slash (except
  root `/`) — extend the tracking-param list here if new newsletter senders show up with other
  tracking params, don't scope-creep into a full tracking-param database.
- **`links.headline`** is seeded from the anchor's own link text on first-insert only
  (`INSERT OR IGNORE` protects it from being clobbered by later re-mentions of the same
  URL). There's no page-fetching in this app, so anchor text is the only title-like signal
  available at ingest time — the enrichment LLM call (Phase 3) consumes this as-is, it does
  not currently rewrite/improve the headline itself, only `summary`/`topics`/`read_time`.
- **Phase 3 (`server/enrich.js`, `server/config.js`)**: `links.enriched_at` is tri-state, not
  binary — `NULL` (pending), a real ISO datetime (enriched), or the literal string
  `'gave_up'` (`ENRICHMENT_SENTINEL`, exported from `enrich.js`) after `enrich_attempts`
  hits `ENRICHMENT_MAX_ATTEMPTS` failures. **Phase 4's read API must not treat
  `enriched_at IS NOT NULL` as "has a summary" — a gave-up link has `summary`/`read_time`
  still NULL and should render as "Uncategorized"/ungrouped, matching the design doc.**
  `runEnrichmentPass` guards itself against double-processing the same link if two passes
  overlap in the same process (a module-level in-flight `Set`, since this app is
  single-process by design — see the ingestion note above; it does not defend against a
  second OS process, which the architecture doesn't support anyway). The LLM client is
  injected (`{client, model}`), never constructed inside `enrich.js` itself — `server/index.js`
  builds the real `openai`-package client pointed at `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`
  env vars, and the enrichment loop is simply disabled (with a startup warning) if
  `LLM_BASE_URL`/`LLM_MODEL` aren't set, rather than crashing. Topics from the LLM are
  trimmed/lowercased/deduped before insert — don't assume `link_topics.topic` preserves the
  LLM's original casing.
- **Phase 4 (`server/api.js`)**: the design doc's `GET /api/links?group=source|topic|type`
  mentions a `type` group option, but no `type` column/classification exists anywhere in the
  schema or enrichment output (only multi-valued `topics`) — this was a leftover from the
  original static mockup's taxonomy (see `newsletter-data.js`), not something Phase 1–3 ever
  built. `group=type` (and any value other than `source`/`topic`) intentionally throws a 400
  rather than silently misbehaving; `type` support is deferred, not implemented, until/unless
  a future phase adds a real classification signal for it. `group` is case-insensitive.
  `hideRead` only treats `"true"`/`"1"`/`"yes"` (case-insensitive) as true — everything else,
  including unset, is false; don't "fix" this to `Boolean(hideRead)` since query strings are
  always strings and that would make `?hideRead=false` hide reads. `search` escapes literal
  `%`/`_`/`\` before building the SQL `LIKE` pattern (`ESCAPE '\\'`) so a search for a literal
  `%` doesn't act as a wildcard. `totalCount`/`unreadCount` are always computed over **all**
  non-dismissed links, ignoring `search`/`hideRead` — they're meant as stable nav-bar totals,
  not "N of M results" counts.

## Conventions

- Follow the phased implementation plan in `docs/plan/` in order; each phase gets a failing test before implementation.
- Update this file with new gotchas/decisions as phases complete — keep entries specific ("X silently does Y"), not vague ("be careful with X").
- AGENTS.md is the authoritative agent directives. Only use agent specific files (CLAUDE.md, GEMINI.md, etc) for directives specific to that agent.
