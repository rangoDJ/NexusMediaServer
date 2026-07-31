-- Blurhash placeholder for poster artwork, matching jellyfin-web's actual
-- card behaviour: a decoded low-res blur shown behind the poster while the
-- real image loads, rather than a per-item extracted accent colour (see
-- migration 024 — dominant_color is kept but the Jellyfin-parity UI no
-- longer reads it for card visuals; blurhash is the placeholder now used).
--
-- Nullable for the same reason dominant_color is: a missing file, dead URL,
-- or unsupported format can't produce one, and NULL is a normal "no
-- placeholder" state, not an error.
ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS blurhash TEXT;
