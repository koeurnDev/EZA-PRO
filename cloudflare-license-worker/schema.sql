CREATE TABLE IF NOT EXISTS licenses (
  license_key TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  app_scope TEXT NOT NULL DEFAULT 'all',
  plan_id TEXT NOT NULL DEFAULT 'monthly_10',
  price_usd REAL NOT NULL DEFAULT 10,
  duration_days INTEGER NOT NULL DEFAULT 30,
  first_activated_at INTEGER,
  warranty_support TEXT NOT NULL DEFAULT 'standard_warranty',
  status TEXT NOT NULL DEFAULT 'active',
  max_machines INTEGER NOT NULL DEFAULT 1,
  bound_machines TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_machine_id TEXT DEFAULT '',
  last_app_version TEXT DEFAULT '',
  verify_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_licenses_last_seen ON licenses(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_licenses_plan ON licenses(plan_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT DEFAULT '',
  machine_id TEXT DEFAULT '',
  event TEXT NOT NULL,
  detail TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
