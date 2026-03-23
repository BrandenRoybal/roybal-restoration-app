-- 009_opening_enhancements.sql
-- Add updated_at tracking to room_openings

ALTER TABLE room_openings
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Generic updated_at trigger function (create or replace so it's idempotent)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS room_openings_set_updated_at ON room_openings;
CREATE TRIGGER room_openings_set_updated_at
  BEFORE UPDATE ON room_openings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
