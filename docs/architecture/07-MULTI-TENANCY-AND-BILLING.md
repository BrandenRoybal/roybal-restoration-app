# 07 — Multi-Tenancy and Billing

**Prepared for:** Branden Roybal — Roybal Construction, LLC
**Date:** September 7, 2026
**Amends:** [03-TARGET-ARCHITECTURE-AND-ROADMAP.md](03-TARGET-ARCHITECTURE-AND-ROADMAP.md) decision records §5 and §7, and [04-OPEN-QUESTIONS.md](04-OPEN-QUESTIONS.md) A3
**Companion:** [../Software_Venture_Plan.md](../Software_Venture_Plan.md)
**Live project read:** `djpgvcvhvgrzgaziruze`, 2026-09-07

---

## 1. What changed, and why this is a planned turn

The venture plan commits to selling this system to other restoration contractors. That makes
per-customer isolation a product requirement rather than a hypothetical.

The architecture review already named this exact trigger. Decision record §5 closes with:

> **forcing conditions: per-customer isolation → the `org_id` claim doing real work**

And §7 closes with:

> Ceiling: single org plus divisions holds to 100+ in one legal entity; **the defaulted `org_id`
> holds to a second entity with a claim change and a predicate swap.**

So the roadmap already carries the hook. What changes is the *load* on it.

| | Before (A3, answered 2026-09-06) | Now |
|---|---|---|
| `org_id` | one defaulted value, "a column nobody notices" | the isolation boundary between paying customers |
| Scope | spine + money tables, as they are created | **every table**, before customer #1 |
| RLS | predicates written against `current_org()` in new tables | all 18 `using(true)` files rewritten |
| Failure mode | a second legal entity is awkward | **one customer reads another's claim file** |

**A3 is hereby re-answered:** option (a) stands, but promoted from *deferred default* to
*load-bearing and enforced*. This document is the amendment.

### 1.1 The venture plan's single-tenant recommendation is superseded

`Software_Venture_Plan.md` §2 recommends one Supabase project per customer, on the reasoning
that project-level isolation sidesteps `using(true)` and the missing `org_id`. That was the right
call for a 90-day gate with no schema budget. It is the wrong call now that the schema budget
exists, for one reason:

**The migration is nearly free today and gets more expensive with every customer.**

| Table | Live rows |
|---|---:|
| `price_list` | 2,959 |
| `capture_events` | 4,532 |
| `time_entries` | 1,168 |
| `ai_usage` | 920 |
| `field_photos` | 748 |
| `blob_history` | 269 |
| `sms_messages` | 171 |
| `qb_time_jobcodes` | 133 |
| `coordination_jobs` | 82 |
| `email_messages` | 64 |
| `field_projects` | **42** |
| `portal_selections` | 39 |
| `contacts` | 34 |
| `unified_jobs` | 33 |
| `rooms`, `portal_jobs`, `sync_clients`, `jobs` | 6, 3, 6, 2 |

That is roughly **12,000 rows across the whole business.** A backfill that touches every table
runs in seconds. Do this before customer #1 and there is no migration — only a default. Do it at
customer #12 and it is A3's warning made real: every policy, every unique constraint, every view
and the claim, under load, with other people's data in the table.

Do it now.

---

## 2. Where the boundary is today: nowhere

Read live on 2026-09-07.

| Fact | Count |
|---|---:|
| Tables in `public` | **54** |
| Tables carrying `org_id` / `tenant_id` / `account_id` | **0** |
| Migration files containing `using(true)` | **18** |
| Tables exposed to `anon` through pg_graphql | **50** |
| Tables exposed to `authenticated` through pg_graphql | **52** |
| `SECURITY DEFINER` functions executable by `authenticated` | **14** |
| …executable by `anon` | **6** |
| Functions with mutable `search_path` | **21** |
| `SECURITY DEFINER` view (advisor ERROR) | **1** |
| Tables with RLS on and **no** policy (deny-all except service role) | 5 |

The five deny-all tables — `app_settings`, `blob_history`, `contact_sessions`,
`field_projects_trash`, `sync_clients` — are reachable only through edge functions today. They
still need `org_id`, because the edge functions that read them will soon serve more than one
customer.

**The pg_graphql exposure is the sharpest edge.** Fifty tables reachable by the `anon` role means
the auto-generated API is a second front door that RLS is the only thing standing behind. In a
single-tenant system that is a bad day; in a multi-tenant one it is the whole company.

---

## 3. The schema change

### 3.1 `org_id` goes on all 54 tables — denormalized, not derived

Group the tables by where the value comes from, then **write it onto every table anyway**:

| Group | Count | Source of `org_id` | Examples |
|---|---:|---|---|
| **A. Root** | ~32 | assigned directly | `field_projects`, `coordination_jobs`, `unified_jobs`, `contacts`, `crew_members`, `profiles`, `time_entries`, `ai_usage`, `capture_events`, `integration_runs`, `app_settings` |
| **B. Job children** | ~17 | backfilled from `job_id` | `field_photos`, `moisture_readings`, `equipment_logs`, `line_items`, `invoices`, `documents`, `rooms`, `work_authorizations`, `tech_checkins`, `photos`, `tasks` |
| **C. Contact children** | ~5 | backfilled from `contact_id` | `sms_messages`, `email_messages`, `portal_jobs`, `contact_sessions` |

Groups B and C could in principle be reached by a join in the policy. **Do not do that.** A policy
predicate that joins is evaluated per row; the review already makes this point about
`assigned_job_ids()` being an initplan rather than a per-row join. Denormalize `org_id` onto the
child, backfill it once, and hold it true with a trigger that copies the parent's value on insert
and refuses an update that would change it.

```sql
alter table field_photos add column org_id uuid not null default '<roybal-org-uuid>';
update field_photos c set org_id = p.org_id from field_projects p where p.id = c.job_id;
create index on field_photos (org_id);
```

The `default` is what makes this non-breaking: every existing writer keeps working untouched
while the column fills in. Drop the default only after §6 step 5.

### 3.2 The two tables that are not simply per-tenant

**`price_list` (2,959 rows)** is reference data, not customer data. A restoration price list is
most of the product's value on day one, and a new customer with an empty one has bought nothing.
Model it as `org_id uuid null`, where `null` means *global, readable by every org*, plus
per-org rows that override by code. The read path is "my org's row if it exists, else the global
one." This is the single most valuable thing you ship them at signup.

**`gmail_tokens`, `qbo_tokens`, `qb_time_tokens`** hold one row each today — the review notes
"each provider has one token row." These are per-customer OAuth credentials in a multi-tenant
world. They need `org_id`, a unique constraint on `(org_id, provider)`, and the OAuth callback
has to learn which org it is completing a connection for. **This is the hardest integration work
in the whole change**, and it is a reason §5 of the venture plan holds QuickBooks and Gmail out
of the sellable scope for now. Give them `org_id` in this migration; wire per-org OAuth later.

### 3.3 Storage is a tenant boundary too

`field-media` holds content-addressed photo bytes. Object keys are hashes today, so nothing in
the path says who owns the file, and a storage policy cannot tell one customer's bytes from
another's. Move to `field-media/<org_id>/<hash>` and write storage policies against the first
path segment. The sync engine's media upload and `downloadRemembered` both need the prefix.

Photographs of the inside of people's houses are the most sensitive thing in this system. A
correct RLS story with an open bucket is not a correct story.

---

## 4. Enforcement

### 4.1 The claim and the helper

Per §5, the Custom Access Token hook stamps `principal_id`, `role`, `division_id` and `org_id`.
Add the helper the predicates read:

```sql
create or replace function current_org() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'org_id','')::uuid,
    (select org_id from profiles where id = (select auth.uid()))   -- old tokens, mid-cutover
  );
$$;
```

`STABLE` and the `(select auth.uid())` initplan form are not stylistic — they are what keeps the
predicate off the per-row path. The `profiles` fallback matters because the field app holds tokens
until under 60 s before expiry (`apps/field/js/supa.js:34-86`), so a fleet of phones will present
pre-hook tokens for a while after the hook ships.

### 4.2 Every policy gets the same first clause

All 18 `using(true)` files are rewritten so that **org identity is checked before role**:

```sql
-- before
create policy p on field_photos for select using (true);

-- after
create policy p on field_photos for select
  using (org_id = current_org() and (<the existing role/assignment rule>));
```

Role logic stays exactly as §5 designed it — owner/office read the claim, crew calls
`assigned_job_ids()`, the walk-on rule stands. `org_id = current_org()` is an additional gate in
front, never a replacement.

### 4.3 Close the pg_graphql front door

Fifty tables reachable by `anon` is not something RLS should have to carry alone. Revoke blanket
`anon` and `authenticated` grants on the tables the apps do not read directly, and re-grant per
table deliberately. Same pass: fix the 21 mutable `search_path` functions and the advisor's
`security_definer_view` ERROR, and re-check the 6 `SECURITY DEFINER` functions callable by `anon`
— a definer function is a hole straight through RLS, and in a multi-tenant database it is a hole
into other people's claims.

### 4.4 The test that makes this safe

One test, and it is the most important artifact in this document:

> Seed two orgs with a full job each. Sign in as org A. For **every one of the 54 tables**, assert
> the row count visible from A that belongs to B is zero. Repeat for insert, update and delete.
> Then repeat the whole thing through pg_graphql and through the storage API.

Table-driven off `information_schema`, so **a new table with no policy fails the test by
existing**. Wire it into `ci.yml` as its own step. Without this, "we added org_id" is a belief;
with it, it is a check that runs on every push.

---

## 5. Billing: tracking paying customers

Stripe subscriptions, chosen 2026-09-07. Card on file with automatic dunning, rather than
invoice-and-chase — the model that currently has $136,923.94 outstanding on the construction side.

### 5.1 Tables

```
orgs(id, name, slug, created_at, status, plan,
     stripe_customer_id, stripe_subscription_id,
     trial_ends_at, current_period_end, seats_limit)

subscriptions(id, org_id, stripe_subscription_id, status, plan,
              current_period_start, current_period_end,
              cancel_at_period_end, updated_at)   -- mirror of webhook state

billing_events(id, org_id, stripe_event_id unique, type, payload jsonb, received_at)
```

`billing_events` is insert-only with a unique `stripe_event_id`, which is how webhook retries
become no-ops. Stripe delivers at-least-once; without that constraint a retried
`invoice.paid` double-counts.

**Stripe is the source of truth; these tables are a cache.** Never compute entitlement from local
arithmetic — read the mirrored `status`, and reconcile nightly against the Stripe API so a missed
webhook self-heals.

### 5.2 States and what each one does

| `status` | Access | Notes |
|---|---|---|
| `trialing` | full | 14 days, no card, seeded with the global price list |
| `active` | full | |
| `past_due` | **full, with a banner** | Stripe retries over ~2 weeks. Do not cut off a crew mid-loss because a card expired. |
| `canceled` / `unpaid` | read-only, export enabled | 30-day window, then archive |

The `past_due` row is a deliberate product decision. This software is used standing in a wet
crawlspace at 11 p.m.; a hard cutoff on a failed card is how you lose a customer permanently over
$450 and a re-issued Visa.

### 5.3 The webhook

A new edge function `roybal-billing` — **`verify_jwt = false`, signature-verified instead**, the
same shape as the Twilio `/status` route E0 added to `roybal-notify`. Subscribe to
`customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`. Handler: verify signature →
insert `billing_events` (unique id absorbs retries) → upsert `subscriptions` → update
`orgs.status`.

Gating lives in one place: a `require_active_org()` check in the ops dispatcher, not scattered
through the UI. The UI reads status to render a banner; it is not the enforcement point.

### 5.4 What is deliberately not built

No self-serve signup. At $2,500 setup and five design partners, the owner provisions each org by
hand through an admin screen — `org.create` seeds the org, invites the owner user, connects the
Stripe customer. Self-serve is a week of work that buys nothing until there is inbound demand,
and every hour it costs is an hour not spent on the six-per-week customer development the venture
plan calls for.

---

## 6. Migration sequence

The constraint from §5 is absolute and applies here: **no push fails at any instant.** Crews are
on job sites while this ships. Follow the same N / N+1 / N+2 shape the role migration uses.

1. **`orgs` + backfill.** Create `orgs`, insert the Roybal row, add `org_id uuid not null
   default '<roybal-uuid>'` to all 54 tables, backfill B and C from their parents, index every
   `org_id`. Nothing reads it yet. **Fully reversible; zero behaviour change.**
2. **Claim + helper.** Ship the JWT hook stamping `org_id`, and `current_org()` with the
   `profiles` fallback. Old tokens keep working through the fallback. Still nothing enforces.
3. **Policies, table by table.** Rewrite each `using(true)` to `org_id = current_org() and (…)`.
   One table per commit, isolation test green after each. This is the long step and it is meant to
   be — it is also the one that can be paused mid-way without breaking anything.
4. **Storage prefix.** `field-media/<org_id>/<hash>`, storage policies, sync engine updated on
   both the upload and download paths. Migrate existing objects under the Roybal prefix.
5. **Drop the defaults, add `not null` without default.** From here a writer that forgets `org_id`
   fails loudly instead of silently writing into the Roybal org. **This is the point of no return
   and the point at which the system is actually multi-tenant.**
6. **Lock the front door.** Revoke blanket pg_graphql grants, fix `search_path` on 21 functions,
   the definer view, and the 6 anon-callable definer functions.
7. **Billing.** `orgs` billing columns, `subscriptions`, `billing_events`, `roybal-billing`
   webhook, `require_active_org()` in the dispatcher, the admin provisioning screen.
8. **Prove it.** Provision a throwaway second org. Run the isolation test. Then have somebody who
   is not you try to read across the boundary.

Steps 1–2 are safe to land immediately and independently. Step 5 is the commitment.

---

## 7. How this fits the existing roadmap

This is not a new phase competing with P1–P7. It is a widening of **P1** (which already carries
`role_permissions`, the role migration and the JWT hook) plus a new billing slice.

| Roadmap item | Effect |
|---|---|
| **P1** — thin backbone, role migration, JWT hook | **Widened.** The hook stamps `org_id` too; the spine tables get it at creation. Add steps 1–6 above. |
| **P2** — `billing.reconcile` / `invoice.review_gaps` | Unchanged. Note the name collision: P2's "billing" is *your customers' claim billing*, §5 here is *your software subscription billing*. Different things. Rename one before they are both in the codebase. |
| **P3** — domain tables, `unified_jobs` → `jobs` | Every new table is born with `org_id`. Cheaper than retrofitting, which is the whole point. |
| **P4** — documents | `document_sequences` unique on `(org_id, kind, year)` per §7 — a shared sequence across customers is an invoice-number collision and a serious one. |
| **P5** — office UI, `ar_aging` view | Materialized views must carry `org_id` or leak in aggregate. A cross-tenant total is still a leak. |

**One thing to reject explicitly:** do not sell to customer #1 before step 5. A tenant boundary
that is present but not enforced is worse than no boundary, because it reads as done.

---

## 8. Risks

1. **A single missed policy leaks a customer's claim file.** This is the whole risk and it does
   not degrade gracefully — there is no partial credit. §4.4's table-driven test is the only real
   mitigation, and it must fail on a table that does not exist yet.
2. **Per-tenant OAuth is genuinely hard.** QuickBooks, Gmail and QB Time assume one connection.
   Give the token tables `org_id` now; keep those integrations out of the sold scope until they
   are properly per-org.
3. **Storage lags the database.** It is easy to ship org_id on 54 tables and leave the bucket
   open. Step 4 is not optional and not last.
4. **The blob is still the system of record.** `field_projects` is one JSON document per job, and
   `org_id` gates the row but not what is inside it. The sync RPC (`push_project`) must check
   `current_org()` on both the read and the write, or a crafted push writes into another org's row
   through the merge path.
5. **Scope creep into the backbone rebuild.** This change is org isolation and billing. It is not
   P3's domain tables and not §6's blob strategy. Land it, sell something, then continue.
6. **Two meanings of "billing" in one codebase.** See P2 above. Fix the naming now, in the plan,
   not later in a debugger.

---

## 9. Assumptions and exclusions

**Assumptions**
- Live counts read from `djpgvcvhvgrzgaziruze` on 2026-09-07; ~12,000 rows total across 54 tables.
- Table grouping in §3.1 is from live `pg_attribute` link columns; exact per-table assignment gets
  confirmed during step 1.
- Stripe test mode throughout development; no live key before step 5 passes the isolation test.
- The provisioning flow is owner-run. Self-serve signup is out of scope.

**Exclusions**
- No per-tenant custom domains, white-labelling, or per-tenant Twilio numbers (the venture plan's
  single-tenant model assumed one number per customer; shared-tenancy needs a different answer,
  and it is not solved here).
- No usage-based or metered pricing. Flat seat tiers only.
- No data-residency or SOC 2 work. Both will be asked for eventually; neither blocks five pilots.
- Per-tenant QuickBooks/Gmail OAuth is scoped but not designed here.
- The sync data-loss bug root-caused in PR #183 was **fixed in PR #184** (`merge.js` +
  `248_merge_scalar_filled_beats_empty.sql`) — a filled scalar now beats an empty one regardless of
  stamp, on both sides of the JS/SQL merge twin. Verified here: `apps/field/test/sync.mjs` passes
  10/10, against ~50% before. Nothing in this document depends on it, but the Week 1–3 gate item
  "green CI" is now met.

---

*Roybal Construction, LLC · Fairbanks, Alaska*
