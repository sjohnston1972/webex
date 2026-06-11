-- Per-person outgoing call permission class override:
-- NULL = default (international), else internal | toll_free | national | international.
ALTER TABLE mappings ADD COLUMN call_permission TEXT;
