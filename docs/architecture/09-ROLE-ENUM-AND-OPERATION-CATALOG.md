# 09 — The role-enum migration, and the operation catalog that follows

*The two P1 steps between the contract tables that merged in `0004` and a worker that can execute anything: giving `profiles.role` the target vocabulary without failing a single sync push, then putting the `op_*` spine on top of it.*

**Version:** 1 · **Repo read:** `main` @ `783b79f` · **Companion documents:** [03-TARGET-ARCHITECTURE-AND-ROADMAP.md](03-TARGET-ARCHITECTURE-AND-ROADMAP.md) (cited as "03 §n"), [08-VOICE-CONTROL-ROADMAP.md](08-VOICE-CONTROL-ROADMAP.md), [04-OPEN-QUESTIONS.md](04-OPEN-QUESTIONS.md)

**Basis.** Code was read over docs: `supabase/migrations/0000_baseline.sql` (the production dump), `0004_backbone_contract_tables.sql`, `.github/workflows/db-replay.yml`, and the three edge functions that read `profiles.role`. Citations are `path:line` from the repo root. Three places where the plan of 03 §2.4 / §8.5.3 cannot be executed as written are marked **CORRECTION** and collected in §9. Live row counts were verified against production on 2026-09-19 as an aggregate (`select role, count(*) from profiles group by 1`); reading the eleven people out one row at a time is gated for every session in this project, which is why §4.2 keys the remap on email rather than on uuids that nobody can read out to review.

---

## 0. The short answer

`profiles.role` is a Postgres enum with four values — `admin, tech, viewer, office` (`0000_baseline.sql:159-166`) — and eleven live rows. The target is six text roles: `owner, office, crew_lead, crew, viewer, agent`. Nine places in the database and three edge functions read the old vocabulary, and one of them, `_sync_guard`, is called by `push_project` on **every field-app sync**. Remap the column and rewrite those readers in separate deploys and the crew's phones stop syncing in between.

So it is three migrations, and the order is forced:

| | Migration | What it does | Transaction |
|---|---|---|---|
| **N** | `0005_role_enum_add_values.sql` | `alter type user_role add value` × 4. Nothing reads them yet. | its own — the values are unusable until it commits |
| **N+1** | `0006_role_remap_and_dual_vocabulary.sql` | rewrites every gate to accept **both** vocabularies, then remaps the eleven rows, then asserts `push_project` still resolves `_sync_guard(text)` | **one** — if any part fails, nothing is remapped |
| **N+2** | `0007_role_enum_to_text.sql` | a week later: `profiles.role` becomes `text` with a check constraint over the six target names, and `user_role` is dropped | its own |

Between N+1 and N+2 the database answers to both vocabularies and every old name is still a legal value, which is the week in which a rollback costs one `update`. After N+2 the old names are gone and the repo's own convention (03 §3.4: *enumerations are `text` with a check constraint, never a Postgres enum*) holds for the last enum that broke it.

Then the operation catalog (§7): six spine functions, five first operations, and the CI job that publishes `operation_catalog` from `packages/domain/ops` so the database never invents an operation.

---

## 1. What reads the role today — the complete list

Everything below is in the production dump. This is the list N+1 has to rewrite in one transaction; anything missed here is a lane that breaks the moment the eleven rows change.

### 1.1 In the database

| # | Reader | Where | Gate as written | Breaks how, after a bare remap |
|---|---|---|---|---|
| 1 | `_sync_guard(p_build text)` | `0000_baseline.sql:291-334` (`:299`) | `role in ('tech','admin','office')` | **every field push fails** — `push_project` calls it first thing |
| 2 | `is_admin()` | `:982-990` | `role = 'admin'` | returns false for everyone; photo delete and `restore_photo` close |
| 3 | `contact_mark_review_asked(uuid)` | `:474-501` (`:485`) | `v_role not in ('admin','office','tech')` | the never-ask-twice review stamp refuses every caller |
| 4 | `contact_merge(uuid,uuid)` | `:505-591` (`:519`) | `v_role not in ('admin','office')` | contact merge refuses the owner |
| 5 | `contact_resolve(…)` | `:595-779` (`:628`, `:630`) | `in ('admin','office','tech')`, plus `role = 'viewer' and email = 'phone-agent@roybalconstruction.com'` | lead intake stops resolving contacts; **the phone agent's branch dies twice over** — its role becomes `agent` |
| 6 | `coordination_job_patch(uuid,jsonb)` | `:783-830` (`:800`) | `v_role not in ('admin','office')` | the board's rev-bumping patch silently no-ops (returns null by design) |
| 7 | `restore_photo(uuid,uuid)` | `:1488-1586` (`:1498`) | `not public.is_admin()` | inherits #2 |
| 8 | `field_photos` policies ×4 | `:4944-4965` | `role = ANY (ARRAY['tech'::user_role, …])` | crew read/write/update and admin delete all close |
| 9 | `sync_fleet` view | `:3322-3338` (`:3329`) | `p.role = 'viewer'::user_role` → "n/a (service account)" | mislabels the machine accounts; **also blocks N+2** — a view depending on the column stops `alter column … type text` |
| 10 | `handle_new_user()` | `:960-979` | inserts `role = 'tech'` | new signups land in a value that no longer exists after N+2 |
| 11 | `current_role_name()` | `0004:130-159` | `case p.role::text when 'admin' then 'owner' … end` — **no `else`** | returns **null** for a remapped profile, so every policy on the nine contract tables denies (**CORRECTION 1**) |

### 1.2 Outside the database

| Reader | Where | Gate | Note |
|---|---|---|---|
| `gmail-proxy` | `supabase/functions/gmail-proxy/index.ts:131`, `:181` | `OFFICE_ROLES = ["admin","office"]` | reads `profiles.role` directly |
| `qb-time-proxy` | `supabase/functions/qb-time-proxy/index.ts:130`, `:179` | `OFFICE_ROLES = ["admin","office"]` | same |
| `qbo-proxy` | `supabase/functions/qbo-proxy/index.ts:219-220`, `:272`, `:416`, `:472` | `OFFICE_ROLES`, `STAFF_ROLES = ["admin","office","tech"]` | same; four sites |

**CORRECTION 2.** 03 §2.4 lists only the SQL gates. These three functions are deployed artifacts, not migrations — they are **not** inside N+1's transaction, and the moment the eleven rows are remapped, an owner reading `owner` is not in `["admin","office"]`. **The edge deploy that widens all three to both vocabularies has to be live before N+1 runs**, and it is the one part of this sequence that cannot be rolled back by a transaction. It is additive — the arrays grow, nothing is removed — so it is safe to deploy days early and harmless if N+1 is postponed.

**What does *not* break.** The 29 `AS RESTRICTIVE` policies that fence the machine accounts (`0000_baseline.sql:4761-5065`, "26" in 03 §2.4 — the dump counts 29) match on `auth.email()`, not on role, so the remap does not touch them. Replacing them with one role/kind predicate is a real item (`findings.json:1231`) and it now has the `agents` and `agent_authority` rows it needs, but it is a **separate migration in the same phase** — folding 29 policy rewrites into N+1 would make the one transaction unreviewable for no scheduling gain. The apps hold no role concept at all (`grep -rn '\brole\b' apps/*/js` finds chat-message roles and contact roles only), so no client ships with these three.

---

## 2. Why three, and why this order

**The enum rule.** Both projects run PostgreSQL 17 (production `17.6.1.084`, staging `17.6.1.166` — read from the Supabase API 2026-09-18), so `alter type … add value` *may* run inside a transaction block, but the new value cannot be **used** until that transaction commits — referencing it earlier raises `unsafe use of new value of enum type`. The Supabase CLI runs each migration file in its own transaction, so "migration N, then migration N+1" is exactly the commit boundary the rule wants. That is the whole reason N exists as a file of its own; it is not a style choice.

**The sync rule.** `push_project` → `_sync_guard` runs on every sync from every phone in the field (`00-SYSTEM-INVENTORY.md` records the fleet in `sync_clients`). There is no window in which the gate may disagree with the column. Hence N+1 rewrites **before** it remaps, in one transaction: at no instant does a committed state exist where a crew member's role is `crew` and the guard only knows `tech`.

**The rollback rule.** An enum value cannot be removed once added, so N is not reversible as such — but an unused value is inert, which is what makes it safe to ship alone. N+1 is reversible for exactly as long as the old names remain legal, which is why dropping them is a third migration a week later rather than the tail of the second.

**CORRECTION 3.** 03 §2.4, §7.3 and §8.5.3 all say "N+2 drops the old names". **PostgreSQL has no `ALTER TYPE … DROP VALUE`** — there is no statement that removes an enum label. N+2 therefore does the thing that actually drops them: converts `profiles.role` to `text` with a `check` constraint over the six target names and drops the `user_role` type. This is not a workaround, it is the repo's own convention arriving late (03 §3.4 names `user_role` as *the one existing enum* that forces this whole three-step dance), and it means there is never a fourth migration to retire the enum afterwards.

---

## 3. Step N — `0005_role_enum_add_values.sql`

**What it changes.** Four labels onto `public.user_role`, which becomes `admin, tech, viewer, office, owner, crew_lead, crew, agent`. `office` and `viewer` already exist and are reused.

```sql
alter type public.user_role add value if not exists 'owner';
alter type public.user_role add value if not exists 'crew_lead';
alter type public.user_role add value if not exists 'crew';
alter type public.user_role add value if not exists 'agent';
```

`if not exists` makes the file re-runnable, which matters because a migration that half-applies here cannot be repaired by re-running a bare `add value`.

**Production data touched: none.** No row changes, no default changes, no gate changes. Every reader in §1 still sees the same values in the same rows. A phone that syncs one second after this commits behaves identically.

**Rollback.** None available, and none needed. An enum label with no row carrying it and no gate naming it is inert. If the rest of the sequence is abandoned, `0005` stays applied and costs nothing; the labels are consumed by N+2's type swap either way.

**Verify.** `select enum_range(null::public.user_role)` returns eight labels on staging and then production. `select role, count(*) from profiles group by 1` is unchanged. One field device syncs.

---

## 4. Step N+1 — `0006_role_remap_and_dual_vocabulary.sql`

One transaction, in this order. The order inside the file matters as much as the order of the files: **every rewrite lands before the first row moves.**

### 4.1 Rewrite the gates to both vocabularies

Two conventions make this migration smaller and make N+2 nearly free:

1. **Compare `role::text`, never the enum literal.** Once every gate reads text, N+2's change of the column's type touches no function body and no policy.
2. **One helper, not eleven arrays.** Add `public.role_is(variadic text[])` — `stable`, `security definer`, `search_path` pinned, reading `profiles` for `(select auth.uid())` in the initplan form — which normalises whatever the row holds into the target vocabulary and then tests membership. Each gate becomes one call, and the dual-vocabulary knowledge lives in one place that N+2 simplifies.

The normalisation is the one already written in `current_role_name()` (`0004:130-159`), extracted: `admin → owner`, `tech → crew`, `office → office`, `viewer → viewer`, and — **CORRECTION 1** — an `else p.role::text` passthrough so a profile already holding a target name returns it instead of null. Without that passthrough, the nine contract tables merged in `0004` become unreadable to everyone the moment this migration remaps a row.

| Gate | Becomes |
|---|---|
| `_sync_guard` | `role_is('owner','office','crew_lead','crew')` — the four roles that may write `field_projects`. `viewer` and `agent` still cannot sync, as today |
| `is_admin()` | `role_is('owner')` |
| `contact_mark_review_asked` | `role_is('owner','office','crew_lead','crew')` |
| `contact_merge` | `role_is('owner','office')` |
| `contact_resolve` | `role_is('owner','office','crew_lead','crew')`; the phone-agent branch becomes `role_is('agent','viewer') and v_caller_email = 'phone-agent@roybalconstruction.com'` |
| `coordination_job_patch` | `role_is('owner','office')` |
| `restore_photo` | unchanged — inherits the new `is_admin()` |
| `field_photos` ×4 | `drop policy` + `create policy` using `role_is(…)`; read adds `agent`, write/update keep `owner, office, crew_lead, crew`, delete is `is_admin()`. Policy **count is unchanged** (4 in, 4 out) |
| `sync_fleet` | `create or replace view` — the status arm becomes `role_is`-shaped text comparison, so it no longer pins the column's type |
| `handle_new_user()` | inserts `'viewer'` instead of `'tech'` |
| `current_role_name()` | delegates to the same normalisation, with the `else` passthrough |

Because `role_is` resolves old **and** new names to the same answer, every one of these is correct both before and after §4.2 runs — which is the property the whole three-step shape exists to buy.

**The one behaviour change that is not a widening:** `handle_new_user()`. Public signup is on (`00-SYSTEM-INVENTORY.md`), and today a stranger who signs up lands on `tech`, which `_sync_guard` admits — they can write `field_projects`. `viewer` is the least-privilege target role and, after §4.2, is held by nobody, so it is free to take. **Decided by the owner 2026-09-19:** new signups land on `viewer` (read-only) and a real crew member is set to `crew` in the admin the day they are handed a phone. This is the only line in the three migrations that changes what a human experiences.

### 4.2 Remap the eleven rows

Never `update profiles set role = 'owner' where role = 'admin'`. 03 §2.4 asks for an explicit `(profile_id, old_role, new_role)` table reviewed in the PR. The table below is that, with one change of key: it names people by **email**, not uuid. Two reasons. A reviewer can check an email against the admin's user list and cannot check a uuid against anything; and reading individual person rows out of production is gated for every session in this project (§5.1), so a uuid-keyed table could never be written by the same hands that write the migration. `auth.users.email` is the join 03 §2.4 itself uses when it says `branden@roybalconstruction.com → owner`.

```sql
-- The named people (§5.2) and the two machine accounts: one explicit row each.
update public.profiles p
   set role = r.new_role::public.user_role
  from (values
    ('branden@roybalconstruction.com',      'admin',  'owner'),      -- Branden Roybal, owner
    ('<CJ — Clinton Smith>',                'admin',  'crew_lead'),  -- Project Manager; holds the second admin login today
    ('<David Jarman>',                      'tech',   'crew_lead'),  -- lead carpenter, runs a crew
    ('<Gregory Costa>',                     'tech',   'crew_lead'),  -- lead carpenter, runs a crew
    ('phone-agent@roybalconstruction.com',  'viewer', 'agent'),
    ('office-brief@roybalconstruction.com', 'viewer', 'agent')
  ) as r(email, old_role, new_role)
  join auth.users u on lower(u.email) = lower(r.email)
 where p.id = u.id
   and p.role::text = r.old_role;   -- a row already moved is skipped, not clobbered
-- assert: found = 6

-- Everyone still holding tech is a crew member (03 §2.4: tech → crew) —
-- the five techs the owner did not name, after the §5.2 (3) review.
update public.profiles set role = 'crew' where role::text = 'tech';
-- assert: found = 5
```

then a `DO` block asserting the two counts above, that `profiles` still has exactly eleven rows, that exactly one row holds `owner`, three hold `crew_lead`, five hold `crew`, two hold `agent`, none hold `office`, and none is left holding `admin` or `tech`. The count assertions are what make this as safe as a per-row list: if the fleet has changed since the counts in §5.1 were read, the migration stops before it commits and the reviewer re-decides the mapping rather than the migration guessing. Listing `old_role` in each predicate is what makes the file safe to re-run and what makes a hand-edited row in production fail loudly instead of quietly.

The two machine rows also get their `agents` link in the same transaction: `update public.agents a set auth_user_id = u.id from auth.users u where a.id = '4b3353d3-…' and lower(u.email) = 'phone-agent@roybalconstruction.com'`, and the same for `'1af33481-…'` with `office-brief@` — the fixed ids seeded in `0004:966-973`, which exist precisely so a later migration can name them.

### 4.3 Assert the sync path still resolves

The `DO` block 03 §2.4 asks for, plus the two that matter as much:

```sql
do $$
begin
  perform 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = '_sync_guard'
     and pg_get_function_identity_arguments(p.oid) = 'p_build text';
  if not found then raise exception 'push_project can no longer resolve _sync_guard(text)'; end if;

  if exists (select 1 from public.profiles where role::text in ('admin','tech')) then
    raise exception 'remap incomplete: a profile still holds an old role name';
  end if;

  if (select public.current_role_name()) is null and auth.uid() is not null then
    raise exception 'current_role_name() returns null for a remapped profile';
  end if;
end $$;
```

### 4.4 Production data touched

- **`public.profiles`, 11 rows, the `role` column only.** Nothing else in the database holds a role value. `sync_clients`, `crew_members`, `contacts` and the blob carry none.
- **No JWT is invalidated**, because the Custom Access Token hook is not deployed — the claim does not exist yet, so `current_principal()` and `current_role_name()` read `profiles` on every call and the remap takes effect at the next statement, for everyone, at once. That is why the rewrites must be in the same transaction. When the hook *is* armed (a later P1 step), a role change starts lagging until token refresh and demotions must also revoke sessions [A-0.8]; that is not this migration's problem, and arming the hook is gated on the owner's confirmation of the two `admin` rows (04 §C1).
- **Nothing is written to the nine contract tables.** They stay read-only until the op spine of §7.
- **`pending_actions` is untouched** and remains the live approval spine until P2.

### 4.5 Rollback

The whole file is one transaction: a failure anywhere leaves production exactly as it was, including the eleven rows. After a successful commit, the rollback while N+2 has not run is one statement — the same `values` list with `old_role` and `new_role` swapped — because every old label is still legal and every gate still accepts it. The edge functions need no revert: they accept both vocabularies either way. **This window is the reason for the week.**

### 4.6 Verify

Staging first, per the DB-push pipeline: rehearse on `efbuagiwowcwwsezkgsw` before the production run on `djpgvcvhvgrzgaziruze`.

1. `supabase db reset` in CI (`db-replay.yml`) passes and the census is unchanged — **no number moves in N+1**: 4 policies replaced by 4, functions redefined not added (`role_is` is +1; bump `EXPECT_FUNCTIONS` 54 → 55 in the same PR), enums still 7, views still 5.
2. A pgTAP/`test.sql` block: a JWT whose profile is `crew` calls `push_project` and succeeds; the same JWT calls `contact_merge` and is refused; an `owner` JWT calls both and succeeds.
3. `select * from sync_fleet` — the two machine rows still read "n/a (service account)".
4. **Every device in `sync_clients` pushed successfully during the window** (03 §7.3's own verify line): `select email, role, build, last_seen from sync_fleet order by last_seen desc` immediately before and roughly an hour after, with no row going quiet that was not already quiet.
5. The three edge lanes: open the Gmail card in the admin, pull QB Time, fetch a QBO payment link — each as the owner, whose role is now `owner`.

**When to run it.** Not on a working morning. The rehearsal is on staging any time; the production apply wants an hour when the crews are not mid-sync — early evening Alaska time, after the last clock-out and before the brief.

---

## 5. Data the plan still needs

### 5.1 What production says, and what it will not say

Verified on 2026-09-19, read-only, as an aggregate: **admin 2, tech 7, viewer 2 — eleven rows**, unchanged from `00-SYSTEM-INVENTORY.md` §11 (2026-09-06), and **zero `office` rows** — the label exists since migration 216 and nobody has ever held it. The two viewers are the machine accounts (`0000_baseline.sql:630` names `phone-agent@`, and the "brief agent cannot …" fences from `:4761` name `office-brief@`).

The per-row read (`select id, email, role from profiles …`) is refused by the permission classifier in **every** session in this project, including the one whose gate is otherwise open for production reads — the trigger is the row grain of a people table, not the columns asked for. That is a fact about how the project is configured, and it is why §4.2 is keyed on email with asserted counts rather than on a uuid list nobody could produce. The migration itself runs as `postgres` through `db-push.yml` and reads whatever it needs; only the *review* had to be reshaped.

Any count other than 2 / 7 / 2 at the time `0006` is written means the fleet changed and the mapping is re-decided before the migration is written — the assertions in §4.2 enforce that, they do not adjust to it.

### 5.2 The people, as the owner named them

Answered by the owner on 2026-09-19, in three messages: *"I am the only one in the office at the moment. Branden Roybal, branden@roybalconstruction.com. I have a project manager, Clinton Smith, he goes by CJ. And I have two lead carpenters that run crews, David Jarman and Gregory Costa."* Then: *"CJ does not need company email and QuickBooks access."* Then: *"The second admin login is CJ's."* That fixes the mapping:

| Person | Today | Target | Why |
|---|---|---|---|
| Branden Roybal, `branden@roybalconstruction.com` | `admin` | **`owner`** | the owner; 03 §2.4 names this row |
| CJ (Clinton Smith), Project Manager | `admin` (the second admin login) | **`crew_lead`** | the owner ruled CJ does not need company email or QuickBooks. `office` unlocks all three (`OFFICE_ROLES` in the Gmail, QB Time and QBO proxies, §1.2), so `office` is out. `crew_lead` executes on his crews' jobs and schedules and proposes everything else for the owner to approve, which is the owner's standing posture. See "what CJ loses" below |
| David Jarman, lead carpenter | `tech` | **`crew_lead`** | runs a crew; may execute on own crew's jobs and approve own crew's schedule |
| Gregory Costa, lead carpenter | `tech` | **`crew_lead`** | same |
| the other five techs | `tech` | **`crew`** | 03 §2.4: tech → crew; reviewed per (3) below |
| `phone-agent@`, `office-brief@` | `viewer` | **`agent`** | the two machine accounts; linked to their `agents` rows in the same transaction |

After N+1: one `owner`, three `crew_lead`, five `crew`, two `agent`, and **no `office` row** — 04 §C1's default (second admin → `office`) is overruled by the owner's own answer, and the role stays unheld until the office hire that 08 §4 J6 anticipates. Nobody maps to `viewer` either, which is what frees it for the signup default in §4.1. The owner still confirms the two `admin` mappings in the admin UI before the role claim is armed (04 §C1); that gates the *hook*, not this migration.

**What CJ loses, stated so nobody is surprised.** CJ holds `admin` today, so `0006` is a narrowing for him and him alone. Gone: the Gmail, QB Time and QBO proxies (his own ruling); the admin app's **Leads** write path, which rides `coordination_job_patch` (`apps/admin/js/leads.js:80`, gated `admin|office`); contact **merge** in the admin (`apps/admin/js/contacts.js`, `contact_merge`); photo **delete** and `restore_photo` (`is_admin()`). Kept: the job board, the field app, sync, photo read/write, contact lookup, and every proposal he cares to make. If CJ works the Leads tab today, that is the one thing to raise with the owner before `0006` — the fix is a `role_permissions` row and a gate that admits `crew_lead` for lead triage, not a different role for CJ.

Three details, all collected when `0006` is written:

1. ~~Which login is the second `admin`~~ — answered: CJ's.
2. **The three emails.** CJ's, David's and Gregory's login emails go into the `values` list verbatim. They are visible to the owner in the Supabase dashboard's Auth → Users page and in the admin app; they are not readable from a project thread (§5.1).
3. **Nine human logins, four names.** Two `admin` plus seven `tech` is nine human logins; the owner named four people. The other five `tech` rows are the rest of the crew — or some of them are former employees whose logins were never disabled. Today that matters little (`tech` already has staff access through `STAFF_ROLES`); after N+1 it matters exactly as much, because `crew` inherits the same access. So the `tech → crew` statement in §4.2 is not applied blind: the PR for `0006` lists the emails it will move (from the Auth → Users page), the owner strikes any that no longer work here, and those rows are **disabled in Auth, not remapped** — a departed employee's login ends at the migration, it does not get a new role. The count assertion then reflects the list as reviewed.

## 6. Step N+2 — `0007_role_enum_to_text.sql`

A week after N+1, with the fleet's `last_seen` column showing every device has pushed since.

**What it changes.**

```sql
drop view if exists public.sync_fleet;      -- depends on the column's type

alter table public.profiles
  alter column role drop default,
  alter column role type text using role::text,
  alter column role set default 'viewer',
  add constraint profiles_role_check
    check (role in ('owner','office','crew_lead','crew','viewer','agent'));

drop type public.user_role;
create or replace view public.sync_fleet as …;   -- recreated verbatim, text column
```

and `role_is` loses its old-name arm, becoming a plain membership test. Because §4.1 made every gate compare `role::text`, **no other function or policy changes in this file**.

**Production data touched.** The `profiles.role` column's type, on 11 rows. No value changes — every row already holds a target name, which the new check constraint verifies at `alter table` time: if any row still holds `admin` or `tech`, this migration fails and nothing is altered. That is the intended behaviour and it is the reason the constraint is added in the same statement group rather than later.

**Census.** `EXPECT_ENUMS` 7 → 6 in the same PR, with the one-line comment `db-replay.yml` asks for. Tables, policies, triggers, views, functions and pk/unique are all unchanged (a `check` constraint is `contype = 'c'`, which the census does not count).

**Rollback.** Recreate the enum and cast back — mechanical, but it is the point at which the old vocabulary is genuinely gone, so the real rollback for anything discovered after N+2 is a forward fix. Hence the week, and hence §4.6's fleet check being a precondition to running this file rather than a report after it.

---

## 7. The operation catalog that follows

`0004` created `operation_catalog` and left it empty, and created `proposals`, `events`, `jobs_queue` and `outbox` with no function able to write to them — writes are granted to nobody and arrive only through `security definer` `op_*` functions (`0004:35-53`). This is that step. It depends on the role migration only in that `role_permissions` is keyed on the target vocabulary, which N+1 makes true of `profiles.role` as well.

### 7.1 The spine — `0008_op_spine.sql`

Six functions, each `security definer`, `search_path` pinned, `revoke all … from public` and granted per the table below. 03 §7.3 names them; what follows is what each one has to do given the tables as merged.

| Function | Signature | Does | Granted to |
|---|---|---|---|
| `emit_event` | `(kind, operation, aggregate_type, aggregate_id, job_id, claim_id, proposal_id, data, idempotency_key, principal_kind, principal_id) → bigint` | the only writer of `events`; returns the existing id on a repeated `idempotency_key` rather than raising, so a retried caller is a no-op | `service_role` only; every other op calls it internally |
| `op_propose` | `(operation, input, job_id, claim_id, rationale, evidence_refs, proposed_via, p_principal_id) → proposals` | resolves `operation` → `operation_catalog` row, validates `input` against `input_schema` with `pg_jsonschema`, computes `idempotency_key` from `idempotency_template`, checks `role_permissions` (and `agent_authority` when the principal is an agent) for `propose`, allocates `sms_code` from `proposals_sms_code_seq`, sets `assigned_role` from `approval_policies`, emits `proposal.created`. A repeated key returns the existing row | `authenticated`, `service_role` |
| `op_proposal_approve` | `(proposal_id, via, second_factor, edited_params, p_principal_id) → proposals` | checks `approve` for the action type, refuses `approved_by = proposed_by` on `money`/`external`/`comms`, refuses agents outright, writes the four approval columns, emits `proposal.approved`, then either enqueues (`runtime = 'worker'`) or executes inline (`runtime = 'sql'`) | `authenticated`, `service_role` |
| `op_proposal_decline` | `(proposal_id, reason, p_principal_id) → proposals` | same authority check; emits `proposal.declined` | `authenticated`, `service_role` |
| `enqueue` | `(kind, payload, idempotency_key, run_after, priority, principal_kind, principal_id, job_id, correlation_id) → jobs_queue` | the only writer of `jobs_queue`; the target of every pg_cron row, which stays SQL-only | `service_role`; `authenticated` for the kinds `role_permissions` allows |
| `claim_job` | `(worker_id, kinds text[], lease_seconds) → jobs_queue` | `update … where id = (select … for update skip locked)` setting `locked_by`, `lease_until`; the expiry sweep is a second SQL function on pg_cron | `service_role` only |

Two rules the table does not show. **`p_principal_id` is mandatory for a service-role caller and ignored for a human one** — the worker holds the service key but acts as a named `agents` row, and `op_*` refuses a service-role call with no principal (03 §2.4, "Worker identity"). And **`roybal-webhooks` may reach exactly two of these** — `op_proposal_approve` and `op_proposal_decline` — which is what lets "YES 12" record an approval while the worker is down; a test asserts no other `op_*` is reachable from that function (03 §7.3).

`ai_reserve` / `ai_settle` are listed with these in 03 §7.3 but belong to the metering tables (`ai_caps`, `agent_runs`, `model_routes`), none of which `0004` created. They are their own migration and are out of this plan's scope.

### 7.2 The first five operations — `0009_ops_first_five.sql`

Each is a `defineOp` file in `packages/domain/ops/` whose SQL body ships beside it, per 03 §2.3:

| Operation | `action_type` | `runtime` | Emits | Idempotency key |
|---|---|---|---|---|
| `proposal.approve` | `admin` | `sql` | `proposal.approved` | `proposal.approve:<proposal_id>` |
| `proposal.decline` | `admin` | `sql` | `proposal.declined` | `proposal.decline:<proposal_id>` |
| `email.send` | `comms` | `worker` | `email.queued`, `email.sent` | `email.send:<to>:<subject_hash>:<job_id>` |
| `sms.send` | `comms` | `worker` | `sms.queued`, `sms.sent` | `sms.send:<to>:<body_hash>:<day>` |
| `job.set_stage` | `job` | `sql` | `job.stage_set` | `job.set_stage:<job_id>:<stage>` |

`email.send` and `sms.send` write an `outbox` row and nothing else; the worker delivers it. The 7 am–8 pm Alaska window that lives in three places today (`roybal-notify/index.ts:217-232`, `qb-time-proxy`, `apps/admin/js/campaigns.js:36-39`) becomes one predicate inside `sms.send`, reading `conditions.quiet_hours` from the `role_permissions` rows `0004:1035-1046` already seeded — not a constant, and not a fourth copy.

### 7.3 Publishing the catalog

`operation_catalog` is written by CI from `packages/domain/ops`, never by hand (`0004:265-266`). The job: build the definitions, hash each into `definition_sha`, upsert on `(name, version)`, and fail the build when a deployed `op_*` signature disagrees with its schema or when a catalog operation has neither an `allow` nor an explicit deny row in `role_permissions`. The seed in `0004:995-1087` is at the action-type wildcard level (`money:*`), so the first five operations need no new rows to be governed — the generator starts emitting per-operation rows only where one must override a wildcard.

### 7.4 What this unlocks, and what it does not

With §7.1 and §7.2 applied, an approval recorded from the inbox or by SMS reaches `events` and an `outbox` row without the worker existing — which is the property 03 §7.3 asks the owner to verify. Actual delivery waits for the Fly worker; the Approvals inbox in `apps/admin` is the surface. Neither is in this plan.

---

## 8. Order of work

1. Widen `gmail-proxy`, `qb-time-proxy` and `qbo-proxy` to both vocabularies; deploy. Additive, reversible, and independent of everything below. **(§1.2)**
2. `0005` — add the four enum values. Staging, then production. Inert either way.
3. Collect the three named people's login emails and review the five `tech → crew` rows with the owner (§5.2); the counts in §5.1 are re-read as an aggregate the day `0006` is written.
4. `0006` — rehearse on staging, check the fleet, apply to production in an evening window, check the fleet again an hour later.
5. Wait a week with the rollback statement written down and the old names still legal.
6. `0007` — the type swap, with `EXPECT_ENUMS` 7 → 6 in the same PR.
7. `0008`, `0009` — the op spine and the first five operations.
8. Separately, in the same phase: the 29 email-fence policies become one role/kind predicate now that `agents` exists.

Every one of these reaches production through `.github/workflows/db-push.yml` — staging rehearsal, then a manual production run gated on the owner's word. Nothing here is applied through the Supabase SQL editor or the MCP connector; 03 §8.6 is unambiguous about why, and the 2026-09-07 history repair is the receipt.

---

## 9. Corrections to 03, collected

| # | Section | Correction |
|---|---|---|
| C1 | §2.4, §7.3, §8.5.3 | "N+2 drops the old names" — PostgreSQL has no `ALTER TYPE … DROP VALUE`. N+2 converts `profiles.role` to `text` + `check` and drops `user_role`, which is 03 §3.4's own convention. |
| C2 | §2.4's gate list | `current_role_name()` (`0004:130-159`) is a role gate and is missing from the list. Its `case` has no `else`, so it returns null for a remapped profile and closes every policy on the nine contract tables. N+1 adds the passthrough. |
| C3 | §2.4, §7.3 | The three edge functions that read `profiles.role` are outside N+1's transaction and must be widened and deployed **before** it runs. §8.5.3's "Files touched" line lists `packages/db/auth.ts` and renderers, neither of which exists; the functions that do exist are not listed. |
| C4 | §2.4 | The baseline carries **29** `AS RESTRICTIVE` email-fence policies, not 26. None of them reads a role, so the remap does not touch them and their rewrite is a separate migration. |

None of these changes a table, a trust level, a role vocabulary, or an owner ruling.
