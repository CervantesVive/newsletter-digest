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

## Conventions

- Follow the phased implementation plan in `docs/plan/` in order; each phase gets a failing test before implementation.
- Update this file with new gotchas/decisions as phases complete — keep entries specific ("X silently does Y"), not vague ("be careful with X").
- AGENTS.md is the authoritative agent directives. Only use agent specific files (CLAUDE.md, GEMINI.md, etc) for directives specific to that agent.
