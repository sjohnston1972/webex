-- Full dial-plan inventory pulled from CUCM (report/review only — not pushed).
CREATE TABLE src_dialplan (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  object_type TEXT NOT NULL,       -- route_partition | css | route_pattern | route_list | route_group | sip_trunk
  name TEXT NOT NULL,              -- name or pattern
  partition_name TEXT,
  description TEXT,
  detail TEXT,                     -- human-readable extra (CSS members, blocked flag…)
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_src_dialplan_project ON src_dialplan(project_id, object_type);
