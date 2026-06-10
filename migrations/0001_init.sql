-- Core schema for the migration tool. IDs are UUIDs generated in the Worker.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  customer TEXT,
  webex_org_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,              -- cucm | unity
  source TEXT NOT NULL,            -- axl | upload
  r2_keys TEXT,                    -- JSON array of uploaded object keys
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | parsing | parsed | failed
  error_text TEXT,
  counts_json TEXT,                -- JSON object of per-type row counts
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  parsed_at TEXT
);
CREATE INDEX idx_snapshots_project ON source_snapshots(project_id);

CREATE TABLE axl_connections (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,      -- AES-GCM, base64(iv||ciphertext)
  cucm_version TEXT,
  verified_at TEXT
);

CREATE TABLE src_users (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  userid TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  department TEXT,
  primary_extension TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_src_users_project ON src_users(project_id);

CREATE TABLE src_phones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  description TEXT,
  model TEXT,
  owner_userid TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_src_phones_project ON src_phones(project_id);

CREATE TABLE src_lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  partition_name TEXT,
  description TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_src_lines_project ON src_lines(project_id);

CREATE TABLE src_hunt_pilots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  description TEXT,
  hunt_list TEXT,
  algorithm TEXT,                  -- CUCM distribution algorithm (raw)
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_src_hunt_pilots_project ON src_hunt_pilots(project_id);

CREATE TABLE src_hunt_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  hunt_pilot_pattern TEXT NOT NULL,
  member_dn TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_src_hunt_members_project ON src_hunt_members(project_id);

CREATE TABLE src_pickup_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  pattern TEXT,
  members_json TEXT,               -- JSON array of member DNs
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_src_pickup_groups_project ON src_pickup_groups(project_id);

CREATE TABLE src_vm_boxes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  display_name TEXT,
  extension TEXT,
  email TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_src_vm_boxes_project ON src_vm_boxes(project_id);

CREATE TABLE mappings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  src_type TEXT NOT NULL,          -- user | hunt_group | pickup_group
  src_id TEXT NOT NULL,
  target_type TEXT NOT NULL,       -- person | hunt_group | call_pickup
  target_payload TEXT NOT NULL,    -- JSON
  status TEXT NOT NULL DEFAULT 'auto',  -- auto | edited | invalid
  selected INTEGER NOT NULL DEFAULT 1,
  confidence TEXT NOT NULL DEFAULT 'green',  -- green | amber | red
  notes TEXT,
  UNIQUE(project_id, src_type, src_id)
);
CREATE INDEX idx_mappings_project ON mappings(project_id);

CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | validating | validated | pushing | pushed | failed | rolled_back
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_batches_project ON batches(project_id);

CREATE TABLE batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  mapping_id TEXT NOT NULL,
  validate_status TEXT,            -- green | amber | red
  validate_notes TEXT,
  push_status TEXT NOT NULL DEFAULT 'pending',  -- pending | queued | pushing | done | failed | rolled_back | skipped
  webex_resource_id TEXT,
  error_text TEXT,
  rollback_info TEXT,              -- JSON: what to delete/unassign
  updated_at TEXT
);
CREATE INDEX idx_batch_items_batch ON batch_items(batch_id);

CREATE TABLE webex_tokens (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  scopes TEXT,
  org_id TEXT,
  org_name TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE push_jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  batch_item_id TEXT NOT NULL,
  action TEXT NOT NULL,            -- push | rollback
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT,                  -- ISO time for retry backoff
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_push_jobs_status ON push_jobs(status, run_after);
