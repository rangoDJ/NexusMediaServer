-- Ambient artwork color, sampled from each item's poster.
--
-- Drives the UI's per-item accent (the --art custom property): card glow,
-- hover scrim, progress fill and focus ring all derive from this one value,
-- so a library reads as a shelf of distinct titles rather than a uniform grid.
--
-- Only media_items carries this. The episodes table has no artwork columns at
-- all, so an episode has nothing of its own to sample; episode views inherit
-- the color of their parent series via episodes.series_id.
ALTER TABLE media_items
  -- '#RRGGBB', or NULL when no usable color exists (greyscale poster, missing
  -- file, decode failure). NULL is a normal state — the client falls back to
  -- its default accent.
  ADD COLUMN IF NOT EXISTS dominant_color TEXT,
  -- When extraction last ran, regardless of outcome.
  --
  -- This is what makes "no usable color" distinguishable from "not yet
  -- attempted". Without it the backfill task would key off dominant_color IS
  -- NULL and so re-download every greyscale poster on every run, forever —
  -- the same defect that made the intro-detection task re-fingerprint whole
  -- series indefinitely (see tasks/analyzeIntros.js).
  ADD COLUMN IF NOT EXISTS color_extracted_at TIMESTAMPTZ;

-- Lets the backfill task find unprocessed rows without scanning the table.
-- Partial, because a row stops being interesting once it has been attempted.
CREATE INDEX IF NOT EXISTS media_items_color_pending_idx
  ON media_items (id)
  WHERE color_extracted_at IS NULL;
