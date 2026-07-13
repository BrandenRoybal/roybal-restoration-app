# Roybal Customer Portal — Roadmap & Phase A Spec

*A customer-facing portal where a client logs in (eventually) to check job status,
see photos, make material selections, communicate with the office, approve
estimates, and pay. The ultimate target is the full portal (Phase C); we get there
in bite-sized, independently-shippable chunks, with Phase C designed in from the
first one so nothing gets rebuilt.*

**Last updated:** July 12, 2026

---

## Locked decisions

- **Its own subdomain: `portal.roybalconstruction.com`.** A separate origin from the
  internal apps (`app.roybalconstruction.com`), so the browser hard-isolates customer
  sessions, storage, and offline cache from the crew's tools. Hosted on **Vercel**
  (repo already carries Vercel config); the internal apps stay on GitHub Pages.
- **Build-it-right foundation from day one** — a real projection table + an edge
  gateway, not a throwaway page — so Phase B/C bolt on with no data-layer rework.
- **Privacy by construction.** The portal reads only a curated, customer-safe slice
  of each job. Internal data (costs, margins, adjuster notes, internal Field Reports)
  is never in that slice, so the portal *cannot* reach it — it's not "hidden," it's
  absent.
- **Office explicitly publishes** what each customer sees (per-photo, per-document,
  status) — not an auto-mirror of everything non-internal.

## Foundations (built in A, extended through C)

1. **One access gateway — `roybal-portal` edge function.** Every portal read/write
   goes through it. Phase A validates a share **token**; Phase B *also* accepts a
   customer login (JWT). Expanding that one check is a localized change; the token
   link keeps working alongside accounts.
2. **An extensible projection — `portal_jobs`.** Holds only the customer-safe slice.
   Later phases add columns/tables; they never replace it.
3. **Notification pipe — `roybal-notify`** (the toll-free number) for every
   "here's your link / new update / approval needed" text.
4. **Private media via signed URLs.** Shared photos/documents stay in the private
   `field-media` bucket; the gateway mints short-lived signed URLs for only the
   shared items. The bucket never goes public.

---

## Phase A — Read-only shareable link (foundation + fast win)

- **A1 · Projection + office Share panel.** `portal_jobs` table + migration; a Portal
  panel on the job (field/admin) to enable the portal, set status/milestones, mark
  which photos + documents are shared, and generate the share link.
- **A2 · Portal app (read-only).** New `apps/portal` PWA on the subdomain; the token
  link opens status timeline + shared photo gallery + documents, served through
  `roybal-portal`.
- **A3 · Share + update texts.** "Send portal link" texts the customer from the
  toll-free number; an auto-nudge when the office publishes something new.

## Phase B — Accounts + two-way

- **B1 · Customer login.** Supabase Auth (magic-link email and/or a code texted via
  Twilio) + account↔job linking (`portal_access`) + RLS keyed to the customer; token
  link still works. Office "Invite customer" action.
- **B2 · Communication thread.** One conversation per job unifying portal messages +
  SMS; office replies from admin, customer from the portal.
  - **M1 · Portal-native thread — SHIPPED.** `portal_messages` table (108) + `messages`/
    `send` gateway actions; customer composer on the portal, office reply panel in the
    Client Portal form. `channel` column reserves the `sms` bridge (M2). Thread is keyed
    to `portal_jobs.id` (= `portalShare.id`), so office and customer share one thread.
  - **M2 · SMS bridge** (after Twilio go-live): office reply also texts the customer;
    inbound texts append to the same thread via a Twilio inbound webhook → edge function.
- **B3 · Material selections.** Customer picks finishes against allowances + uploads
  inspiration photos, flowing into the existing **Selections** form; office reviews.
- **B4 · Approvals & e-sign.** Customer approves the reconstruction estimate and
  change orders and signs in-portal (reuses the signature pads).

## Phase C — Convenience + money (the goal)

- **C1 · Payments.** Show invoice / balance / deductible; pay online via the existing
  **QuickBooks Online** invoice + payment link.
- **C2 · Schedule visibility.** Upcoming visits and crew ETA from the **Job Board**;
  customer confirms or requests a reschedule.
- **C3 · Closeout.** Warranty info + warranty-service requests, final documents
  (Certificate of Completion, warranty), and a review/referral ask.

## AI + Communication expansion (building now, on top of the thread)

The message thread (M1) is the backbone; AI and richer communication ride on it. All
customer-facing AI reads **only** the curated projection + the thread — never internal
data — and every AI touch is logged against the `ai_usage` ledger under the monthly cap.

Build order (each independently shippable):

1. **Thread — SHIPPED (M1).** Two-way portal messaging, office ↔ customer.
2. **Office AI assist on the thread — SHIPPED (M3).** In the Client Portal reply panel,
   *✨ Draft reply* (answers the customer's latest message) and *✨ Draft update* (a
   proactive progress note) fill the composer for the office to review, edit, and send.
   New `portalDraft` action on `roybal-ai-office`, grounded ONLY in the customer-safe
   digest (`portalDigest`: status, milestone labels, shared-photo captions) + the thread —
   never internal data — and metered on the same `ai_usage` cap. Human-in-the-loop:
   nothing sends without an office tap. *AI photo captions* already come from the Job
   Photos analysis feeding the shared-photo captions.
3. **Customer "Ask about your project" concierge — SHIPPED (M4).** The portal composer now
   routes to a new token-gated `ask` action: the customer's question always lands on the
   thread, then the concierge (`claude-haiku-4-5`) answers instantly **grounded only in the
   customer-safe portal_jobs slice + thread**. Anything needing a date, price, insurance
   detail, or a commitment → `answerable:false` → a friendly hand-off line, and the question
   stays **unread for the office** so a human follows up. Guardrails on the one public LLM
   endpoint: per-minute flood guard, per-job daily answer cap (`CONCIERGE_DAILY_MAX`), and
   the account-wide monthly spend cap — all logged to `ai_usage` (`form_key:'portalAsk'`).
   Answered questions are marked handled but stay in the thread for office audit.
4. **Proactive + smart.** Milestone nudges ("drying complete → here's what's next"),
   triage/priority on inbound messages, multilingual replies, voice notes (existing
   Deepgram stack). Approvals-as-messages and selections helper land with B3/B4.

Privacy/safety spine: customer AI sees a customer-safe digest only; office AI may see
internal data but its output is office-reviewed before sending; all calls metered +
capped; refusal-to-guess over hallucination.

## Integrations

Supabase Auth (customer login) · `roybal-notify`/Twilio (link + nudge texts, optional
SMS-OTP login) · QuickBooks Online (invoice/balance/pay) · `field-media` storage
(signed shared media) · the `unified_jobs` spine (the portal is another consumer) ·
Vercel (subdomain hosting).

---

## Phase A1 — Spec (next up)

### Data model — `portal_jobs` (new migration)

One row per job that's been shared to the portal. Customer-safe fields only.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `field_project_id` | uuid | source field job (soft link) |
| `unified_job_id` | uuid | job spine (soft link, like `sms_messages`) |
| `share_token` | text unique | long, unguessable; the Phase-A credential; revocable |
| `enabled` | boolean | office on/off switch |
| `customer_name` | text | curated |
| `property_address` | text | curated |
| `status` | text | current milestone key |
| `milestones` | jsonb | `[{key,label,state:'done'|'current'|'upcoming',at}]` |
| `photos` | jsonb | `[{mediaHash,caption,stage}]` — **references**, not image data |
| `documents` | jsonb | `[{label,type,mediaHash}]` — estimate / cert / invoice |
| `published_at` | timestamptz | last office publish |
| `created_at` / `updated_at` | timestamptz | |

Photos/documents store **media references** (bucket hashes), never data URLs — the
gateway mints signed URLs on view, so rows stay tiny and access stays controlled.

### Access & RLS

- **Crew (authenticated):** may insert/update/select all `portal_jobs` — they publish.
  (Same trusted-crew model as the rest of the app.)
- **Customers (Phase A):** *no* direct table access. They never hold a DB credential.
  They present a `share_token` to the `roybal-portal` edge function, which returns the
  curated slice. The token is the bearer credential — long, random, revocable, and it
  only unlocks the one job's safe slice.
- **Phase B adds** (no rewrite): a `portal_access(user_id, portal_job_id)` table + an
  RLS policy allowing a logged-in customer to select their own `portal_jobs` row. The
  gateway then accepts either a token or a customer JWT.

### `roybal-portal` edge function (deployed `--no-verify-jwt`; public but token-gated)

- `view` — `{ token }` → `{ job:{customerName,address,status,milestones},
  photos:[{url,caption,stage}], documents:[{label,url,type}] }`. Looks up the token,
  returns the slice, mints short-lived signed URLs for the shared media. Rate-limited;
  leaks nothing beyond the projection.
- (Phase B extends with authed actions: `sendMessage`, `submitSelection`, `approve`…)

### Office Share panel (field/admin, per job)

- **Enable portal** → creates the `portal_jobs` row + `share_token`.
- **Status / milestones** — set or auto-derive from the job stage + Job Board phases.
- **Photos** — pick which job photos are shared (default none).
- **Documents** — pick which generated docs are shared (estimate, cert of drying,
  invoice).
- **Share** — Copy link / **Text link to customer** (via `roybal-notify`).

### Portal app (`apps/portal`) — read-only

New PWA, customer branding. Route `portal.roybalconstruction.com/j/<token>`. Calls
`roybal-portal → view`; renders the status timeline, photo gallery, and documents.
Responsive, no login.

### Deploy / DNS

- **Vercel** project rooted at `apps/portal`, custom domain
  `portal.roybalconstruction.com`.
- **DNS:** add a `CNAME portal → cname.vercel-dns.com` at the domain registrar
  (walk-through provided when we wire it).
- Internal apps stay on GitHub Pages at `app.roybalconstruction.com` — untouched.

### Security review before go-live

Same adversarial pass we ran on `roybal-notify`: token unguessability/revocation, the
gateway leaking only the projection, signed-URL scope/expiry, rate-limiting, and the
RLS boundary that keeps `portal_jobs` crew-writable but never customer-writable in A.
