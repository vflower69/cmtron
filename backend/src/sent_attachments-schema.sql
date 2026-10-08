CREATE TABLE sent_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT,
  filename TEXT,
  content_type TEXT,
  data BLOB,
  FOREIGN KEY(email_id) REFERENCES sent_emails(id)
)
