-- ============================================================
-- Phase 2 Expansion Migration (depends on 005_phase2_enum_values)
-- ============================================================

-- ─── A. Add missing fields to jobs table ─────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS date_received          date,
  ADD COLUMN IF NOT EXISTS cause_of_loss          text,
  ADD COLUMN IF NOT EXISTS is_emergency           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_party          text,
  ADD COLUMN IF NOT EXISTS property_manager_name  text,
  ADD COLUMN IF NOT EXISTS property_manager_phone text,
  ADD COLUMN IF NOT EXISTS property_manager_email text,
  ADD COLUMN IF NOT EXISTS assigned_pm_id         uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS xactimate_file_number  text,
  ADD COLUMN IF NOT EXISTS deductible_amount      integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS policy_number          text,
  ADD COLUMN IF NOT EXISTS loss_location          text,
  ADD COLUMN IF NOT EXISTS lead_source            text;

-- ─── B. Migrate existing status values to new enum values ────────────────────
UPDATE jobs SET status = 'lead'             WHERE status = 'new';
UPDATE jobs SET status = 'mitigation_active' WHERE status = 'active';
UPDATE jobs SET status = 'punch_list'       WHERE status = 'final_inspection';
UPDATE jobs SET status = 'invoice_submitted' WHERE status = 'invoicing';
-- 'monitoring' and 'closed' stay the same; 'drying' maps to 'monitoring' (same value)

-- ─── C. Create communications table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS communications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  comm_type        text NOT NULL CHECK (comm_type IN ('call','email','text','site_visit','internal_note','verbal_approval','other')),
  direction        text CHECK (direction IN ('inbound','outbound','internal')),
  contact_name     text,
  contact_role     text,
  subject          text,
  body             text NOT NULL,
  is_internal      boolean NOT NULL DEFAULT false,
  follow_up_needed boolean NOT NULL DEFAULT false,
  follow_up_date   date
);
CREATE INDEX IF NOT EXISTS communications_job_id_idx    ON communications(job_id);
CREATE INDEX IF NOT EXISTS communications_created_at_idx ON communications(created_at DESC);
ALTER TABLE communications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can manage communications" ON communications
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ─── D. Create tasks table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_by   uuid REFERENCES auth.users(id),
  assigned_to  uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  due_date     date,
  title        text NOT NULL,
  description  text,
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  category     text CHECK (category IN ('photo','document','estimate','inspection','monitoring','invoice','communication','scheduling','other'))
);
CREATE INDEX IF NOT EXISTS tasks_job_id_idx     ON tasks(job_id);
CREATE INDEX IF NOT EXISTS tasks_assigned_to_idx ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS tasks_due_date_idx   ON tasks(due_date);
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can manage tasks" ON tasks
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─── E. Create documents table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  uploaded_by    uuid REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  doc_type       text NOT NULL CHECK (doc_type IN (
    'work_authorization','direction_to_pay','responsibility_acknowledgment',
    'change_order','estimate','invoice','carrier_correspondence',
    'permit','vendor_invoice','closeout','other'
  )),
  title          text NOT NULL,
  storage_path   text,
  file_url       text,
  status         text DEFAULT 'pending' CHECK (status IN ('pending','signed','approved','rejected')),
  notes          text,
  signed_at      timestamptz,
  signed_by_name text
);
CREATE INDEX IF NOT EXISTS documents_job_id_idx ON documents(job_id);
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can manage documents" ON documents
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ─── F. Create invoices table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  invoice_number  text NOT NULL DEFAULT '',
  invoice_type    text NOT NULL CHECK (invoice_type IN ('mitigation','reconstruction','tm','vendor_passthrough','supplement')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','partially_paid','paid','disputed','void')),
  amount_cents    integer NOT NULL DEFAULT 0,
  paid_cents      integer NOT NULL DEFAULT 0,
  due_date        date,
  submitted_date  date,
  paid_date       date,
  notes           text,
  xactimate_ref   text
);
CREATE INDEX IF NOT EXISTS invoices_job_id_idx ON invoices(job_id);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can manage invoices" ON invoices
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION set_invoice_number()
RETURNS TRIGGER AS $$
DECLARE
  yr  text := to_char(now(), 'YYYY');
  seq int;
BEGIN
  SELECT COUNT(*) + 1 INTO seq FROM invoices WHERE to_char(created_at, 'YYYY') = yr;
  NEW.invoice_number := 'INV-' || yr || '-' || LPAD(seq::text, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_invoice_number
  BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_invoice_number();

CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─── G. Storage bucket for documents ─────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documents', 'documents', false, 52428800,
  ARRAY['application/pdf','image/jpeg','image/png','image/heic','application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Auth users can read documents" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'documents');
CREATE POLICY "Auth users can upload documents" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'documents');
CREATE POLICY "Auth users can delete their documents" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'documents' AND owner = auth.uid());
