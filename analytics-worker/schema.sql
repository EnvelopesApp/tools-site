CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_name TEXT NOT NULL,
  app TEXT,
  page_url TEXT,
  page_path TEXT,
  referrer TEXT,
  referrer_host TEXT,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  term TEXT,
  content TEXT,
  has_gclid INTEGER NOT NULL DEFAULT 0,
  target_url TEXT,
  target_label TEXT,
  target_kind TEXT,
  platform TEXT,
  session_id TEXT,
  device TEXT,
  language TEXT,
  country TEXT,
  colo TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_event_name ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_app ON events(app);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(source, medium, campaign);

CREATE TABLE IF NOT EXISTS polar_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  webhook_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  event_timestamp TEXT,
  order_id TEXT,
  raw_event TEXT
);

CREATE TABLE IF NOT EXISTS polar_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  order_id TEXT NOT NULL UNIQUE,
  status TEXT,
  app TEXT,
  product_id TEXT,
  product_name TEXT,
  customer_id TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  reference_id TEXT,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  term TEXT,
  content TEXT,
  has_gclid INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  refunded_at TEXT,
  refund_amount INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_polar_orders_created_at ON polar_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_polar_orders_app ON polar_orders(app);
CREATE INDEX IF NOT EXISTS idx_polar_orders_campaign ON polar_orders(source, medium, campaign);
CREATE INDEX IF NOT EXISTS idx_polar_orders_reference_id ON polar_orders(reference_id);
