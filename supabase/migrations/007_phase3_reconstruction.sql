-- Phase 3: Reconstruction checklist table
CREATE TABLE IF NOT EXISTS reconstruction_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  room_id       uuid REFERENCES rooms(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  trade         text NOT NULL CHECK (trade IN (
    'drywall','insulation','paint','trim','flooring',
    'cabinetry','plumbing','electrical','hvac','final_clean','other'
  )),
  description   text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','complete','skipped')),
  notes         text,
  completed_by  uuid REFERENCES auth.users(id),
  completed_at  timestamptz,
  sort_order    integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reconstruction_items_job_id_idx ON reconstruction_items(job_id);
CREATE INDEX IF NOT EXISTS reconstruction_items_room_id_idx ON reconstruction_items(room_id);
ALTER TABLE reconstruction_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can manage reconstruction items" ON reconstruction_items
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER reconstruction_items_updated_at
  BEFORE UPDATE ON reconstruction_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
