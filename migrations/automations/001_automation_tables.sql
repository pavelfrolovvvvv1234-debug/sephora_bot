-- Automations module: scenarios, versions, state, offers, event_log, metrics
-- Target: Postgres. For SQLite use TypeORM synchronize or adapt types (e.g. jsonb -> text).

-- automation_scenarios: one row per scenario key
CREATE TABLE IF NOT EXISTS automation_scenarios (
  key VARCHAR(64) PRIMARY KEY,
  category VARCHAR(64) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  name VARCHAR(256),
  description TEXT,
  tags TEXT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- scenario_versions: draft or published config
CREATE TABLE IF NOT EXISTS scenario_versions (
  id SERIAL PRIMARY KEY,
  scenarioKey VARCHAR(64) NOT NULL REFERENCES automation_scenarios(key) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,
  versionNumber INT NOT NULL DEFAULT 1,
  config JSONB NOT NULL,
  publishedBy INT,
  publishedAt TIMESTAMP,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scenario_versions_one_published
  ON scenario_versions(scenarioKey) WHERE (status = 'published');
CREATE INDEX IF NOT EXISTS idx_scenario_versions_key ON scenario_versions(scenarioKey);

-- user_notification_state: cooldowns and step state per user per scenario
CREATE TABLE IF NOT EXISTS user_notification_state (
  id SERIAL PRIMARY KEY,
  scenarioKey VARCHAR(64) NOT NULL,
  userId INT NOT NULL,
  lastSentAt TIMESTAMP,
  sendCount INT NOT NULL DEFAULT 0,
  lastStepId VARCHAR(64),
  lastStepAt TIMESTAMP,
  stepSentAt TEXT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scenarioKey, userId)
);

CREATE INDEX IF NOT EXISTS idx_user_notification_state_user ON user_notification_state(userId);

-- offer_instances: active/applied/expired offers
CREATE TABLE IF NOT EXISTS offer_instances (
  id SERIAL PRIMARY KEY,
  userId INT NOT NULL,
  scenarioKey VARCHAR(64) NOT NULL,
  stepId VARCHAR(64),
  offerKey VARCHAR(64) NOT NULL,
  type VARCHAR(32) NOT NULL,
  value REAL NOT NULL,
  expiresAt TIMESTAMP NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  appliedAt TIMESTAMP,
  claimedAt TIMESTAMP,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_offer_instances_user_scenario ON offer_instances(userId, scenarioKey, status);
CREATE INDEX IF NOT EXISTS idx_offer_instances_expires ON offer_instances(expiresAt);

-- automation_event_log: sent/skipped/error
CREATE TABLE IF NOT EXISTS automation_event_log (
  id SERIAL PRIMARY KEY,
  scenarioKey VARCHAR(64) NOT NULL,
  userId INT,
  outcome VARCHAR(32) NOT NULL,
  stepId VARCHAR(64),
  reason TEXT,
  payload TEXT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_automation_event_log_scenario_created ON automation_event_log(scenarioKey, createdAt);
CREATE INDEX IF NOT EXISTS idx_automation_event_log_user_created ON automation_event_log(userId, createdAt);

-- scenario_metrics: daily aggregates
CREATE TABLE IF NOT EXISTS scenario_metrics (
  id SERIAL PRIMARY KEY,
  scenarioKey VARCHAR(64) NOT NULL,
  date DATE NOT NULL,
  sentCount INT NOT NULL DEFAULT 0,
  skippedCount INT NOT NULL DEFAULT 0,
  errorCount INT NOT NULL DEFAULT 0,
  conversionCount INT NOT NULL DEFAULT 0,
  conversionRevenue REAL NOT NULL DEFAULT 0,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scenarioKey, date)
);
