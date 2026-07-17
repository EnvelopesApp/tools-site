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

CREATE TABLE IF NOT EXISTS app_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_name TEXT NOT NULL,
  app TEXT NOT NULL,
  install_id TEXT NOT NULL,
  app_version TEXT,
  platform TEXT,
  architecture TEXT,
  is_licensed INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  total_videos_processed INTEGER NOT NULL DEFAULT 0,
  action_mode TEXT,
  country TEXT,
  colo TEXT
);

CREATE INDEX IF NOT EXISTS idx_app_events_created_at ON app_events(created_at);
CREATE INDEX IF NOT EXISTS idx_app_events_event_name ON app_events(event_name);
CREATE INDEX IF NOT EXISTS idx_app_events_install_id ON app_events(install_id);
CREATE INDEX IF NOT EXISTS idx_app_events_app ON app_events(app);

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

CREATE TABLE IF NOT EXISTS ad_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  snapshot_date TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'google_ads',
  account_id TEXT,
  campaign_key TEXT NOT NULL,
  campaign_id TEXT,
  campaign_name TEXT,
  app TEXT,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  cost_currency TEXT NOT NULL DEFAULT 'USD',
  conversions REAL NOT NULL DEFAULT 0,
  raw_data TEXT,
  UNIQUE(snapshot_date, platform, campaign_key)
);

CREATE INDEX IF NOT EXISTS idx_ad_snapshots_date ON ad_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_ad_snapshots_campaign ON ad_snapshots(source, medium, campaign);
CREATE INDEX IF NOT EXISTS idx_ad_snapshots_app ON ad_snapshots(app);

CREATE TABLE IF NOT EXISTS google_ads_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL,
  imported_snapshots INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  raw_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_google_ads_import_runs_created_at ON google_ads_import_runs(created_at);
