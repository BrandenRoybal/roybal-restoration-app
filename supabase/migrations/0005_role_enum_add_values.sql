-- ============================================================================
-- 0005 — role-enum migration, step N of three: the four new labels
--
-- docs/architecture/09-ROLE-ENUM-AND-OPERATION-CATALOG.md §3. The target
-- vocabulary is owner / office / crew_lead / crew / viewer / agent; `office`
-- and `viewer` already exist on public.user_role, so four labels are added.
--
-- WHY THIS IS A FILE OF ITS OWN. On PostgreSQL 12+ (both projects run 17)
-- `alter type … add value` may run inside a transaction block, but the new
-- label cannot be USED until that transaction commits — referencing it earlier
-- raises "unsafe use of new value of enum type". The Supabase CLI runs each
-- migration file in its own transaction, so "0005, then 0006" is exactly the
-- commit boundary the rule wants. Nothing reads these labels until 0006.
--
-- PRODUCTION DATA TOUCHED: none. No row changes, no default changes, no gate
-- changes. A phone that syncs one second after this commits behaves the same.
--
-- ROLLBACK: none available and none needed. An enum label with no row carrying
-- it and no gate naming it is inert; if the rest of the sequence is abandoned
-- this stays applied and costs nothing.
-- ============================================================================

alter type public.user_role add value if not exists 'owner';
alter type public.user_role add value if not exists 'crew_lead';
alter type public.user_role add value if not exists 'crew';
alter type public.user_role add value if not exists 'agent';
