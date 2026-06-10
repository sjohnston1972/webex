-- User-forced voicemail provisioning per person mapping:
-- NULL = follow Unity-derived state, 1 = force on, 0 = force off.
ALTER TABLE mappings ADD COLUMN vm_override INTEGER;
