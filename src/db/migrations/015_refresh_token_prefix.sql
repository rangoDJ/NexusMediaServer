-- Add a plaintext token prefix column so the /auth/refresh endpoint can find
-- the right row with a single indexed lookup instead of bcrypt-comparing up to
-- 50 candidates. The prefix is the first 16 characters of the raw token and is
-- not secret (the bcrypt hash is still the authoritative credential check).
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS token_prefix TEXT;

CREATE INDEX IF NOT EXISTS refresh_tokens_prefix_idx
  ON refresh_tokens(token_prefix)
  WHERE revoked_at IS NULL;

-- Back-fill existing rows is not possible (we only have the hash), so they
-- will fall through to a full scan until they naturally expire or get rotated.
