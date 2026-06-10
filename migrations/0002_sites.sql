-- Site context pulled from CUCM (device pool / location per phone) and the
-- human-confirmed mapping of CUCM sites to Webex locations.

ALTER TABLE src_phones ADD COLUMN device_pool TEXT;
ALTER TABLE src_phones ADD COLUMN location_name TEXT;

CREATE TABLE site_mappings (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cucm_site TEXT NOT NULL,
  webex_location TEXT,
  PRIMARY KEY (project_id, cucm_site)
);

CREATE TABLE src_trans_patterns (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  partition_name TEXT,
  description TEXT,
  called_party_mask TEXT,
  prefix_digits TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX idx_src_trans_patterns_project ON src_trans_patterns(project_id);
