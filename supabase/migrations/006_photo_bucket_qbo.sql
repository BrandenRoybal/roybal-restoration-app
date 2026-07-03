-- ============================================================
-- Roybal Restoration — Photo bucket fix + QuickBooks Online invoicing
-- Run via the Supabase SQL editor or: supabase db push
-- ============================================================

-- ============================================================
-- PHOTOS BUCKET: fix the delete policy
-- ============================================================
-- The original policy compared auth.uid() to the first path segment,
-- but photo paths are {job_id}/{room_id|general}/{filename}, so deletes
-- always failed. Allow any authenticated user to delete photo objects
-- (table-level RLS on the photos table already gates who can manage
-- which job's photos).
drop policy if exists "Authenticated users can delete own photos" on storage.objects;

create policy "Authenticated users can delete photos"
  on storage.objects for delete
  using (
    bucket_id = 'photos' and
    auth.uid() is not null
  );

-- ============================================================
-- QUICKBOOKS ONLINE INVOICING
-- ============================================================
-- Track the QBO copy of each invoice
alter table invoices
  add column if not exists qbo_invoice_id text,
  add column if not exists qbo_synced_at timestamptz;

-- Cache the QBO customer created/matched for a job's property owner
alter table jobs
  add column if not exists qbo_customer_id text;
