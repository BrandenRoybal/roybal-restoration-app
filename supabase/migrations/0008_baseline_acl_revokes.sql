-- ============================================================================
-- 0004 — put back the REVOKEs the baseline squash dropped
--
-- 0000_baseline.sql is a pg_dump of prod. A dump emits GRANT lines for what a
-- role HAS, never REVOKE lines for what it was deliberately denied. On prod
-- that was fine: each object was created, then an archived migration revoked
-- anon/authenticated (225 field_photos_deleted, 226 sync_fleet, 247
-- integration_health, the web_* / portal_access_* / sync RPCs, ...). But a
-- fresh project replaying the baseline has Supabase's default privileges in
-- force — ALL on every new table/view and EXECUTE on every new function to
-- anon and authenticated — and nothing in the baseline takes them away.
--
-- Found 2026-09-22 when Supabase emailed a CRITICAL "auth_users_exposed" on
-- Roybal-Staging (built from the baseline 09-07): sync_fleet and
-- field_photos_deleted join auth.users, run as the view owner, and were
-- readable by anon. Staging held no data, so nothing leaked; prod never had
-- the grants. But the same drift left staging open on blob_history,
-- app_settings, contact_sessions, sync_clients, the portal_access_* and web_*
-- RPCs, push_project to anon, and more.
--
-- The target state below was READ FROM PROD (pg_class.relacl / pg_proc.proacl
-- for anon + authenticated), so on prod this whole file is a no-op. It only
-- covers objects whose replayed ACL differed from prod's — everything else
-- already matches.
-- ============================================================================

-- ── Operator-only views/tables: service_role only ──────────────────────────
revoke all on public.sync_fleet           from anon, authenticated;
revoke all on public.field_photos_deleted from anon, authenticated;
revoke all on public.field_photos_drift   from anon, authenticated;
revoke all on public.blob_history         from anon, authenticated;
revoke all on public.app_settings         from anon, authenticated;
revoke all on public.contact_sessions     from anon, authenticated;
revoke all on public.sync_clients         from anon, authenticated;

-- ── Signed-in only ─────────────────────────────────────────────────────────
revoke all on public.integration_health from anon;
revoke all on public.contact_timeline   from anon;

-- ── Narrowed privileges (reassert prod exactly) ────────────────────────────
revoke all on public.ai_usage from anon, authenticated;
grant select, insert, references, trigger, maintain on public.ai_usage to anon, authenticated;

revoke all on public.capture_events from anon, authenticated;
grant select, insert, references, trigger, maintain on public.capture_events to anon, authenticated;

-- field_projects: writes go through push_project/revive_project/tombstone_project
revoke all on public.field_projects from anon, authenticated;
grant select, truncate, references, trigger, maintain on public.field_projects to anon, authenticated;

revoke all on public.integration_runs from anon, authenticated;
grant select, references, trigger, maintain on public.integration_runs to anon, authenticated;

revoke all on public.profiles from anon, authenticated;
grant select, references, trigger, maintain on public.profiles to anon, authenticated;

revoke all on public.time_entries from anon, authenticated;
grant select, insert, update, references, trigger, maintain on public.time_entries to anon, authenticated;

revoke insert, update on public.contacts from authenticated;

-- ── Functions: service_role only ───────────────────────────────────────────
revoke all on function public._mf_all_ids(jsonb)            from public, anon, authenticated;
revoke all on function public._mf_emptyish(jsonb)           from public, anon, authenticated;
revoke all on function public._mf_form(jsonb, jsonb)        from public, anon, authenticated;
revoke all on function public._mf_is_obj(jsonb)             from public, anon, authenticated;
revoke all on function public._sync_guard(text)             from public, anon, authenticated;
revoke all on function public.capture_blob_history()        from public, anon, authenticated;
revoke all on function public.contact_canonical(uuid)       from public, anon, authenticated;
revoke all on function public.merge_project_blobs(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.portal_access_begin(uuid, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.portal_access_verify(uuid, text, text, integer, integer)      from public, anon, authenticated;
revoke all on function public.project_field_photos()        from public, anon, authenticated;
revoke all on function public.reconcile_job_photos(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.repair_field_photos()         from public, anon, authenticated;
revoke all on function public.web_alert_claim(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.web_lead_insert(uuid, jsonb, integer)   from public, anon, authenticated;
revoke all on function public.web_session_begin(text, text, text, text, text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.web_turn_begin(uuid, numeric, text, numeric, numeric, numeric, integer, integer) from public, anon, authenticated;
revoke all on function public.web_turn_end(uuid, integer, integer, numeric) from public, anon, authenticated;

-- ── Functions: signed-in only ──────────────────────────────────────────────
revoke all on function public.contact_mark_review_asked(uuid) from public, anon;
revoke all on function public.contact_merge(uuid, uuid)       from public, anon;
revoke all on function public.contact_resolve(text, text, text, text, text, boolean, text) from public, anon;
revoke all on function public.coordination_job_patch(uuid, jsonb) from public, anon;
revoke all on function public.push_project(uuid, integer, jsonb, text) from public, anon;
revoke all on function public.restore_photo(uuid, uuid)       from public, anon;
revoke all on function public.revive_project(uuid, jsonb, text) from public, anon;
revoke all on function public.tombstone_project(uuid, jsonb, text) from public, anon;
