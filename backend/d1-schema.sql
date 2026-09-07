D1 schema (run via wrangler d1 execute evera-db)
------------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  plan TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_session_id TEXT NOT NULL,
  email TEXT,
  amount_total INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
