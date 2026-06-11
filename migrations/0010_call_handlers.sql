-- Unity call handlers (non-primary = real IVR/menu handlers) → Webex auto attendants.
CREATE TABLE src_call_handlers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  name TEXT NOT NULL,
  extension TEXT,
  menu_json TEXT,                  -- raw CUPI menu entries
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_src_call_handlers_project ON src_call_handlers(project_id);
