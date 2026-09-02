# Roybal CRM — Design & Roadmap

**Status:** living doc — steps 1–5 and 7–10 shipped Aug 2026; step 11 (CF-5) sends pending; §13 (the CRM home) in progress
**Date:** 2026-08-13 · §13 added 2026-09-01
**Author:** Lead engineer
**Scope:** a person-level spine (contacts, properties) under every lane we already run; lead lifecycle on the Job Board; an office contact view; and the customer-facing expansion of the portal that only a person spine makes possible. This doc absorbs and sequences — rather than respecifies — Portal Phases B1 / M2 / B4 / C1–C3 (`docs/Customer_Portal_Roadmap.md`), AI Roadmap Phases 2 / 5 / 6 (`docs/AI_Assistant_Roadmap.md`), and the Web Voice Phase 3 follow-ups (`docs/Web_Voice_Receptionist_Decision.md`).

*Every table we own is job-shaped. The business is not: it runs on people who call twice, own two properties, refer their neighbor, and need their paint color three winters later. This is the plan for adding the person — without rewriting a single thing that already works.*

---

## 1. What's actually missing

We have six customer-facing lanes running in production — quote form, web receptionist, phone receptionist, SMS, email, portal — and not one of them knows a person from a repeat person. Customer identity today is **free text copied per surface**:

| Store | What it holds | Keyed by |
|---|---|---|
| `field_projects.data` blob | `customer, phone, email, address, carrier, adjuster, claimNo` (`apps/field/js/model.js:128-157`) | job |
| `coordination_jobs.data` blob | `customer, phone, address` — no email field in the board editor (`apps/board/js/board.js:1842-1846`) | job / lead card |
| `unified_jobs` typed columns | `owner_name/phone/email`, `adjuster_*`, `property_address` (`supabase/migrations/200_ai_backbone.sql:84-109`) | job (`field_project_id` is UNIQUE) |
| `portal_jobs` | `customer_name`, `property_address` as curated text (migration 107) | share token |
| `sms_messages` | phone numbers; soft `unified_job_id` matched by last-10 digits | phone number |
| `email_messages` | addresses; `job_id` = a `field_projects` id (migration 208) | job |
| legacy `jobs` table (001, old React app) | `owner_name/phone/email`, `adjuster_*` — still applied on the remote DB; `unified_jobs.relational_job_id` crosswalks to it (`200_ai_backbone.sql:105`) | job |
| QuickBooks Online | a Customer re-resolved by **exact DisplayName string** on every invoice push, id never stored (`supabase/functions/qbo-proxy/index.ts:120-132`) | display name |

Verified consequences, not hypotheticals:

- **No dedupe anywhere.** The same person calling the phone line and then submitting the quote form produces two unlinked lead cards — `roybal-lead`, `roybal-web-agent`, and the phone agent's `createLead` contain no matching against anything (`services/phone-agent/tools.mjs:100-116`).
- **Phone leads are invisible to channel queries.** The phone lane writes no `channel` or `source` field at all — only `aiBooked: true` — so any query filtering `data->>'channel'` silently misses every phone lead.
- **Inbound texts and emails can never reach a lead.** `sms_messages.unified_job_id` matches against `unified_jobs.owner_phone`, and spine rows are created only from field projects (`apps/field/js/spine.js:43-99`) — a board-only lead has no spine row, so a new lead who texts back lands nowhere.
- **A lead has no lifecycle.** Board STAGES are lead → scheduled → in\_progress → on\_hold → final → done (`apps/board/js/board.js:20-27`); there is no won/lost, no lost reason, no follow-up date, no next action — a lead card renders identically to an in-progress job.
- **Nothing exists after `done`.** Archive is designed around completed work; the portal token dead-ends when the office flips `enabled` off; Phase C3 closeout (warranty, review ask, final documents) is roadmap-only.
- **Renaming a customer forks a QBO duplicate** on the next invoice push, and there is no way to ask "all invoices for this person" on our side.
- **The portal is a share link, not a relationship.** One token = one job (`roybal-portal` resolves `limit=1`); a repeat customer holds two unrelated links, and `publishPortal()` writes `unified_job_id: null` (`apps/field/js/portal.js:76`), so the portal row isn't even joined to the spine.

A CRM here is not a new app. It is **two new tables, a resolution function, link columns on lanes that already exist, and the customer surface that falls out** — in that order.

## 2. Locked decisions

1. **Additive only.** No existing table is renamed or repurposed; no blob field changes meaning. Every phase is independently shippable and leaves the system strictly better (same rule as every other doc in this folder).
2. **The blob stays authoritative for the crew.** `field_projects.data.customer/phone/email` keep working exactly as today, offline-first. `contactId` is a *link* stamped onto records, never a replacement — the field app must not grow an online dependency.
3. **The board stays the pipeline.** Leads remain `coordination_jobs` rows with `stage: "lead"` — the Web Voice build proved this shape ships with zero board changes. We enrich the blob; we do not move leads to a new table.
4. **No new message store.** SMS, email, portal, and call logs stay in their lanes; the unified timeline is a **view** over them keyed by `contact_id`, not a copy.
5. **Identity resolution is silent and server-side.** The Web Voice doc's prohibition stands: a self-reported phone number on a public lane must never produce a "welcome back, we know you" — that's a data-leak primitive (`docs/Web_Voice_Receptionist_Decision.md:348`). Resolution links records for the *office*; it never echoes recognition to an unverified caller or visitor.
6. **The portal's allow-list projection pattern holds.** CRM data reaches customer surfaces only through curated projections (`portalProjection()`, `customerSelection()` precedent) — a column added to `contacts` later cannot leak by being forgotten.
7. **All customer messaging stays inside the existing rails**: `roybal-notify` only, Work-Authorization opt-in, STOP, 8am–8pm quiet hours, human-in-the-loop tiers that earn their way to auto-send, everything metered on `ai_usage` under the $50/month cap (`docs/AI_Assistant_Roadmap.md:13-28`).
8. **No Xactimate price data on any customer surface**, per the Verisk EULA stance already corrected into `docs/Material_Selection_Design.md:125`.
9. **Auto-merge only on exact normalized-phone match.** Everything weaker (email, name+address) produces a *suggestion* for the office, never a silent merge. Wrongly gluing two humans together is the one unrecoverable mistake in this design. *Amended 2026-08-13 (migration 228):* a **trusted** lane may also link on exact email + exact name — the same address-book entry; a shared household email with a *different* name still only suggests. Untrusted lanes never link on anything weaker than phone, and on any match a differing non-blank value queues a `conflict` suggestion instead of overwriting — new phone numbers and changed emails surface for review rather than silently rotting or silently replacing.

## 3. The person spine — `228_contacts.sql`

Two typed tables plus a resolution RPC, in the house grant-hygiene style of migration 227.

```sql
create table public.contacts (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'person'    check (kind in ('person','company')),
  role        text not null default 'customer', -- customer | adjuster | agent | property_manager | sub | other
  name        text not null,
  company     text not null default '',
  phone       text not null default '',         -- as entered
  phone_norm  text generated always as (right(regexp_replace(phone,  '\D', '', 'g'), 10)) stored,
  email       text not null default '',
  email_norm  text generated always as (lower(btrim(email))) stored,
  address     text not null default '',         -- mailing address (properties are separate, §4)
  qbo_customer_id text,                          -- persisted on first invoice push — ends the DisplayName fork
  source      text not null default '',          -- first lane that produced this person: web-form | ai-chat | phone | field | backfill
  notes       text not null default '',
  marketing_opt_in    boolean not null default false,  -- §8 CF-5 — job traffic rides Work Auth; outreach needs its own yes
  review_asked_at     timestamptz,                     -- AI Roadmap Phase 5: "tracks who was asked"
  merged_into uuid references public.contacts (id),    -- merge tombstone; resolvers follow the chain
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index contacts_phone_idx on public.contacts (phone_norm) where phone_norm <> '';
create index contacts_email_idx on public.contacts (email_norm) where email_norm <> '';
```

RLS follows the precedent of the two stores closest to contacts in sensitivity, not the blob tables' blanket `for all ... using (true)`: like `sms_messages` (migration 106, pointedly no delete policy) and `email_messages` (208, select+update only), contacts get **select/insert/update and no delete** — retirement is the `merged_into` tombstone, and hard delete is admin-only via the same RESTRICTIVE mechanism 216 used for `admin_only_hard_delete`. The honest caveat 216 already wrote down still applies: role-aware *read* policies arrive with Sync Plan Phase 3, and until then every crew login (and the two `viewer` service accounts) can read this table like every other one. Contacts add no *new* exposure — the same PII already sits in three blobs — but they concentrate it, so Phase 3 should treat `contacts` as first in line.

**`contact_resolve(p_name, p_phone, p_email, p_address, p_source, p_trusted)`** — `security definer`, advisory-lock serialized exactly like `web_lead_insert` (`supabase/migrations/227_web_receptionist.sql`), find-or-create returning `contact_id`:

0. exact identity (name+phone+email+address) → return it — what makes re-runs and backfills idempotent; every match follows the `merged_into` chain to the live winner, so merges *stick*;
1. exact `phone_norm` match (≥10 digits) → link; fill blank fields from the new data **only when `p_trusted`**. Data self-reported on a public lane must never enrich a real customer's record — otherwise an anonymous visitor typing a known customer's phone plus their own email silently repoints where that customer's invites and review asks route. Untrusted fills queue as suggestions; differing non-blank values queue `conflict` suggestions for everyone;
2. else exact `email_norm` match → trusted + same name links (decision 9 amendment); a different name — the shared-household-email case — **creates anyway and queues a merge suggestion**;
3. else exact normalized name + street-number match → create + merge suggestion;
4. else bare exact-name match → create + `name` suggestion (phone-less, email-less fragments — 7 of the 11 live adjusters — must not bypass the queue);
5. else create (name falls back to email/phone so no nameless shells exist).

Grants deviate from 227's revoke-everything posture deliberately, and the deviation is gated *inside* the function: 227's RPCs serve an anonymous public lane, so only `service_role` may call them; this one also serves the signed-in crew (`syncSpine()` runs in the browser — `apps/field/js/spine.js:43-99`), so it carries an `authenticated` grant whose first line refuses unless the caller is service-role (`auth.uid()` is null) or their `profiles.role` warrants it — the `is_admin()` pattern from 216. admin/office/tech resolve trusted; the phone agent — which by design never holds a service key and signs in as the `viewer` machine user (`services/phone-agent/supa.mjs:1-11`, fenced by 204) — is admitted **untrusted only**, matching its existing privilege of minting lead-shaped records but never enriching existing ones; `office-brief@` and any future customer principal are refused outright. Without that gate, SECURITY DEFINER would silently hand a deliberately fenced account a contacts-write primitive, and a match-vs-create result is an existence oracle for anyone's phone number.

**`contact_merge(p_winner, p_loser)`** — repoints the link columns of §5, stamps `merged_into` on the loser, unions blank fields. Office-triggered only. Its board-blob repoint must ride the guarded rev-bumping path described in §5, not a bare update.

**Backfill** (same migration, or a one-shot script): seed from `unified_jobs` owner fields (covers every current field job), then `coordination_jobs` blobs (adds board-only leads and customers), then the **legacy `jobs` table** from the old React app — it's still applied on the remote database with `owner_*` and `adjuster_*` columns, and `unified_jobs.relational_job_id` crosswalks to it, so the pre-field-app customer base enters the spine too. Every row runs through the same ladder, trusted. Adjusters seed with `role: 'adjuster'` — they're contacts too, and the adjuster-email drafting the admin assistant already does gets a real address book. Expect a few hundred rows and a short merge-suggestion queue; the office reviews it once with coffee.

**Fixed in passing** (small, load-bearing): the phone agent's `createLead` starts writing `channel: 'phone'`; `publishPortal()` stops writing `unified_job_id: null`; `qbo-proxy` `ensureCustomer()` looks up by `qbo_customer_id` first and persists it on create. (The Web Voice doc's other follow-up — wiring `roybal-lead` to the owner SMS — already shipped: `roybal-lead/index.ts:159-185` texts `kind:'webLead'` per alert cell today.)

## 4. Properties — `230_properties.sql` (second wave, not first)

In restoration the *house* is often the natural key — landlords with four units, a property sold mid-relationship, a property manager standing in front of an owner. But it's separable, so it ships after contacts prove out:

```sql
create table public.properties (
  id            uuid primary key default gen_random_uuid(),
  address       text not null,
  address_norm  text not null,          -- normalized street key (dedupe basis)
  city          text not null default '',
  notes         text not null default '',  -- shutoff location, panel, access quirks — the crew's institutional memory
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create table public.contact_properties (
  contact_id  uuid not null references public.contacts (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  role        text not null default 'owner' check (role in ('owner','tenant','manager')),
  primary key (contact_id, property_id, role)
);
```

Three tables, not two, because people own several properties and properties change hands — a two-table design forces one of those to be wrong. `unified_jobs` gains `property_id` alongside `contact_id`, and "every job we've ever done at this address" becomes a query instead of an anecdote.

## 5. Linking the lanes — `229_contact_links.sql`

One nullable `contact_id uuid` column on each lane, plus the writers that stamp it:

| Lane | Column | Stamped by |
|---|---|---|
| `unified_jobs` | `contact_id` (+ `property_id` later) | `syncSpine()` calls `contact_resolve` with the blob header fields (`apps/field/js/spine.js:43-99`) |
| `coordination_jobs` | blob field `data.contactId` — **no DDL needed** | `roybal-lead`, `roybal-web-agent`, phone-agent `createLead`, board editor save — creation-time and editor-path stamps only; post-hoc stamps need the rev-bump RPC below |
| `sms_messages` | `contact_id` | `roybal-notify` inbound webhook: resolve by `phone_norm` *before* falling back to today's `unified_jobs.owner_phone` scan (`supabase/functions/roybal-notify/index.ts:451-463`) — and the indexed lookup retires the 500-row JS scan |
| `email_messages` | `contact_id` | `gmail-proxy` `matchEmailToJob`: an `email_norm` hit becomes a new, higher-confidence match rule *above* 'customer-email' — and its refusal rules stay (`supabase/functions/gmail-proxy/emailmatch.ts:43-67`) |
| `portal_jobs` | `contact_id` | `publishPortal()` (`apps/field/js/portal.js:62-94`) |
| `capture_events` (phone calls) | `contact_id` | phone agent, when `lookupCaller` resolves — its coarse-answer contract is unchanged (`services/phone-agent/tools.mjs:50-59`) |
| `field_projects` | blob field `data.contactId` — no DDL | stamped by the spine sync round-trip; blob stays authoritative (decision 2) |

Then the payoff, one view:

```sql
create view public.contact_timeline
  with (security_invoker = true) as   -- caller's RLS applies, not the owner's
  select contact_id, 'sms' as lane, created_at,
         case direction when 'inbound' then 'in' when 'outbound' then 'out' else direction end, body
    from sms_messages where contact_id is not null
  union all
  select contact_id, 'email',  received_at,  direction, subject from email_messages where contact_id is not null
  union all
  select pj.contact_id, 'portal', pm.created_at, pm.direction, pm.body
    from portal_messages pm join portal_jobs pj on pj.id = pm.portal_job_id where pj.contact_id is not null
  union all
  select contact_id, 'call', captured_at, 'in', coalesce(transcript,'(call)')
    from capture_events where contact_id is not null and source_type = 'phone_call';

revoke all on public.contact_timeline from anon;   -- the 225/226 view precedent: never a free PostgREST endpoint
```

*(Sketch — real columns and value vocabularies normalized in the migration; note `sms_messages` says `inbound/outbound` where every other lane says `in/out`.)* The grant hygiene is not optional: Supabase default privileges expose new public-schema relations over PostgREST, and both existing view migrations (225's `field_photos_deleted`, 226's `sync_fleet`) revoke for exactly this reason — as a bare sketch this view would serve SMS bodies and call transcripts to anyone holding the anon key that's committed in `apps/field/js/config.js`.

This is AI Roadmap Phase 6's "one conversation thread per customer across SMS, calls, and email" (`docs/AI_Assistant_Roadmap.md:137-148`), delivered as a `union all` instead of a rewrite.

**One write-path rule for post-hoc blob stamps.** Stamping `data.contactId` at *creation* is safe. Stamping it onto an *existing* board card server-side is not: the board PATCHes the entire blob guarded only by `data->>rev` (`apps/board/js/data.js:97-107`), so a server write that doesn't bump `rev` gets silently clobbered by the next save from a device that pulled earlier — and one that does bump `rev` costs every open board device its next queued edit. So post-hoc stamps (backfill linking of existing lead cards, `contact_merge` repoints) go through a guarded `jsonb_set` + rev-bump RPC — the exact pattern migration 225's `restore_photo` already established — and we accept the device conflicts as the price of correctness.

## 6. Lead lifecycle on the board — blob fields, zero DDL

Per decision 3, the pipeline is the board. The lead blob gains (all optional, all defaulting safely for existing cards):

```
contactId, propertyId,
channel: "web-form" | "ai-chat" | "phone" | "referral" | "repeat" | "walk-in",
estValue,                 -- bid dollars; contractValue stays what it is today (won work)
nextActionAt, nextAction, -- the follow-up promise
outcome: "won" | "lost",  lostReason, outcomeAt,
referredBy                -- contactId of the referrer — referral tracking is one field, not a system
```

Board affordances, in the order they earn their keep:

1. **Source badge** on lead cards (absorbs Web Voice Phase 3's `channel:'ai-chat'` badge, generalized) — today `grep webLead apps/` returns zero hits; provenance is captured and never shown.
2. **Follow-up chip**: `nextActionAt` renders on the card; overdue turns amber. The morning brief (`roybal-brief`) gets one new line: *"3 leads overdue for follow-up."* That single nag is most of what paid CRMs actually deliver.
3. **Won / Lost buttons** in the job editor's lead stage. *Won* → existing stage advance, and when boardpush links the field job the conversion is recorded (`fieldJobId` is already stamped field→board at `apps/field/js/boardpush.js:84` and `:101`, and looked up link-first at `:262-269`). *Lost* → `outcome`, `lostReason` (one dropdown: price / went-with-other / no-response / not-a-fit / other), then archive. The archive browser grows a Lost filter; today it's designed only around finished work.
4. **Conversion numbers fall out for free**: won ÷ (won+lost) by channel, from blobs we're already syncing. That's the report the CFO board asks for first.

## 7. Office surface — the contact page

**Phase 1 — a panel, not an app.** `contactsPanel()` drops into the admin panel row at `apps/admin/js/admin.js:125` following the `messagesPanel()` recipe exactly (h()-built `.card`, fetches PostgREST, renders nothing on failure): search by name/phone/email, recent contacts, click → detail. Online-only is fine — the admin is.

**Phase 2 — the admin's first router.** A contact page needs a URL. Copy the field app's hash router pattern (`apps/field/js/app.js:151-174`) into admin: `#/` dashboard, `#/c/:id` contact. The page assembles what the links already paid for:

- identity header (edit in place; merge-suggestion banner when one is queued)
- **jobs** — `unified_jobs` + board cards by `contactId`, both directions of the crosswalk
- **timeline** — the `contact_timeline` view, newest first
- **money** — invoice/payment rollup from the QBO linkage the field blobs already carry (`qboInvoiceId` + nightly `pullPayments`, migration 207)
- **actions** — the assistant's existing confirm chips (`sendText` / `portalReply` / `emailSend`, dispatched in `apps/admin/js/assistctx.js:275-279`) pointed at a contact instead of a job; the financial chips stay where they are (`apps/admin/js/finactions.js`); no new write paths, same human-tap rule

The admin assistant's context builder (`assistctx.js`) also gets the contact digest, so "what's the history with the Grahams?" becomes answerable.

*Superseded in layout (not in content) by §13: both phases shipped as described, and the 2026-09-01 restructure now gives these surfaces a navigation home instead of a dashboard slot.*

## 8. The customer side — what the spine unlocks

This is the expansion you asked for. Ordered by dependency, each independently shippable; portal phase labels absorbed from `docs/Customer_Portal_Roadmap.md`.

### CF-1 · Accounts and "My projects" — absorbs Portal B1, with two deliberate changes — `231_contact_sessions.sql`

B1 as specced links a Supabase Auth login to a *job* (`portal_access(user_id, portal_job_id)`). Two things have changed since it was written. First, contacts exist, so the link should be to the **person**. Second — and this one is a hard constraint, not a preference — migration 216 wrote down why a customer must not be a Supabase Auth user yet: any JWT in the `authenticated` role passes every legacy `USING (true)` policy in the database (`216_individual_logins.sql:26-31` says it in as many words), so an invited customer holding the publishable key that's committed in git could skip the gateway and read — and on the `for all` tables, write — the entire company database over PostgREST. Sync Plan Phase 3's role-aware policies are the fix, and they haven't landed.

So CF-1 keeps the portal what it already is — a bearer-credential system served by one gateway — and extends it one level up, from job to contact:

```sql
create table public.contact_sessions (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references public.contacts (id) on delete cascade,
  token_hash  text not null unique,     -- sha-256 of the session token; the raw token lives only in the customer's link
  channel     text not null check (channel in ('email','sms')),   -- how possession was verified
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.contact_sessions enable row level security;    -- and no policies: service-role only,
revoke all on public.contact_sessions from anon, authenticated;   -- the 227 guard-table posture
```

Flow: the office taps **Invite** (or a customer taps "save this" on a token visit) → the gateway texts/emails a short-lived code **to the phone or email already on file** → verifying it mints a long-lived contact session, delivered as a magic link. The gateway accepts **job token OR contact session**; a session renders every *enabled* `portal_jobs` row for that contact as "My projects" — the multi-job view that is structurally impossible today (`roybal-portal` resolves one token to one row, `limit=1`). Old job-token links keep working forever, per the roadmap's locked foundation that the token link keeps working alongside accounts. A customer never has to hold a login — and with this design they still never hold a *DB credential*, which keeps Phase A's actual security invariant intact instead of quietly repealing it.

If Phase 3 RLS lands and fences a `customer` role properly, migrating contact sessions onto Supabase Auth (B1's original mechanism) becomes a contained swap inside the gateway. Until then, customer JWTs are a loaded gun and this doc declines to pick it up.

**The identity bar is the portal's, not the web lane's**: codes go only to a phone/email already on file, so decision 5 is not violated — we verify possession of the channel, we don't trust a self-report.

### CF-2 · The live job — extends C2, powered by data we already capture

- **Who's on the job today.** Crew names from `crew_members` + the board schedule, published as a curated daily line with the milestone-nudge *dedupe* pattern (one post per day) and a default-on per-job toggle. Kills the stranger-at-my-door problem with data the Gantt already computes. **Reworked 2026-08-14 (migration 236)**: the trigger is the crew's *first QuickBooks Time clock-in of the day* (qb-time-proxy `clockinSweep`, polled every 15 min), not a fixed weekday morning — the customer hears it when work actually starts, never on a day nobody shows. Names still come from the board schedule; actual clocked-in names are the fallback when the board lists nobody (weekends, off-plan visits). Mirrors to SMS under the bridge rule (latest inbound rode SMS). Trade: a job with no QB jobcode link has no clock-in signal and stays silent — linking the job lights it up.
- **Drying, in plain English.** We hold moisture maps and drying logs the customer never sees. A curated card — *"Subfloor today: 14%. Dry standard: 12%."* — added to `portalProjection()` under the same allow-list discipline. **Readings only, no auto-computed ETA**: "two more days" is a completion promise, and the shipped discipline is that dates and commitments are human-only (the concierge hands off exactly those questions — and it's grounded in the portal slice, so an auto-published date would immediately become an AI-repeatable one, undoing the fence). If we want a trend line, it's an office-confirmed field set at publish, like the milestone itself. No competitor can ship this card; none of them have the readings.
- **Documents, finally.** The column has been reserved since migration 107, `publishPortal()` writes `[]`, `view()` hardcodes `[]`. A picker in `portalShareForm` + `mediaSrc()`-style serving ships COI, work auth, cert of drying, invoices — the things adjusters and lenders ask customers to produce.
- **SMS bridge** — absorbs M2 as specced: inbound texts append to the thread (`channel:'sms'` has been reserved in migration 108 since day one), office replies mirror out. The Twilio gate has already passed — forwarding went live 2026-08-12 (`docs/Phone_Forwarding_Runbook.md`) — so what remains is the inbound webhook → thread append and the outbound mirror. And the `portal` kind that `roybal-notify` already names in its reserve-exemption set (`PROTECTED_KINDS`, no caller today) finally gets its caller: the share link gets *texted*, not copy-pasted.

### CF-3 · Money and approvals — absorbs B4 + C1

Change-order approval and e-sign in the portal reusing the field app's signature pads (B4 as specced — discovered-conditions with a photo of what's behind the wall is the #1 trust moment in this trade). QBO payment links ride C1; `contacts.qbo_customer_id` is what makes "your balance" a per-person truth instead of a per-DisplayName guess.

### CF-4 · Closeout and the home file — absorbs C3 + AI Phase 5's review engine

When a job hits `complete`, the portal flips from progress-tracker to **record**:

- **Warranty card** — coverage, start date, and a "request warranty service" button that opens a board lead pre-linked to the same `contactId` + `propertyId`, channel `repeat`. Today that's a phone call and a retyped card.
- **The home file** — paint colors and sheens (selections + the Sherwin-Williams data the Material doc verified is free and open), flooring and material selections as chosen, appliance/fixture notes, the open-wall photos from before drywall, property quirks from `properties.notes`. The customer keeps it forever; every future touch-up opens *our* portal. This is the retention moat, and it is assembled entirely from data already captured.
- **Review ask at the emotional peak** — walkthrough sign-off triggers the request (human-approved send, Google link, routed to the site's existing review pages), `review_asked_at` stamped so we never ask twice (the exact "tracks who was asked" requirement of AI Phase 5).
- **Referral loop** — "know someone with a project?" in the closeout view; a referred lead carries `referredBy`, and the contact page shows referrals given. Thank-yous become possible because they're finally visible.

### CF-5 · Staying in the customer's life — absorbs AI Phase 6's outreach

Contacts turn AI Phase 6's "weather triggers → outreach campaigns to past customers" from a sentence into a query: `contacts where marketing_opt_in`, joined to closed jobs by type. Fairbanks freeze/thaw surge prep; September snow-removal signups (it's on the service list; the audience is every closed customer). **Consent is the gate**: Work-Auth opt-in covers *job* traffic only — marketing outreach requires the separate `marketing_opt_in`, collected in the portal account settings and site forms, STOP always honored, quiet hours always, human-approved sends until the tier earns automation.

**And campaigns get their own budget, not the shared one.** `roybal-notify`'s reserve design protects the pool from the two *public* kinds only; an authenticated campaign kind as things stand could spend the shared monthly cap (default 500) to zero — starving the owner-alert and brief lanes — and, by pushing usage past cap−reserve, shut off website lead alerts for the rest of the month. A 200-send September campaign does that easily. So CF-5 adds a campaign kind with its own monthly ceiling, refused *before* it touches the shared pool's reserve floor. Low volume, high relevance, zero spam, zero starvation — or we don't send it.

## 9. What this deliberately does not do

- **No external CRM, no import/export integrations.** The thesis of this whole codebase is that the data lanes already exist; buying HubSpot to sit beside them would mean syncing seven stores instead of linking six.
- **No new message store, no rewrite of any lane** (decision 4).
- **No public recognition of unverified people** (decision 5) — the phone agent's coarse "open water job on file" answer is the ceiling for unauthenticated lanes.
- **No bulk email machinery.** Outreach v1 is SMS through `roybal-notify`'s existing caps; email stays 1:1 through the Gmail lane.
- **No role-aware visibility change** — that's Sync Plan Phase 3's job; this doc only adds `contacts` to its front of the line.
- **No customer-facing pricing derived from `price_list`** (decision 8).
- **No auto-send anything** that hasn't earned it through the AI roadmap's compose→review→send tiers.

## 10. Sequencing

| # | Ship | Contents | Effort | Depends on |
|---|---|---|---|---|
| 1 | `228_contacts.sql` + backfill | ✅ **SHIPPED 2026-08-13** (adversarially reviewed: 19 findings fixed pre-apply; live-probed post-apply). 32 contacts seeded (24 customers, 8 adjusters), 6-item review queue. Machine accounts fenced at the table (204/205 pattern); `merged_into`/`qbo_customer_id` are RPC-only columns (216 technique) | M | — |
| 2 | Writers stamp `contactId` | ✅ **CODE DONE 2026-08-14** — roybal-lead, web-agent, phone `createLead` (+ `channel:'phone'` + capture_events stamp), spine sync (gated to avoid re-queuing dismissed suggestions), notify inbound+outbound (owner-kind exclusion), gmail match, publishPortal (non-destructive link write), qbo `ensureCustomer` (persists `qbo_customer_id`, gated on a verified office caller). Awaiting edge-fn + Fly deploy | M | 1 |
| 3 | `229_contact_links.sql` | ✅ **SHIPPED 2026-08-14** — five `contact_id` columns + `contact_timeline` (`security_invoker`) view + `contact_merge` link-repoint extension + conservative backfill (spine 21/31, portal 3/3, sms 25→customer-only, email 13/13, calls 3/8). Adversarially reviewed: 12 findings fixed pre-deploy | S | 1 |
| 4 | Board lead lifecycle | ✅ **SHIPPED 2026-08-14** — lead blob fields (channel/estValue/nextActionAt/nextAction/outcome/lostReason), source + follow-up + est-value chips on lead cards, editor Lead section with Won/Lost (+ lost-reason dropdown), dedicated Pipeline view with win-rate stats, Lost archive filter, and the morning-brief overdue-leads nag. Verified live against a seeded board | M | 2 |
| 5 | Admin contacts panel → contact page | ✅ **SHIPPED 2026-08-14** — `apps/admin/js/contacts.js`: dashboard Contacts panel (search + recents) and the admin's first hash route `#/c/:id` — identity card with in-place edit + marketing opt-in, merge-review banner (Merge / Not a match over the 228 suggestion queue via `contact_merge`), jobs across both stores, and the `contact_timeline` view rendered as one thread. Sync refresh is route-aware so it never clobbers an open edit. Verified live with stubbed lanes | M | 3 |
| 6 | `230_properties.sql` | properties, contact_properties, `unified_jobs.property_id` | S | 1 |
| 7 | CF-1 accounts | ✅ **SHIPPED 2026-08-14** (v1) — `232_contact_sessions.sql` (pending codes + hashed sessions, atomic 227-style caps: 3 codes/contact/hr, 20/day, 5 guesses kills a code — all probe-verified rolled-back). Gateway: `requestAccess`/`verifyAccess`/`myProjects` + `{session, jobId}` accepted anywhere a token is (resolved server-side; share tokens never leave a session flow). Portal: save-this card → texted code (`portalCode` — quiet-hours exempt as a solicited OTP, PUBLIC reserve-guarded, off the CRM timeline) → "My projects" incl. past jobs, sign-out. **v1 scope:** SMS-only codes, customer-initiated from a job link; email codes + an office Invite button are follow-ups | L | 1, 2, 3 |
| 8 | CF-2 live job | ✅ **COMPLETE 2026-08-14** — drying card + documents (231), and now: **who's-on-the-job-today** (`crewtoday.mjs` pure helper mirroring crewIds/crewSpans/dayCrew, 15 node checks; one line per job per day, default-on toggle in the share form; silence when nobody's there. Trigger reworked same day, migration 236: the crew's first QB Time clock-in of the day — `qb-time-proxy clockinSweep` every 15 min inside 8am–8pm AK — replaces 233's fixed weekday-morning cron; board-schedule names, clocked-in names as the weekend/off-plan fallback; SMS mirror under the bridge rule) and the **SMS bridge** (M2 at last: inbound texts file to the thread as `channel:'sms'` on an unambiguous single enabled portal job — the gmail refusal rule; office replies mirror to SMS only when the customer's latest inbound rode SMS, via the `portal` kind's first-ever caller) | M–L | 7 for accounts; 2 for the rest |
| 9 | CF-3 money | ✅ **SHIPPED 2026-08-14** (v1) — `portal_jobs.approvals` + `billing` (migration 235; both outside publishPortal's payload, the omit-the-key discipline, so a republish can never reset an answer). Office: a Money section in the share form publishes change orders for approval (thread post + SMS nudge) and shares the balance via `fincalc.billingSummary` (QBO `qboBalance` = ground truth on tracked invoices; tested) with a best-effort QBO pay-online link (new office-gated `invoiceLink` action on qbo-proxy). Customer: pending-CO cards with amount delta, typed legal name + a drawn-signature pad, Approve/Decline (answers land on the thread; the signature is stored for the office, never echoed back); a balance card with Pay online. **v1 scope:** approval state lives in portal_jobs (office copies into the field CO form by hand); per-invoice detail later | L | 1, 7 |
| 10 | CF-4 closeout + home file | ✅ **SHIPPED 2026-08-14** (v1) — `portal_jobs.closeout` (migration 234) office-curated in the share form (completion date, warranty months, home-file rows); complete-state portal cards: **warranty** with one-tap service request (→ a `channel:'repeat'` board lead pre-linked to the contact, 7-day dedupe, owner alert), **the home file**, **review ask** (Google link; `contact_mark_review_asked` RPC = the never-ask-twice stamp, probe-verified) and the referral line. **v1 scope:** home file is office-typed rows (auto-pull from selections later); no `propertyId` until the properties table ships | M | 6, 7 |
| 11 | CF-5 outreach | 🟡 **IN PROGRESS** — campaign budget class ✅ **SHIPPED 2026-08-15** (PR #142): kind `campaign` in roybal-notify, gated by `campaignGate` (pure, 12 node checks) — send-layer consent (exactly-one live contact + `marketing_opt_in`, never waivable), own `SMS_CAMPAIGN_CAP` ceiling (default 100/mo), refused at the shared reserve floor, quiet-hours guarded, STOP honored by Twilio a layer down. Opt-in collection ✅ **SHIPPED 2026-08-15** (PR #143): portal session-gated "Seasonal tips & reminders" card (verified-phone consent; `prefs`/`setMarketing` gateway actions), site quote-form checkbox (applies ONLY to the contact that submission creates — the public lane never enriches an existing person), admin editor stamps transitions; `marketing_opt_in_at` (migration 240) records when. Campaigns panel (segments + human-approved sends) ✅ **SHIPPED 2026-08-16** (PR #144): admin dashboard panel — opted-in roster as a curated checkbox segment, {name} personalization, sequential sends re-gated per recipient, resume-not-repeat via the campaign tag (client unchecks already-texted + roybal-notify refuses `campaign_duplicate`), shared-number and non-US contacts excluded up front, honest sent/refused/not-attempted arithmetic, composer latched against the 45s dashboard repaint; adversarially reviewed, 10 findings fixed. Remaining: write + send the first seasonal campaign | M | 1, 10 |
| 12 | CRM home: nav shell | §13.1 — admin tab bar (Today / Jobs / Contacts / Campaigns / ⚙), connections → `#/settings`, help updated | S | — |
| 13 | CRM home: full tabs | §13.2 — contacts filters + merge queue view, campaigns history | S–M | 12 |
| 14 | Leads Inbox | §13.3 — 🟡 **BUILT 2026-09-01** (PR stacked on 12/13): `#/leads` + badge + brief 🆕 line; migration 246 **applied to prod** (probe-verified); roybal-lead v28 / web-agent v24 / brief v46 **deployed**, verify_jwt=false re-probed on both public lanes; phone-agent `message` field awaits its next Fly deploy | M | 12; RPC before any admin lead write |
| 15 | Today stat row | §13.4 — 🟡 **BUILT 2026-09-01** (PR stacked on 14): lead row above the ops KPIs — unworked / overdue (click → inbox) / pipeline Σ estValue / avg first touch (archived leads count toward the average) | S | 14 |
| 16 | Analytics tab | §14.1 — `#/analytics`: conversion by channel, lost reasons, speed to lead, est-vs-actual hours + bid-vs-contract diverging charts, headline factors; chart+table twins, validated palette | M | 4, 14 |
| 17 | Estimating feedback loop | §14.2 — ✅ **BUILT 2026-09-01**: calibration.js (gated factors, 7 node checks) feeding `estimateCalibration` into the admin + field assistant contexts; suggest-never-apply rides in-band | S | 16 |
| 18 | QBO profitability in the tab | §14.3 — read-only per-project P&L via qbo-proxy, displayed beside the CRM stats; needs project-linkage audit | M | 16 |

Steps 1–3 are the whole foundation and touch **zero UI** — nothing can break that users see.
**Rollback (1–3):** the columns and tables are additive and nullable; ignoring them restores today exactly.
**Done when (1–3):** a text from a past customer resolves to a contact; that contact's page query returns their jobs and messages; two same-phone leads produce one contact.
**Done when (4):** a lead can be marked lost with a reason, and the brief nags an overdue follow-up.
**Done when (7):** one contact session shows two jobs for a two-job customer, while both old token links still work — and that customer's session cannot read one row of any other table over PostgREST.

## 11. Risks — honest version

| Risk | Reality check | Mitigation |
|---|---|---|
| Wrong merge glues two people together | Worst failure in the design — one customer sees another's name | Auto-merge on exact `phone_norm` only; all else suggestion-queued (decision 9); `merged_into` tombstone is reversible by hand |
| Public lane poisons a contact record | Anyone can type a real customer's phone into a public form | `p_trusted` gate in the resolve ladder: untrusted lanes never fill fields on a matched contact, suggestions only |
| Customer login leaks the whole DB | Any `authenticated` JWT passes the legacy `USING (true)` policies (216's own warning) | CF-1 uses gateway-minted contact sessions, not Supabase Auth; customers still never hold a DB credential |
| Backfill garbage | Free-text fields, years of typos | Backfill links, never destroys; blobs untouched; merge queue is reviewable |
| PII concentration in one table | Same data, now in one convenient table readable by every login incl. `viewer` service accounts | No-delete RLS + admin-only hard delete from day one; named first in line for Sync Plan Phase 3 role-aware reads |
| Resolution races minting duplicates | Two lanes, same caller, same minute | Advisory-lock in `contact_resolve`, the 227 pattern |
| Post-hoc blob stamps race the board | Board saves whole blobs guarded only by `rev` | Guarded `jsonb_set` + rev-bump RPC (the 225 `restore_photo` precedent); device conflicts accepted as the cost |
| Offline-first regression | Field app must never wait on a contact lookup | Decision 2: blob authoritative, `contactId` best-effort, resolution server-side |
| Outreach starves the SMS lanes or becomes spam | Campaigns share nothing safely: 200 sends could trip the cap−reserve cutoff and kill lead alerts for the month | Own campaign budget class in `roybal-notify` (§8 CF-5); `marketing_opt_in` gate, STOP, quiet hours, human-approved sends |
| Scope creep into a CRM *product* | The trade only needs the spine + follow-ups + the portal | §9 is the fence; anything not listed needs its own doc |

## 12. Open decisions for you

1. ✅ **DECIDED 2026-08-13 — CF-1 supersedes B1 twice over**: contact-level instead of job-level linking, *and* gateway-minted contact sessions instead of Supabase Auth (until Phase 3 RLS makes customer JWTs safe). The portal roadmap's B1 line is updated in both respects.
2. ✅ **DECIDED 2026-08-13 — auto-merge accepted, no per-merge review.** Exact-phone auto-link stands as built; the suggestion queue remains only for weaker evidence (email-with-different-name, name+address).
3. ✅ **DECIDED 2026-08-13 — lost reasons** as proposed: price / went-with-other / no-response / not-a-fit / other.
4. ✅ **DECIDED 2026-08-14 — marketing opt-in consented.** Owner authorized proceeding with the opt-in as designed (`contacts.marketing_opt_in`, collected in the admin contact page today and in the portal settings/closeout when those ship; STOP + quiet hours always). The attorney five-minutes on the consent line remains recommended before the first CF-5 campaign actually sends.
5. ✅ **DECIDED 2026-08-14 — review destination**: the Google review link `https://g.page/r/CSv3IUml4W9GEBM/review` (supplied by owner). CF-4's review ask points here; store it as config, not hardcoded in message bodies.
6. 🔍 **IN EXPLORATION — QBO cleanup.** Inventory run 2026-08-13 against the live books: 91 customer records (~36 parent groups — the books use QBO's parent/sub-customer-per-property pattern, which the app is blind to). One live fork found: **"NextHome Arctic Sun"** ($7,239) vs **"Fairbanks Property, LLC dba NextHome Arctic Sun"** ($8,660 + sub) — same brokerage, two records. Also: "Valerie" has no last name (fork bait), and Awthentis billing is split half-parent/half-sub. Merging is a QBO-UI operation (the API cannot merge) — minutes each, no deadline. `qbo_customer_id` persistence lands with steps 2–3; the parent/sub pattern maps naturally onto the `properties` table when 230 ships (sub-customer ≈ property).
7. ✏️ **REVISED 2026-08-13 — pipeline view is IN scope, and the board presentation itself gets a rework.** Owner: the in-progress column overflows past the fold, everything piles into two narrow columns, and the chip format doesn't support at-a-glance decisions. Direction: add viewing formats (more ways to see the same data, trim unused ones later) — a dedicated lead-pipeline view joins CRM step 4, and the board density/layout options get their own short design pass (compact cards, stage-swimlane rows, table view, exception/triage strip).
8. ✅ **DECIDED 2026-09-01 — the admin app is the CRM home.** Owner, looking at the shipped admin: "this is almost the CRM, just in a really rough form — use this page that's already set up and make it more specific to a dedicated CRM page." §13 is that plan. The board keeps the Pipeline view (decision 3 untouched): the board is the wall-screen scheduling surface, the admin is the desk-work surface — same `coordination_jobs` rows, two lenses.

## 13. The CRM home — the admin becomes the CRM (2026-09-01)

**The problem is layout, not features.** Everything §7 and CF-5 shipped works, but it all renders as one vertical stack on a single dashboard route: three set-once OAuth connection panels (QB Time, QBO, Gmail — touched a few times a year) sit *above* the surfaces the office works daily (messages, contacts, campaigns), and the jobs table sits below all of it. The prompting incident: web-form leads land on the board with the customer's actual message buried in the chip editor's notes textarea (`roybal-lead/index.ts:387` concatenates it into `data.notes`; the board only renders notes inside the editor) — there is no surface anywhere that shows what a lead *said*.

**The reframe:** the admin stops being "the connections page with some panels" and becomes "the CRM that happens to have connections in settings." Nothing moves stores, nothing touches the field app or board sync; this is routes and rearrangement plus one genuinely new view.

### 13.1 Navigation shell — PR 1 (pure rearrangement, zero data changes)

Tab bar under the header, riding the router the admin already has (`admin.js:45-57`):

| Route | Tab | Contents |
|---|---|---|
| `` | **Today** | KPI row + 💬 messages — the at-a-glance + daily-work surface (CRM stat row joins in PR 4) |
| `#/jobs` | **Jobs** | the existing search + jobs table, unchanged |
| `#/contacts` | **Contacts** | `contactsPanel()` full-page (grows filters in PR 2) |
| `#/campaigns` | **Campaigns** | `campaignsPanel()` full-page |
| `#/settings` | ⚙ | the three connection panels (QB Time, QBO, Gmail) + sign-out context |
| `#/c/:id`, `#/help` | — | unchanged |

Rules that carry over: OAuth callback handling stays global at boot (redirects land on the root URL regardless of tab) and finishes on `#/settings` so the user sees the connected panel; the sync repaint re-renders *the current route* with the existing guards intact (never clobber an open contact edit or a busy campaign composer — `admin.js:38-43`); `#/help` is updated in the same PR (the help-catches-up rule, PR #169). No Leads tab yet — it appears in PR 3 when there is an inbox behind it, never as a stub.

### 13.2 Contacts + Campaigns as real tabs — PR 2

Room the dashboard cards never had: role filter chips (customer / adjuster / sub / …), marketing-opt-in status in the list, the open merge-suggestion queue in one place (today suggestions only surface on the individual contact pages they involve), and campaign history alongside the composer. Same data, same write paths, wider canvas.

### 13.3 The Leads Inbox — PR 3 (the genuinely new view)

`#/leads`: every open lead across all channels, newest first, **the customer's message rendered in the open**, one-tap triage on the row (set follow-up → `nextAction`/`nextActionAt`, mark contacted, call, mark lost/spam). Definitions the whole feature hangs on:

- **Unworked lead** = `stage:'lead'`, no `outcome`, no `nextActionAt`, and no first-touch stamp. That count badges the Leads tab and joins the morning brief beside the existing overdue-follow-ups nag.
- **`data.message`** — the writers (`roybal-lead`, `roybal-web-agent`, phone `createLead`) start storing the customer's verbatim ask as its own blob field instead of only concatenating it into `notes`. Additive; `notes` keeps receiving the composite for board back-compat.
- **`data.firstTouchAt`** — stamped by the first triage action; time-to-first-touch becomes measurable ("response time IS the product" — `roybal-lead/index.ts:421`).

**The write path is the real engineering.** Leads are `coordination_jobs` blobs the board saves whole, guarded by `data->>rev` (`apps/board/js/data.js:97-107`) — an admin PATCH that doesn't play by the rev rules is either silently clobbered by the next board save or costs every open board device its queued edit. The guarded RPC already exists: `coordination_job_patch(id, patch)` (migration 230, Board RPC Tier 1) does exactly this rev-bumping shallow-merge and is what `contact_merge` rides. *Decided at build (migration 246, applied 2026-09-01):* the grant was extended — the function gained the `contact_merge` role gate (admin|office JWTs pass, any other JWT is a null no-op, service-role callers unaffected) and an `authenticated` grant; probe-verified that a JWT with no profile is refused without a write. No second RPC. Board-device conflicts are accepted as the price (same trade §5 already priced in).

### 13.4 Today stat row — PR 4

Falls out of PR 3's stamps: unworked leads, overdue follow-ups, open-pipeline dollar value (Σ `estValue`), average time-to-first-touch — alongside (not replacing) the ops KPIs (drying, 7-day equipment). Win-rate-by-channel stays on the board's Pipeline view where it shipped; the brief gets one line, not a dashboard.

### 13.5 Fence (§13)

No new tables, no new message store, no board layout changes (decision 7's board-density pass remains its own work), no automation (auto-ack and stale-lead escalation are candidates *after* the inbox proves what worked/unworked means — they ride §2's roybal-notify rails when they come). Each PR ships independently and leaves the app strictly better.

## 14. Performance analytics (2026-09-01)

**The ask (owner):** conversion charts, where dropped leads come from, job performance on completed work — real vs. estimated — and using those results to feed the estimating engine. Owner note: *QBO already does job profitability for projects set up in QBO* — so this tab does NOT rebuild job-cost accounting; it puts the numbers QBO can't see (channels, lost reasons, speed-to-lead, estimated hours vs. QB Time actuals) in one spot, with QBO's own project P&L joining the same tab in a later phase.

**Everything is already captured — this is a read-only rollup, zero new collection:**

| Question | Source (all shipped) |
|---|---|
| Conversion by channel | `outcome`/`outcomeAt`/`channel` on board blobs (step 4) |
| Why we lose | `lostReason` (step 4) |
| Speed to lead | `firstTouchAt` − `createdAt` (§13.3) |
| Hours: est vs actual | `estimatedHours` (board editor) vs Σ `time_entries.hours` per `jobId` (migration 102, QB Time-synced) |
| Dollars: bid vs won | `estValue` vs `contractValue` (step 4) |

### 14.1 The Analytics tab — `#/analytics`

One time-range filter row scoping everything below it; each card is a chart **with a table twin** (toggle — values never gated behind hover). Charts are hand-rolled SVG, dependency-free (house rule). Palette validated with the dataviz six-checks script 2026-09-01: single-series bars `#1c5fb0`; diverging over-estimate `#c0392b` / under `#0d9488` (deutan ΔE 12.1, all checks pass); orange `#f26a21` accent only (its 2.98:1 contrast WARN is covered by direct labels + table twins).

1. **Headline tiles** — overall win rate, median hours-accuracy factor, median bid-accuracy factor, avg first touch.
2. **Conversion by channel** — win% with n, from explicit outcomes only (the board Pipeline rule).
3. **Why we lose** — `lostReason` counts.
4. **Speed to lead by channel** — avg first touch.
5. **Estimate vs actual, completed jobs** — diverging over/under bars per job (hours); completed = stage `done` or archived non-lost, with both est > 0 and actual > 0 (in-progress excluded — partial hours mislead).
6. **Bid vs contract, won jobs** — same form in dollars.

### 14.2 Phase 2 — the estimating feedback loop — ✅ BUILT 2026-09-01

The tiles' accuracy factors (median actual/est by job type) are machine-readable **calibration factors** for the assistant: "your mitigation estimates run ×1.18 vs. actuals (n=9)." These are OUR actuals — no Xactimate/Verisk data anywhere near it (decision 8 / the EULA memo untouched).

*As built:* `apps/field/js/calibration.js` — pure `computeCalibration()` (7 node checks: medians, the completed-job filter, the type split) + `fetchCalibration(rest)` (dependency-injected client, 10-min cache, failure → null so an ask is never blocked) + `calibrationContext()`. The gate is enforced in code: **factor = null below n≥5** of a type; typed factors (mitigation/remodel) surface when they pass, the overall factor only when neither does; nothing passing ⇒ the context key is omitted entirely. Both assistant context builders carry the block as `estimateCalibration` (admin `buildAdminContext`, field `assistContext`), and the **suggest-never-apply rule travels in-band** — a `note` field inside the data tells the model to mention the factor with its sample size and never silently apply it, so the rule needs no persona redeploy and can't drift from the data.

### 14.3 Phase 3 — QBO project profitability, same spot

`qbo-proxy` already holds the office-gated QBO lane; a read-only per-project P&L pull (QBO's own numbers, displayed not recomputed) can join the tab so profitability and CRM stats live on one screen. Needs a per-job QBO project/customer linkage audit first (`qbo_customer_id` is per-contact, not per-project).
