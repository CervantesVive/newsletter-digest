# Newsletter Digest

A personal newsletter triage app: forward newsletters to a mailbox, have links
extracted/deduped/categorized/summarized, and act on each one (mark read, save to
Instapaper, dismiss) from a single feed.

This service does **not** retrieve email itself — something else (e.g. a Hermes-style
agent, a mail rule, a cron job) needs to `POST` raw MIME emails to it. See
[`AGENTS.md`](AGENTS.md) for architecture notes and implementation gotchas.

## Prerequisites

- [ ] **Node.js 20 or newer** installed (`node --version`) — this app uses the built-in
      `node:test` runner and `better-sqlite3`, which needs a reasonably current Node.
- [ ] A place to run a long-lived process (this is a single Node process, not serverless —
      a systemd service, `pm2`, Docker container, or similar).
- [ ] **A network access plan.** There is no login/auth built in — decide how you'll
      restrict access before exposing this anywhere (a private network/VPN, a reverse
      proxy with its own auth, a firewall rule, etc.). This is a deployment detail, not
      something this app enforces itself.
- [ ] *(Optional but recommended)* An OpenAI-compatible LLM endpoint (e.g.
      [LiteLLM](https://github.com/BerriAI/litellm)) if you want links summarized/
      categorized. Without one, ingestion and the feed still work — links just stay
      "Uncategorized" with no summary.
- [ ] *(Optional)* Something that calls `POST /ingest` with raw emails — this app has no
      opinion on how you get email into it.

## Install

- [ ] Clone the repo and install dependencies:
  ```bash
  npm install
  ```
- [ ] Run the test suite to confirm everything works in your environment:
  ```bash
  npm test
  ```
  All tests should pass before you go further. If `better-sqlite3` fails to build, you're
  likely missing native build tools (`python3`, `make`, a C++ compiler) — install those and
  re-run `npm install`.

## Configure

All configuration is via environment variables (see `server/config.js`). Nothing is
required to start the server — but enrichment stays disabled until you set the LLM
variables.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the HTTP server listens on. |
| `DIGEST_DB_PATH` | `<repo>/data/digest.sqlite` | Where the SQLite file lives. |
| `LLM_BASE_URL` | *(unset)* | Base URL of an OpenAI-compatible endpoint (e.g. your LiteLLM gateway). Leave unset to disable enrichment. |
| `LLM_API_KEY` | *(unset)* | API key for the LLM endpoint, if it requires one. |
| `LLM_MODEL` | *(unset)* | Model name to request (e.g. `gpt-4o-mini`, or whatever your gateway routes). Leave unset to disable enrichment. |
| `ENRICHMENT_INTERVAL_MS` | `30000` | How often the background enrichment loop runs. |
| `ENRICHMENT_CONCURRENCY` | `3` | Max simultaneous LLM calls per enrichment pass. |
| `ENRICHMENT_MAX_ATTEMPTS` | `5` | Failed enrichment attempts before a link is given up on (shows as "Uncategorized" permanently, no summary). |

- [ ] Decide whether you want enrichment on. If yes, set `LLM_BASE_URL` and `LLM_MODEL`
      (and `LLM_API_KEY` if your endpoint needs one).
- [ ] Decide where the SQLite file should live (`DIGEST_DB_PATH`) if the default
      (`data/digest.sqlite` inside the repo) isn't what you want — e.g. a persistent volume
      if you're running this in a container.
- [ ] Set `PORT` if `3000` conflicts with something else on your host.

Example `.env`-style setup (this app doesn't load `.env` files automatically — export
these however your process manager expects):

```bash
export PORT=3000
export DIGEST_DB_PATH=/var/lib/newsletter-digest/digest.sqlite
export LLM_BASE_URL=http://localhost:4000/v1
export LLM_API_KEY=sk-...
export LLM_MODEL=gpt-4o-mini
```

## Run

- [ ] Start the server:
  ```bash
  npm start
  ```
- [ ] Confirm it's listening:
  ```bash
  curl http://localhost:3000/api/links
  ```
  You should get back `{"groups":[],"totalCount":0,"unreadCount":0}` on a fresh install.
- [ ] Check the startup log for one of these two lines and confirm it matches what you
      expected:
  - `enrichment loop started against <url> (model: <model>)` — enrichment is running.
  - `LLM_BASE_URL/LLM_MODEL not set — enrichment loop disabled, links will stay unenriched`
    — expected if you deliberately skipped LLM config.
- [ ] Keep it running persistently (pick one):
  - [ ] systemd unit that runs `node server/index.js` with `WorkingDirectory` set to the
        repo and `Restart=on-failure`.
  - [ ] `pm2 start server/index.js --name newsletter-digest`
  - [ ] Docker — see [Deploy with Docker](#deploy-with-docker) below, the recommended path
        for a host that isn't your dev machine.

## Deploy with Docker

This is the recommended way to run this app on a separate host from where you develop it —
the deploy host only needs Docker, never a git checkout of this repo.

CI (`.github/workflows/publish.yml`) builds and pushes an image to GHCR on every `vX.Y.Z`
tag push, so pulling `ghcr.io/cervantesvive/newsletter-digest:<tag>` gets you a released
build with no local build step.

Repo-first homelab workflow:
- review tracked deploy files in this repo first
- preview runtime sync with `deploy/sync-deploy.sh`
- apply with `deploy/sync-deploy.sh --apply` only after approval
- then update the live runtime from `/mnt/media/services/newsletter-digest`

- [ ] On the deploy host, copy just two files from this repo (not the whole repo):
  - [ ] [`deploy/docker-compose.yml`](deploy/docker-compose.yml)
  - [ ] [`.env.example`](.env.example) -> rename to `.env` and fill in real values (see the
        Configure section above for what each variable means). This `.env` never gets
        committed anywhere — it lives only on the deploy host.
- [ ] Edit `docker-compose.yml`'s `image:` line to pin a real release tag instead of
      `:latest`, and its `ports:` line to match your network access plan (this app has no
      auth — see the Prerequisites note above).
- [ ] Pull and start:
  ```bash
  docker compose pull
  docker compose up -d
  ```
- [ ] Confirm it's listening (same check as the non-Docker path):
  ```bash
  curl http://<host>:3000/api/links
  ```
  Expect `{"groups":[],"totalCount":0,"unreadCount":0}` on a fresh install.
- [ ] Data (SQLite file + logs) persists in the `digest-data` named volume across
      `docker compose down`/`up` and image upgrades — it's only lost if you explicitly
      remove the volume (`docker compose down -v`).
- [ ] To upgrade: edit the `image:` tag in `docker-compose.yml`, then `docker compose pull
      && docker compose up -d`. Updates are manual on purpose — nothing auto-updates the
      running container.

## Wire up ingestion

This app never fetches email itself — you need a separate piece that `POST`s raw emails
to it.

- [ ] Point whatever retrieves your forwarded newsletters (a script, a cron job, a mail
      rule, an existing automation) at:
  ```
  POST http://<host>:<port>/ingest
  Content-Type: application/json

  { "emails": [ { "raw_mime": "<raw MIME text or base64>" }, ... ] }
  ```
- [ ] Confirm a real send works end-to-end:
  ```bash
  curl -X POST http://localhost:3000/ingest \
    -H 'Content-Type: application/json' \
    -d '{"emails":[{"raw_mime":"Message-ID: <test@example.com>\r\nFrom: Test <test@example.com>\r\nSubject: Hi\r\nContent-Type: text/html\r\n\r\n<a href=\"https://example.com\">A link</a>"}]}'
  ```
  Expect `{"results":[{"message_id":"<test@example.com>","status":"ingested"}]}`.
- [ ] Check the link showed up:
  ```bash
  curl http://localhost:3000/api/links
  ```
- [ ] If enrichment is configured, wait up to `ENRICHMENT_INTERVAL_MS` (30s by default) and
      re-check — `summary`/`topics`/`readTime` should populate.

## Set up the frontend

- [ ] Open `http://<host>:<port>/` in a browser (served automatically from `public/` by
      the same process — nothing extra to deploy).
- [ ] Verify the basics work: search, switching between Topic/Source grouping, "Hide read",
      dismissing a link, marking read, and the bulk-select bar (checkbox → action buttons
      appear at the bottom).
- [ ] **Verify "Save to Instapaper" for real.** This is flagged in `AGENTS.md` as
      **unverified against the live site** — it was built and reasoned about, but never
      actually clicked against instapaper.com (the dev environment couldn't reach the
      public internet). Before you rely on it:
  - [ ] Log into Instapaper in the same browser you'll use for this app.
  - [ ] Click "Save to Instapaper" on a real card and confirm it opens Instapaper's edit
        page with the URL/title pre-filled and actually saves.
  - [ ] If it doesn't work as expected, the template lives in `public/app.js` as
        `INSTAPAPER_URL_TEMPLATE` — adjust it to whatever Instapaper's real endpoint
        expects and re-test.

## Operating notes

- [ ] **Dismiss is permanent.** There's no "undo" — a dismissed link stays hidden even if
      the same URL gets forwarded again in a future newsletter.
- [ ] **Back up `data/digest.sqlite`** if you care about read/dismissed/saved state and
      accumulated summaries — it's the only durable state this app has.
- [ ] The enrichment loop gives up on a link after `ENRICHMENT_MAX_ATTEMPTS` consecutive
      failures (it'll show as "Uncategorized" permanently, with no summary). Check server
      logs if the LLM endpoint's reliability is a concern.
- [ ] There's no size cap enforced on `/ingest` batches beyond a 50MB request body limit —
      keep whatever calls it sending reasonably sized batches.

## Troubleshooting

- [ ] **Server won't start / `better-sqlite3` errors**: usually a native build issue — make
      sure your Node version matches what the native module was compiled for, or reinstall
      (`rm -rf node_modules && npm install`).
- [ ] **Links never get summaries**: confirm `LLM_BASE_URL`/`LLM_MODEL` are set and check
      the startup log line; confirm your LLM endpoint is reachable from wherever this
      process runs (`curl $LLM_BASE_URL/models` or similar, if your gateway supports it).
- [ ] **A dismissed link came back**: it shouldn't — if you see this, it's a bug, not
      expected behavior. Check you're not running two instances against different SQLite
      files.
- [ ] **`npm test` hangs**: don't run `node --test server/` (a bare directory) — it treats
      every `.js` file in `server/` as a test file, including `server/index.js`, which then
      starts a real listening server and never exits. Use `npm test` (pinned to
      `node --test server/*.test.js`) instead.
