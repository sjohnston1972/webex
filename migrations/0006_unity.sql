-- Unity Connection CUPI connection per project (mirrors axl_connections).
CREATE TABLE unity_connections (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  unity_version TEXT,
  verified_at TEXT
);
