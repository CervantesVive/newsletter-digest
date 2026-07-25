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

## Conventions

- Follow the phased implementation plan in `docs/plan/` in order; each phase gets a failing test before implementation.
- Update this file with new gotchas/decisions as phases complete — keep entries specific ("X silently does Y"), not vague ("be careful with X").
- AGENTS.md is the authoritative agent directives. Only use agent specific files (CLAUDE.md, GEMINI.md, etc) for directives specific to that agent.
