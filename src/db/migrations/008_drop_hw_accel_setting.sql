-- Remove the vestigial global transcoding.hardware_accel setting.
-- Hardware acceleration is determined per-transcoder-node from the
-- HW_ACCEL env var that each container reports during /transcoders/register,
-- so this global setting was never read by anything and only misled admins
-- who changed it expecting an effect.
DELETE FROM settings WHERE key = 'transcoding.hardware_accel';
