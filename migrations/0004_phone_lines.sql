-- Lines per phone (from devicenumplanmap) — drives workspace migration for
-- owner-less (common-area) phones.
ALTER TABLE src_phones ADD COLUMN lines_json TEXT;
