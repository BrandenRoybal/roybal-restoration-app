-- ============================================================
-- 238: crew-photos bucket — public crew headshots for the portal
--      "Meet your crew" bio cards (crew-bios phase 1).
--
-- PUBLIC on purpose: customers load headshots straight off the CDN
-- URL with no token, and (phase 2) Twilio fetches them for the MMS
-- intro text. Only deliberately-shared headshots land here — bio
-- text stays in crew_members.data and is gated by bioPublic at the
-- roybal-portal gateway, never by this bucket.
-- Writes stay authenticated (the shared crew login), one object per
-- crew member id, upserted on replacement.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'crew-photos',
  'crew-photos',
  true,
  5242880,  -- 5 MB is plenty for a 512px headshot
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set public = true;

drop policy if exists "crew photos authenticated insert" on storage.objects;
create policy "crew photos authenticated insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'crew-photos');

-- x-upsert replaces an existing headshot → needs update too
drop policy if exists "crew photos authenticated update" on storage.objects;
create policy "crew photos authenticated update"
  on storage.objects for update to authenticated
  using (bucket_id = 'crew-photos')
  with check (bucket_id = 'crew-photos');

drop policy if exists "crew photos authenticated delete" on storage.objects;
create policy "crew photos authenticated delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'crew-photos');
