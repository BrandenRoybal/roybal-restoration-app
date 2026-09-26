-- ============================================================================
-- 0010 — magicplan_exports: one row per Magicplan scan pulled onto a bid file
--
-- docs/Magicplan_Integration_Design.md §4.1. (The design names this file
-- 0009; 0009 was taken by 0009_portal_claim.sql before this landed.)
--
-- WHO WRITES IT: only the magicplan-proxy edge function, under the service
-- role. Its `sync` action copies the scan's Report PDF, pinned photos and
-- floor SVGs into the existing field-media bucket (sitevisit/<job>/mp-…) and
-- records them here with the normalized room statistics; `markImported`
-- stamps imported_at once the field app has merged the row.
--
-- WHO READS IT: the field app (Bid card, Site Visit adopt banner) and the
-- admin ⚙ Settings panel, over PostgREST as an owner/office user. The field
-- app — never the server — merges a row into project.siteVisit through its
-- own Store.put + sync (design decision 4: no second write door into the
-- blob). Nothing reads a Magicplan URL at read time; none is stored.
--
-- Additive: dropping this table (and deleting magicplan-proxy) restores the
-- app exactly as it was.
-- ============================================================================

create table if not exists public.magicplan_exports (
  id                uuid primary key default gen_random_uuid(),
  mp_project_id     text not null,
  mp_plan_id        text not null,
  field_project_id  text,                        -- resolved from external_reference_id; null = unmatched (§5 listing case)
  status            text not null default 'queued'
                    check (status in ('queued', 'ready', 'imported', 'failed', 'unmatched')),
  files             jsonb not null default '[]'::jsonb,  -- [{path, name, mime, size, hash, folder, mp_last_modified, mp_size}]
  photos            jsonb not null default '[]'::jsonb,  -- [{path, name, mime, size, hash, room, floor, caption, symbol_instance_id, mp_last_modified, mp_size}]
  statistics        jsonb,                                -- normalized, feet: {units, floors:[{name, rooms:[…]}]}
  floors_svg        jsonb not null default '[]'::jsonb,  -- [{floor, path, name, mime, size, hash, mp_last_modified, mp_size}]
  error             text,
  received_at       timestamptz not null default now(),
  synced_at         timestamptz,
  imported_at       timestamptz,
  imported_by       text
);

comment on table public.magicplan_exports is
  'One Magicplan scan pulled onto a bid file (docs/Magicplan_Integration_Design.md §4.1). Written only by the magicplan-proxy edge function (service role); read by owner/office in the field app''s adopt banner and the admin Settings panel. The field app merges a row into field_projects itself — the server never writes the blob.';

create index if not exists magicplan_exports_field_project_imported_idx
  on public.magicplan_exports (field_project_id, imported_at);

alter table public.magicplan_exports enable row level security;

-- The baseline's default privileges grant ALL on every new table to anon and
-- authenticated (0000_baseline.sql; 0008). Take it all back: anon holds
-- nothing, authenticated may SELECT (and RLS narrows that to owner/office).
-- Writes happen under the service role only, which bypasses RLS.
revoke all on public.magicplan_exports from anon, authenticated;
grant select on public.magicplan_exports to authenticated;

-- Read: owner/office. role_is() rather than current_role_name(): a real user
-- JWT carries role = "authenticated" as a claim, which current_role_name()
-- returns before it ever reads profiles, so that gate would refuse the owner
-- until the role hook ships. role_is() reads profiles and speaks both
-- vocabularies (0006, doc 09 §4.1). No insert/update/delete policy.
drop policy if exists magicplan_exports_read_office on public.magicplan_exports;
create policy magicplan_exports_read_office on public.magicplan_exports
  for select to authenticated
  using ((select public.role_is('owner', 'office')));
