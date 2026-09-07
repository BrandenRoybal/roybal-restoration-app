-- ============================================================
-- Roybal Restoration — Storage Buckets
-- ============================================================

-- Photos bucket (one per job, organized by job_id/room_id/filename)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'photos',
  'photos',
  false,
  52428800,  -- 50 MB per photo
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do nothing;

-- Floor plans bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'floor-plans',
  'floor-plans',
  false,
  104857600,  -- 100 MB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/svg+xml']
)
on conflict (id) do nothing;

-- Generated PDF reports bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'reports',
  'reports',
  false,
  52428800,
  array['application/pdf']
)
on conflict (id) do nothing;

-- ---- STORAGE RLS POLICIES ----

-- Photos: techs can read/upload for assigned jobs
-- Path convention: photos/{job_id}/{room_id|general}/{filename}
create policy "Authenticated users can upload photos"
  on storage.objects for insert
  with check (
    bucket_id = 'photos' and
    auth.uid() is not null
  );

create policy "Authenticated users can read photos"
  on storage.objects for select
  using (
    bucket_id = 'photos' and
    auth.uid() is not null
  );

create policy "Authenticated users can delete own photos"
  on storage.objects for delete
  using (
    bucket_id = 'photos' and
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Floor plans: admins and assigned techs
create policy "Authenticated users can read floor plans"
  on storage.objects for select
  using (
    bucket_id = 'floor-plans' and
    auth.uid() is not null
  );

create policy "Service role can manage floor plans"
  on storage.objects for all
  using (bucket_id = 'floor-plans')
  with check (bucket_id = 'floor-plans');

-- Reports
create policy "Authenticated users can read reports"
  on storage.objects for select
  using (
    bucket_id = 'reports' and
    auth.uid() is not null
  );

create policy "Authenticated users can upload reports"
  on storage.objects for insert
  with check (
    bucket_id = 'reports' and
    auth.uid() is not null
  );
