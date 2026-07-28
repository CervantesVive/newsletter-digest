# AGENTS.md

## What this is

A personal newsletter triage app that receives raw emails then extracts/dedupes/categorizes/summarizes links into a single feed with dismiss/read/save
actions.

See the Key decisions and Phase notes/gotchas sections below before making architectural
changes.

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
- **The frontend is plain HTML + vanilla JS, no build step, no framework** — uses the
  `public/nocturne/` design system's CSS classes.

## Repo layout

```
server/    Node.js backend (db.js, ingest.js, enrich.js, api.js, config.js)
public/    Frontend (index.html, app.js, nocturne/ design system)
data/      SQLite file (gitignored)
```

## Phase notes / gotchas

- **Phase 1 (`server/db.js`)**: `link_sources`/`link_topics` join-column FKs are declared `NOT NULL`
  (an earlier schema draft left them nullable — this was a deliberate deviation, keep it). `foreign_keys = ON`
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
- **`extractLinks()` boilerplate filter and richer summaries (added post-Phase-6)**: links are
  now dropped before ever reaching the DB if their href or anchor text matches
  `BOILERPLATE_PATTERN` (unsubscribe, manage/change/cancel/leave subscription, edit_subscription,
  view-in-browser/web-version) — this is a deterministic keyword regex, not a classifier, extend
  the pattern if new senders show new footer phrasing, don't build scoring/ML for it. Each kept
  link now produces **two distinct strings**: `headline` (bare anchor text, used for `links.headline`
  seeding — unchanged from before) and `extractedSummary` (the nearest ancestor `<p>`/`<li>` block's
  full text if it's longer than the anchor text, else falls back to the anchor text — used for
  `link_sources.extracted_summary`). Previously these were the same value; don't reintroduce that
  coupling, `ingestOne`'s `insertLink` call must keep using `link.headline`, not
  `link.extractedSummary`, or headlines will regress to full sentence blurbs.
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
  still NULL and should render as "Uncategorized"/ungrouped.**
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
- **Phase 4 (`server/api.js`)**: an early design considered a `type` group option
  (`GET /api/links?group=source|topic|type`), but no `type` column/classification exists anywhere in the
  schema or enrichment output (only multi-valued `topics`) — this was a leftover from the
  original static mockup's taxonomy, not something Phase 1–3 ever built. `group=type`
  (and any value other than `source`/`topic`) intentionally throws a 400
  rather than silently misbehaving; `type` support is deferred, not implemented, until/unless
  a future phase adds a real classification signal for it. `group` is case-insensitive.
  `hideRead` only treats `"true"`/`"1"`/`"yes"` (case-insensitive) as true — everything else,
  including unset, is false; don't "fix" this to `Boolean(hideRead)` since query strings are
  always strings and that would make `?hideRead=false` hide reads. `search` escapes literal
  `%`/`_`/`\` before building the SQL `LIKE` pattern (`ESCAPE '\\'`) so a search for a literal
  `%` doesn't act as a wildcard. `totalCount`/`unreadCount` are always computed over **all**
  non-dismissed links, ignoring `search`/`hideRead` — they're meant as stable nav-bar totals,
  not "N of M results" counts.
- **Phase 5 (`server/api.js` action routes)**: `dismissLink` is one-way (no undismiss route) —
  permanence relies on Phase 2's `INSERT OR IGNORE` never touching an existing row's
  `dismissed` column on re-ingestion, which is covered by an integration test spanning
  `ingest.js` + `api.js`. Single-item `POST /:id/read` and `/:id/mark-saved` **toggle**;
  the bulk variants (`POST /api/links/read`, `/mark-saved`, `/dismiss`, each `{ids: [...]}`)
  are **one-way force-sets to true**, not toggles — deliberately, since toggling a
  multi-select with mixed current states would be ambiguous. Bulk responses return
  `{updated: [{id, <field>: true}, ...]}` (deduped if the request had repeat ids) to keep
  the same per-field boolean shape as the single-item routes — don't regress this back to a
  bare id array, Phase 6's frontend will rely on the field name being present. Toggling
  read/saved-state on an already-`dismissed` link is allowed on purpose (dismiss only ever
  touches the `dismissed` column, and the UI has no path to a dismissed id anyway) — don't
  "fix" this by scoping those routes to `WHERE dismissed = 0`, it's tested as intentional.
- **Phase 6 (`public/index.html`, `public/app.js`)**: full re-fetch-and-rerender on every
  state change (no client-side optimistic updates, no virtual DOM) — simple and correct
  given this app's personal scale, don't add a diffing layer unless real latency becomes a
  problem. Every value interpolated from ingested/LLM content (`headline`, `summary`,
  `topics`, `sources`, `url`) goes through `escapeHtml()` before landing in a template-string
  `innerHTML`, including attribute contexts (`href`, `data-url`, `data-headline`) — this is
  the last line of defense against attacker-controlled forwarded-newsletter content, so any
  new interpolated field must get the same treatment. `href`/Instapaper-URL safety against
  `javascript:` etc. relies entirely on Phase 2's server-side `http:`/`https:` protocol
  filter (`ingest.js`'s `extractLinks`) — there is deliberately no redundant client-side
  scheme check; if any future code path writes `links.url_original` other than through
  `extractLinks`, this protection would need re-verifying. `INSTAPAPER_URL_TEMPLATE` is a
  frontend constant (not a `/api/config` endpoint) — simpler, no extra route needed.
  Single-item `read`/`mark-saved` clicks
  and all four bulk-bar buttons are routed through a shared `runAction()` wrapper that (a)
  serializes actions so a rapid double-click on a *toggle* route can't fire two overlapping
  requests and silently flip the value back to its original state before re-render, and (b)
  catches/report any action failure via a transient status-bar message — don't strip this
  wrapper off new action buttons without re-adding equivalent protection. `group=type` is not
  offered as a frontend option (only Topic/Source buttons) since the API rejects it — see the
  Phase 4 note above.
  **⚠️ UNVERIFIED: the Instapaper `instapaper.com/edit?url=&title=` URL mechanism was never
  smoke-tested against the live site** — this remote dev environment's network policy blocks
  arbitrary outbound hosts (confirmed via `curl`: instapaper.com and google.com both get a
  403/connection-reset from the sandbox's egress proxy), so it could only be verified that the
  frontend builds the documented URL correctly and calls `window.open` — not that Instapaper's
  actual edit page accepts these query params or that the browser-session-cookie auth flow
  (see "Instapaper save is 100% client-side" above) really works. **Whoever deploys this for
  real browser use must manually click "Save to Instapaper" once against the live site
  before trusting it.**
- **Operational logging (`server/logger.js`, instrumentation in `server/ingest.js`/`server/enrich.js`/
  `server/index.js`)**: structured
  JSON logs via winston + winston-daily-rotate-file, `LOG_LEVEL`/`LOG_RETENTION_DAYS`/`LOG_DIR` env vars,
  `data/logs/` gitignored. Two test gotchas worth knowing before touching this: (1) calling winston's
  `.end()` immediately after `.info()`/`.error()` races `winston-daily-rotate-file`'s flush — the write
  can be silently lost even though `'finish'` fires; `server/logger.test.js` polls the log file instead
  of waiting on `.end()`/`'finish'`. (2) `node --test` registers its own `uncaughtException` listener
  before any test file loads, and it unconditionally fails whichever test is running when that event
  fires — so testing `registerCrashHandlers()` (`server/index.js`) via `process.emit('uncaughtException', ...)`
  doesn't work regardless of the handler's own logic. `server/index.test.js` instead spies on `process.on`
  to capture the real registered listener and invokes it directly. `ingest_completed`/`ingest_failed`
  deliberately omit an `emailId` field despite an early instrumentation plan listing one
  (dropped along the way) — no correlation key currently ties an `ingest_completed` log line
  back to a specific email/DB row; documented as a known follow-up in PR #2, not yet fixed.

- **Docker packaging (`Dockerfile`, `.dockerignore`, `deploy/docker-compose.yml`,
  `.github/workflows/publish.yml`)**: multi-stage build on `node:22-bookworm-slim` — a
  glibc base is required, not `-alpine` (musl), since `better-sqlite3` compiles a native
  addon at install time. The build stage needs `python3 make g++` installed via `apt-get`
  (bookworm-slim ships with none of them) or `npm ci` fails with a node-gyp "Could not find
  any Python installation" error; the runtime stage does **not** need these, keep them out
  of it. There's no `/health` endpoint in the app — the Docker `HEALTHCHECK` and the CI
  smoke test both reuse `GET /api/links` (same check the README's manual verification step
  already uses) rather than adding a new route. The deploy host is meant to receive only
  `deploy/docker-compose.yml` + a filled-in `.env` (from `.env.example`), never a git
  clone — `docker-compose.yml`'s `image:` should be pinned to a release tag before real use,
  not left on `:latest`. `publish.yml` triggers on `vX.Y.Z` tag pushes (plus manual
  `workflow_dispatch`) and pushes to `ghcr.io/<owner>/newsletter-digest`, lowercased (GHCR
  rejects uppercase in image paths, hence the `tr '[:upper:]' '[:lower:]'` on
  `github.repository`) — it builds and smoke-tests the image *before* pushing, so a broken
  image never reaches the registry. No auto-update mechanism (e.g. watchtower) is wired up
  by design — updates are a manual `docker compose pull && up -d` on the deploy host.

## Conventions

- Follow the phased approach reflected in the "Phase notes / gotchas" section above; each
  phase gets a failing test before implementation.
- Update this file with new gotchas/decisions as phases complete — keep entries specific ("X silently does Y"), not vague ("be careful with X").
- AGENTS.md is the authoritative agent directives. Only use agent specific files (CLAUDE.md, GEMINI.md, etc) for directives specific to that agent.
