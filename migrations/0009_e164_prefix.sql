-- Optional per-site E.164 conversion: prefix + user extension = DID.
ALTER TABLE site_mappings ADD COLUMN e164_prefix TEXT;
