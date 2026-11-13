CREATE TABLE checkout_agent_devices (
  user_id TEXT PRIMARY KEY REFERENCES "User"(id) ON DELETE CASCADE,
  id VARCHAR(64) NOT NULL UNIQUE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  vinted_user_id BIGINT NOT NULL,
  domain VARCHAR(255) NOT NULL,
  linked_at TEXT NOT NULL,
  expires_at TIMESTAMP(6) NOT NULL,
  last_seen_at TIMESTAMP(6)
);
CREATE TABLE checkout_agent_jobs (
  id VARCHAR(64) PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  device_id VARCHAR(64) NOT NULL,
  scope_key VARCHAR(64) NOT NULL,
  request_ciphertext TEXT NOT NULL,
  result_ciphertext TEXT,
  state VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, scope_key)
);
CREATE INDEX checkout_agent_jobs_pending_idx ON checkout_agent_jobs(device_id, state, created_at);
