const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS emails (
  id            INTEGER PRIMARY KEY,
  message_id    TEXT UNIQUE NOT NULL,
  from_address  TEXT,
  from_name     TEXT,
  subject       TEXT,
  raw_mime      TEXT,
  received_at   DATETIME,
  processed_at  DATETIME
);

CREATE TABLE IF NOT EXISTS links (
  id              INTEGER PRIMARY KEY,
  url_normalized  TEXT UNIQUE NOT NULL,
  url_original    TEXT NOT NULL,
  headline        TEXT,
  summary         TEXT,
  read_time       INTEGER,
  enriched_at     DATETIME,
  enrich_attempts INTEGER NOT NULL DEFAULT 0,
  read            BOOLEAN NOT NULL DEFAULT 0,
  dismissed       BOOLEAN NOT NULL DEFAULT 0,
  saved_instapaper BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS link_sources (
  link_id            INTEGER NOT NULL REFERENCES links(id),
  email_id           INTEGER NOT NULL REFERENCES emails(id),
  extracted_summary  TEXT,
  UNIQUE(link_id, email_id)
);

CREATE TABLE IF NOT EXISTS link_topics (
  link_id  INTEGER NOT NULL REFERENCES links(id),
  topic    TEXT NOT NULL,
  UNIQUE(link_id, topic)
);
`;

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
