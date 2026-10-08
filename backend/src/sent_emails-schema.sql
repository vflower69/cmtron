CREATE TABLE sent_emails (
  id TEXT PRIMARY KEY,
  email_id TEXT,
  from_addr TEXT,
  to_addr TEXT,
  original_to TEXT,
  subject TEXT,
  body TEXT,
  spam_score REAL,
  is_spam INTEGER,
  sent_at TEXT
)
