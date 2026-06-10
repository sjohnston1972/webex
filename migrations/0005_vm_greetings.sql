-- Unity greeting WAV files uploaded to R2, matched to mailboxes by filename
-- (alias or extension). Drives per-person greeting upload at push time.
CREATE TABLE src_vm_greetings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  matched_alias TEXT
);
CREATE INDEX idx_src_vm_greetings_project ON src_vm_greetings(project_id);
