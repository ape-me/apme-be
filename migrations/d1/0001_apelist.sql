CREATE TABLE IF NOT EXISTS apelist (
  email         TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confirmed_at  TEXT,
  confirm_token TEXT UNIQUE,
  ip_hash       TEXT,
  ref           TEXT,
  user_agent    TEXT,
  blasted_at    TEXT
);
CREATE INDEX IF NOT EXISTS apelist_created ON apelist(created_at);
