# Operational Logging — Design

## Purpose

This service has no structured logging today — a handful of scattered
`console.log`/`console.warn`/`console.error` calls (`server/index.js`,
`server/enrich.js`). Ingest failures aren't logged at all (the transaction
just rolls back). Enrichment failures log a single generic string. There is
no way to know, after the fact, why an email failed to ingest, why a link
gave up enrichment, or whether the enrichment loop silently stopped making
progress.

Treat this app as a service: structured (JSON) logs, rotated daily, retained
for a configurable period, with a clean seam to plug in real-time alerting
later (Slack/email/push) once it's clear which events actually deserve to
page someone. Alerting itself is explicitly out of scope for this phase.

## Scope

Covers:
- Application errors and crashes (ingest failures, enrichment failures,
  unhandled exceptions/rejections).
- Health signals with no exception today (enrichment loop stalling).
- Data-quality signals (a link exhausting enrichment attempts and hitting
  `gave_up`).
- Basic HTTP access logging for correlating API errors with frontend activity.

Out of scope: any outbound alerting integration (Slack/email/push/webhook).
The design leaves an explicit extension point for this but does not
implement it.

## Library choice

**winston + winston-daily-rotate-file.** Two new dependencies. Chosen over a
hand-rolled `fs`-based logger because the user wants this treated as a real
service with built-in rotation (`datePattern`) and age-based retention
(`maxFiles: '<N>d'`) rather than a custom sweep, and is comfortable with the
extra dependency weight and winston's transport API in exchange.

## Component: `server/logger.js`

A single winston logger instance, module default export:

- **Transports:**
  - `winston-daily-rotate-file`: JSON lines to `<LOG_DIR>/digest-%DATE%.log`,
    `datePattern: 'YYYY-MM-DD'`, `maxFiles: '<LOG_RETENTION_DAYS>d'`.
  - Console transport, enabled only outside `NODE_ENV=production` (or when
    running tests), so local dev/`npm test` output isn't silently swallowed
    into a file.
- **Level:** `LOG_LEVEL` env var (default `'info'`). Standard npm levels
  (error/warn/info/http/verbose/debug/silly) — no custom level config.
- **Log call shape:** `logger.info('event_name', { field: value, ... })` /
  `logger.error('event_name', { field: value, err: err.message, stack:
  err.stack })`. winston merges the metadata object into the JSON line
  alongside `level`, `message` (the event name), and `timestamp`.
- `data/logs/` must be added to `.gitignore` (alongside the existing
  `data/*.sqlite*` entries).

## Config additions (`server/config.js`)

| Var | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `'info'` | winston level filter |
| `LOG_RETENTION_DAYS` | `14` | fed into `maxFiles: '${LOG_RETENTION_DAYS}d'` |
| `LOG_DIR` | `data/logs` | rotate-file destination directory |

## Instrumentation points

| Where | Event | Level | Fields |
|---|---|---|---|
| `ingest.js`, per email | `ingest_completed` | info | `emailId, linksFound, dupes` |
| `ingest.js`, per email | `ingest_failed` | error | `emailId, err, stack` |
| `enrich.js`, per link | `enrichment_completed` | info | `linkId, attempt` |
| `enrich.js`, per link | `enrichment_failed` | warn | `linkId, attempt, err` |
| `enrich.js`, per link | `enrichment_gave_up` | error | `linkId, attempts` |
| `enrich.js`, loop | `enrichment_loop_started` | info | `intervalMs, concurrency` |
| `enrich.js`, loop | `enrichment_loop_stopped` | info | — |
| `enrich.js`, loop | `enrichment_loop_stalled` | error | `minutesSinceLastPass` |
| `index.js`, HTTP | `http_request` | info | `method, path, status, durationMs` |
| `index.js`, process | `uncaught_exception` | error | `err, stack, fatal: true`, then `process.exit(1)` |
| `index.js`, process | `unhandled_rejection` | error | `err, stack, fatal: true`, then `process.exit(1)` |

**Stall detection:** the enrichment loop tracks `lastPassAt`, updated when a
pass completes. On each tick, if `Date.now() - lastPassAt > 5 *
ENRICHMENT_INTERVAL_MS`, log `enrichment_loop_stalled` once (a boolean flag
guards against re-logging every tick) and reset the flag once a pass
completes again. No new env var for the threshold — it scales automatically
with `ENRICHMENT_INTERVAL_MS`.

**HTTP access logging:** a small Express middleware (`res.on('finish', ...)`
to capture status and duration after the response completes), not a
dependency like `morgan` — keeps the log line in the same JSON event shape
as everything else, ~8 lines of code.

**Winston has no built-in `fatal` level.** Crash logging uses `logger.error()`
with a `fatal: true` field rather than configuring custom levels.

## Future extension seam (not implemented here)

Winston supports `logger.add(new SomeTransport())` at any point. The intended
future path: a transport that only receives `error`-level entries
(`level: 'error'` option on the transport) and forwards them to
Slack/email/push. `logger.js` gets a one-line comment marking this as the
extension point so it doesn't need rediscovering later.

## Testing

- `server/logger.test.js` (new): verifies the logger writes valid JSON lines
  to the configured directory, and that `LOG_LEVEL` filtering works (a
  `debug` call produces no line when level is `info`).
- Existing `ingest.test.js` / `enrich.test.js`: extended to spy on the logger
  and assert the correct event fires on success/failure paths, rather than
  adding a dedicated test file per event.

## Non-goals

- No alerting/notification integration.
- No custom winston log levels.
- No change to existing `console.log` startup lines' *content* beyond
  routing them through `logger.info` instead of `console.log` for
  consistency (still informational, not new signals).
