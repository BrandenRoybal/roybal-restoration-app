# Cutover runbook — Marketing 360 → self-hosted

## ✅ LAUNCHED 2026-08-13 — `www` is the new site

`https://www.roybalconstruction.com` serves the Astro build from Cloudflare
Pages (`roybal-site-pages`, direct upload — no Git CI; redeploy with
`npx wrangler pages deploy apps/site/dist --project-name roybal-site-pages --branch main`).

⚠️ **`--branch main` is required for a production deploy.** Without it,
wrangler uses the branch of the current git checkout — and any non-`main`
checkout (a worktree, a feature branch) silently creates a **preview**
deployment instead: it succeeds, prints a URL, and changes nothing on `www`.

Verified at launch: 36/36 ranking URLs `200` with no redirect · sitemap index →
36 URLs · real `404` on unknown paths · TLS 1.3, chain verify 0, cert from
Google Trust Services · HSTS `max-age=31536000` · zero mixed content · CORS
green from the live origin on both `roybal-lead` and `roybal-web-agent` ·
`app` and `portal` untouched at `200`.

**The same morning also ended a months-long outage.** `www` had been a CNAME to
a dead Wix stub whose certificate expired 2025-04-15, so the site was hard-
blocked and 33 of 35 ranking URLs returned 404 to Googlebot. See step 6b.

### What is still on Madwire — do NOT cancel

The **apex only**. `roybalconstruction.com` keeps its `A` record at
`34.95.85.224`, and that server performs the apex→`www` 301. Bare
`roybalconstruction.com` is on business cards and the Google Business Profile,
and nothing else serves that redirect until step 7 in October.

Consequence worth knowing: typing the bare domain means **one plain-HTTP hop**
on Madwire before the redirect lands on HTTPS. Chrome flags that hop "Not
Secure" — it is the hop, not the site. **Publish the `www` URL** everywhere.
The hop disappears when Cloudflare owns the zone.

### Open items

- **Oct 11** — registrar transfer to Porkbun (step 6b), then step 7. Do not
  change the registrant contact before then; it restarts the 60-day lock.
- Search Console: resubmit the sitemap, request indexing on `/`.
- GA4 property in your own account (step 3) — do it before October so traffic
  is comparable across the second move.
- `src/data/site.ts` still carries approximate Fairbanks coordinates; replace
  with the real lat/long from the GBP listing now that Royal Rd is live.
- Drop `https://roybal-site-pages.pages.dev` from `LEAD_ALLOW_ORIGIN` and
  `WEB_AGENT_ALLOW_ORIGIN` once nothing needs the staging origin.

### DNS propagation behaves worse than "wait for the TTL"

During this launch `8.8.8.8` served the **old** record while `8.8.4.4`, Google's
own DoH endpoint, `1.1.1.1`, `9.9.9.9` and OpenDNS all served the new one — and
the stale node re-cached with a fresh 1800s TTL. Chrome hit the stale node while
`curl` on the same machine got the new answer, which reads exactly like a broken
deploy and is not one. **Incognito does not help** (this is resolver state, not
browser cache). Confirm against `https://roybal-site-pages.pages.dev` directly,
which bypasses the domain entirely, before debugging anything else.

---

Order matters. Steps 1–5 change nothing publicly and are all reversible.
Step 7 is the switch.

**Do not cancel Marketing 360 until step 9.** Their site keeps serving —
and keeps earning — right up to the DNS change, and it's the rollback if
anything goes wrong.

---

## Before you start: what you already control

Verified 2026-08-11:

- **The domain is yours.** Registered to "roybal construction, llc" at Wix,
  paid through 2030-03-31. Madwire has no claim on it.
- **DNS is at Wix** (`ns8/ns9.wixdns.net`) — you change records there.
- **Email is separate.** MX points at Google Workspace. Cutover does not touch
  it. `branden@roybalconstruction.com` keeps working throughout, and the new
  `info@` address is a Workspace change, not a DNS one.
- **Only the website itself** is on Madwire's server (`34.95.85.224`).

## What you lose when you cancel, and it's not recoverable

- **Top Rated Local reviews** (`topratedlocal.com/review/roybal-construction-llc-reviews`).
  Madwire's own review platform. Not portable. **Screenshot or copy them
  before cancelling** if you want the text.
- **Google Tag Manager container `GTM-NVBWQFPR`** is probably owned by their
  Google account, not yours. Check whether you can log into it. If not, you
  lose historical analytics — export what you want from GA first.
- Any leads sitting in their CRM that you haven't already exported.

---

## 0. Address change — do this BEFORE the site goes live

**Only the address changed.** The phone briefly moved to a toll-free 866 and
was reverted on 2026-08-12; the site publishes `(907) 371-9868`, exactly what
your Google Business Profile and every directory already say. That was the
riskiest item on this project and it is now simply gone — no phone
re-verification, no citation sweep, no ranking wobble.

**Do it in this order:**

1. **Create `info@roybalconstruction.com`** in Google Workspace admin — a
   mailbox or an alias onto `branden@`. The site prints it on all 36 pages and
   in the privacy policy. Without it, you're publishing an address that bounces.

2. **Update the Google Business Profile first**, to `3850 Royal Rd, Fairbanks,
   AK 99701`. Leave the phone alone. Expect GBP to re-verify the address —
   usually a postcard, which takes days to weeks. **Start this early**; it's
   the long pole, not the website.

3. **Then ship the site**, so GBP and the site agree from the moment it's live.

4. **Then work the citations**, highest-traffic first: Facebook, Yelp, BBB,
   Angi, Nextdoor, the Fairbanks chamber, any supplier or insurer directories
   you're listed in. You're only correcting the address — anything still
   showing Trailer St is a contradiction; the phone needs no attention.

Once GBP shows the Royal Rd address live, pull the real lat/long from the
listing and replace the approximate coordinates in `src/data/site.ts`.

### The AI receptionist and the 907 — SOLVED, do not port

**Resolved 2026-08-12 by conditional call forwarding, and this is the right
answer.** The AT&T line's no-answer forward was changed from voicemail to
`(866) 345-2290`. So a caller rings Branden's phone first, he answers if he
can, and the AI picks up instead of voicemail if he doesn't.

**Do NOT port `907-371-9868` into Twilio.** An earlier version of this runbook
recommended it. That was wrong, for two reasons:

1. `OWNER_CELL` **is** `9073719868` — verified against the stored secret digest.
   The phone receptionist dials `OWNER_CELL` to escalate, and lead alerts text
   *to* it. Make the AI's inbound line the same number and it dials and texts
   itself: Twilio refuses a same-number send and escalation has nowhere to go.
2. It is the phone in Branden's pocket. Porting it hands every personal call to
   the AI.

If a dedicated AI line is ever wanted, **buy a new 907 number in Twilio** rather
than porting this one — local area code preserved, `OWNER_CELL` stays distinct,
personal line stays personal.

**Worth testing once:** call the 907 and let it ring through to the AI, then ask
it to reach the owner. The AI escalates by dialing `OWNER_CELL` — which is the
same line that just forwarded — so confirm that path terminates cleanly instead
of looping back into the AI.

## 1. Confirm the content is right

Work through `CONTENT-REVIEW.md`. Services, business info, photos, and
testimonials all need your eyes. This is the long pole — everything else here
is mechanical.

> **DEPLOYED 2026-08-12.** Migration 227, `roybal-lead`, `roybal-web-agent`, and
> the updated `roybal-notify` are all live on the production project, and the
> site is serving at `https://roybal-site.branden-9a6.workers.dev`. Steps 2 and
> 2b below are kept as the record of what was run and how to redo it.
>
> **One thing to undo at cutover:** `WEB_AGENT_ALLOW_ORIGIN` and
> `LEAD_ALLOW_ORIGIN` currently include the `*.workers.dev` staging URL. Once
> DNS points at the real domain, reset both to
> `https://www.roybalconstruction.com` alone so the staging URL can't drive the
> paid lane.

## 2. Deploy the lead function

```bash
supabase functions deploy roybal-lead --no-verify-jwt
```

`--no-verify-jwt` is required: the public site has no session. The function
self-protects — honeypot, per-IP and global hourly caps, no read path at all.

> Since 2026-08-14, `supabase/config.toml` pins `verify_jwt = false` for this
> function (and `roybal-web-agent`), so a plain CLI deploy without the flag
> keeps the setting. The flag stays harmless. ⚠️ The Supabase MCP deploy tool
> ignores config.toml and defaults verify_jwt to **true** — that flip killed
> both functions on 2026-08-13. Deploy these via CLI, and after any MCP or
> dashboard redeploy verify with
> `supabase functions list --project-ref djpgvcvhvgrzgaziruze -o json`.
Optional tuning:

```bash
supabase secrets set LEAD_IP_MAX=5 LEAD_HOURLY_MAX=40
```

Then submit a real test through the site and confirm a card appears on the job
board in the lead column.

## 2b. Deploy the AI receptionist (optional — the site works without it)

Since 2026-08-14 the panel ships **by default** — the production endpoint is
committed in `src/data/site.ts`, so no env var is needed. To ship the site
first and turn the receptionist on afterwards, build with
`PUBLIC_WEB_AGENT_ENDPOINT=""` (or `off`) — the explicit build-time kill
switch; the postbuild guard warns but allows it.

```bash
supabase db push
supabase secrets set WEB_AGENT_SECRET="$(openssl rand -hex 32)"
supabase functions deploy roybal-web-agent --no-verify-jwt
```

No `.env` step needed since 2026-08-14 — the committed default endpoint means
a plain rebuild picks the receptionist up.

Before you point real traffic at it, run the abuse pass from
`supabase/functions/roybal-web-agent/README.md`: set `WEB_SPEND_DAILY_USD=0.01` and
confirm the panel becomes the quote form; unset `LLM_API_KEY` and confirm an
emergency message still fires the call card and texts you.

**The kill switch is one command and needs no redeploy:**

```bash
supabase secrets set WEB_AGENT_ENABLED=false
```

Hard ceiling is $8.79/month, enforced in the database. Expected real cost is about a
dollar. Day-2 queries for "is it on" and "what has it cost" are in that README.

## 3. Stand up your own analytics

GA4 property in **your** Google account, then add the tag. Do this before
cutover so there's no gap in data, and so you can compare traffic across the
switch rather than guessing.

## 4. Verify Search Console

`google-site-verification=sSMew_T29JeU5astPd2n4YNAu0BgweRxTp6KciYD06c` is
already carried into every page's `<head>`, so existing verification survives.

Confirm you can log into Search Console for this property. If the property is
under Madwire's account, add your own via DNS TXT at Wix **now** — losing
Search Console access at cutover means flying blind exactly when you need to
watch for problems.

## 5. Build and check parity

```bash
npm run site:build
```

The build runs the parity gate automatically and fails if any of the 36 live
URLs stops resolving. It must print:

```
✓ All archived URLs resolve at identical paths.
```

## 6. Set up Cloudflare Workers and test on its temporary URL

### ⚠️ Push the code first

`apps/site`, the two new edge functions, and migration 227 are **untracked**
until they are committed and pushed. Cloudflare builds from GitHub, so
deploying before the push fails with "no workspace named apps/site" — which
reads like a config error and isn't one.

### Connect the repo

Create a free Cloudflare account, then **Workers & Pages → Create → Connect to
Git** and pick this repository. Cloudflare has folded Pages into Workers, so
the current flow asks for a **deploy** command as well as a build command.

| Setting | Value |
|---|---|
| Project name | `roybal-site` — must match `name` in `wrangler.jsonc` |
| Build command | `npm run site:build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | *leave blank* — the repo root |

`wrangler.jsonc` at the repo root does the rest: it declares an assets-only
Worker pointing at `apps/site/dist`, and pins `html_handling` to
`auto-trailing-slash` so `/contact-us` is served from `contact-us.html` with
**no redirect**. That one setting is what protects the 36 ranking URLs.

**Environment variables** — set these in the Pages project under Settings →
Environment variables, for both Production and Preview:

```
NODE_VERSION               = 22
PUBLIC_LEAD_ENDPOINT       = https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-lead
PUBLIC_WEB_AGENT_ENDPOINT  = https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-web-agent
```

**Since 2026-08-14 the two `PUBLIC_*` values are optional** — the production
endpoints are committed as defaults in `src/data/site.ts`, and the postbuild
guard fails any build whose HTML is missing the quote-form endpoint or the
receptionist markup. (Before that, missing them meant the build still
succeeded with a dead form and no panel. Silent, and it bit for real on
2026-08-13.) Set them only to point a preview at different endpoints.

Every push to `main` now rebuilds and publishes. The parity gate runs as part
of `npm run site:build`, so **a build that would orphan a ranking URL fails
instead of deploying.**

### Verify the deployment BEFORE touching DNS

Cloudflare gives you a free `*.workers.dev` URL. Point the live checker at it:

```bash
npm run site:check-live -- https://roybal-site.workers.dev
```

It requests all 36 ranking URLs and demands a bare `200` on each — no
redirects — plus `/sitemap.xml`, `/robots.txt`, and a real 404 on an unknown
path. `check-parity.mjs` only proves the files exist in `dist/`; this proves
the *server* hands them out at the right paths, which is the part that depends
on host configuration and is invisible locally.

It must print:

```
✓ Every ranking URL answers 200 with no redirect. Safe to cut over.
```

If it reports redirects, `html_handling` is wrong — fix it before DNS, not
after. Then browse the site yourself on a phone; most restoration leads arrive
on one.

`public/_headers` and `public/_redirects` ship with the build: caching,
security headers, and a redirects file that is deliberately empty because
nothing has moved.

## 6b. ⚠️ The domain must leave Wix first — discovered 2026-08-13

**Wix will not delegate nameservers, so step 7 cannot be performed from Wix.**
Its DNS editor shows an NS section marked *"NS records are not editable"*, and
that is a platform limit, not a hidden setting: Wix's own help center states
*"it's not possible to change name servers (edit NS records) for a Wix domain"*
and offers transferring the domain away as the only route
(support.wix.com/en/article/request-changing-name-server-ns-records-for-a-wix-domain).

**And Cloudflare Registrar cannot be the transfer target.** It requires the
domain to already be an active zone on Cloudflare nameservers before it will
accept a transfer
(developers.cloudflare.com/registrar/get-started/transfer-domain-to-cloudflare).
Wix blocks the nameserver change; Cloudflare demands it first. Going
Wix → Cloudflare Registrar directly is a deadlock. An intermediate registrar is
mandatory.

**Chosen route: transfer to Porkbun**, then delegate to Cloudflare.

### 🔒 BLOCKED UNTIL 2026-10-11 — the address change armed a transfer lock

Wix reports the domain *"is currently locked and can't be transferred to another
domain provider. It will be available for transfer on Oct 11, 2026."*

Sixty days before Oct 11 is **Aug 12** — the day the registrant contact was
updated to the Royal Rd address. That is step 0 of this runbook. **Doing step 0
correctly is what blocked step 7.** ICANN's Transfer Policy requires a 60-day
inter-registrar lock after any change to registrant information.

**It cannot be lifted.** Registrars may offer an opt-out *before* a registrant
change, but ICANN bars them from removing it once running: registrars "may not
allow registrants to opt out of the 60-day inter-registrar transfer lock during
the 60-day lock." Do not waste time on Wix support — it is not their rule.

The escape hatch is priced out: Cloudflare's partial (CNAME) zone setup would
keep DNS at Wix while still using Cloudflare, but it is "only available to
customers on a Business or Enterprise plan" — $200+/month.

**So the launch does not wait for this.** See step 6c: the site ships on
Cloudflare Pages over the existing Wix DNS, and only the Madwire cancellation
slips to October. DNSSEC is already off, which stays true and is one less thing
to do then.

**On or after 2026-10-11:**

1. **Wix → Domains → `…` → Transfer away from Wix.** Unlock the domain and
   request the authorization (EPP) code. It is emailed to the registrant address.
2. **Porkbun → Transfer a Domain**, enter the auth code, pay (~$11; a .com
   transfer adds a year, so `2030-03-31` becomes `2031-03-31`).
3. **Approve the transfer from the Wix side** if offered. Otherwise it waits out
   the mandatory 5-day ICANN window.
4. **Do not change the registrant contact again before then** — it would restart
   the 60-day clock.

### ⚠️ The one dangerous moment is the instant the transfer completes

Until then, Wix keeps answering DNS and nothing changes. **When the domain
leaves, Wix stops serving the zone** — and if the nameservers still point at
`ns8/ns9.wixdns.net` at that moment, the domain goes dark. Not just the website:
**email dies too.**

So the moment the transfer lands, set the nameservers at Porkbun to the
Cloudflare pair — before anything else, same sitting:

```
archer.ns.cloudflare.com
barbara.ns.cloudflare.com
```

The Cloudflare zone is already built and verified (all 13 records, all five MX,
confirmed identical from both nameservers on 2026-08-13), so it takes over
cleanly. Then verify email immediately per the checks at the end of step 7.

### Meanwhile: the `www` outage fix, applied 2026-08-13

`www` was a CNAME to `initial.wixdns.net` — a dead Wix stub with a certificate
that expired 2025-04-15 — which is why the site was hard-blocked. Madwire was
healthy throughout; verified with a forced-resolve request that
`34.95.85.224` serves `www.roybalconstruction.com` at **200 with a valid cert**.

Fix while DNS is still at Wix: edit the `www` CNAME value to
`roybalconstruction.com` (chains to the apex A record at Madwire). Edit in
place — deleting and re-adding as an A record leaves a window with no record
at all.

That restores the *old* Madwire site. Step 6c then repoints the same record at
the new one.

## 6c. Interim launch — Cloudflare Pages over Wix DNS

Ship the new site on `www` now, without the transfer. **Pages, not a Worker:**
Workers Custom Domains require an active Cloudflare zone, but Pages issues a
certificate for a custom domain reached by a plain CNAME from an external DNS
provider. That works for **subdomains only** — "if you are deploying to an apex
domain, then you will need to add your site as a Cloudflare zone and configure
your nameservers." `www` is a subdomain, so `www` can move today. The apex
cannot, which is why Madwire stays until October.

Nothing in the repo needs to change. The build already emits Pages-native
`_headers` and `_redirects` into `dist/`, and `astro.config.mjs` sets
`build.format: "file"` with `trailingSlash: "never"`, so paths stay
extensionless. Verified 2026-08-13: Pages serves `/contact-us` from
`contact-us.html` at **200 with no redirect** — the same behavior the Worker
gets from `html_handling: "auto-trailing-slash"`.

The root `wrangler.jsonc` can stay exactly as it is. It has no
`pages_build_output_dir`, so a Pages Git build ignores it (warning only) — the
Worker config survives untouched for October.

### Create the project

**Workers & Pages → Create → Pages → Connect to Git.**

| Setting | Value |
|---|---|
| Project name | `roybal-site-pages` — the Worker already owns `roybal-site` |
| Production branch | `main` |
| Build command | `npm run site:build` |
| Build output directory | `apps/site/dist` |
| Root directory | *leave blank* — the repo root |

Name it something other than `roybal-site`. A Worker of that name already
exists from the staging deploy, and Cloudflare has been merging the two
namespaces. The `*.pages.dev` hostname derives from this name.

**Environment variables** — Production *and* Preview:

```
NODE_VERSION               = 22
PUBLIC_LEAD_ENDPOINT       = https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-lead
PUBLIC_WEB_AGENT_ENDPOINT  = https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-web-agent
```

**Since 2026-08-14 the two `PUBLIC_*` values are optional.** They are read at
**build** time (`import.meta.env` in `QuoteForm.astro` and
`Receptionist.astro`), but an unset var now falls back to the committed
production endpoint in `src/data/site.ts`, and the postbuild guard fails any
build whose HTML lacks the quote-form endpoint or receptionist markup — the
silent env-less breakage of 2026-08-13 can no longer deploy.

### Prove it on `*.pages.dev` BEFORE touching `www`

```bash
npm run site:check-live -- https://roybal-site-pages.pages.dev
```

Must print `✓ Every ranking URL answers 200 with no redirect. Safe to cut over.`
This is the gate. Pages' path handling is host configuration, invisible locally,
and it is the one thing that could put a 301 on all 36 ranking URLs.

Also add the Pages origin to the two edge functions, or the form and the
receptionist will be blocked by CORS from the new host:

```bash
supabase secrets set LEAD_ALLOW_ORIGIN=https://roybal-site-pages.pages.dev,https://www.roybalconstruction.com
supabase secrets set WEB_AGENT_ALLOW_ORIGIN=https://roybal-site-pages.pages.dev,https://www.roybalconstruction.com
```

Drop the `pages.dev` entry from both once `www` is serving, so a staging URL
can't drive the paid AI lane. Same cleanup the `workers.dev` URL needs.

### Point `www` at it — dashboard first, DNS second

**Order matters and the failure is misleading.** Cloudflare: "manually adding a
custom CNAME record pointing to your Cloudflare Pages site without first
associating the domain in the Cloudflare Pages dashboard will result in your
domain failing to resolve … and display a 522 error." A 522 reads like a broken
deployment; it is only a missing association.

1. **Pages → the project → Custom domains → Set up a custom domain** →
   `www.roybalconstruction.com`. Cloudflare will say it cannot find the domain
   in your account and offer the CNAME target instead. That is expected — the
   zone is not delegated.
2. **Then** in Wix DNS, edit the `www` CNAME value to the `*.pages.dev`
   hostname. Edit in place; do not delete and re-add.
3. Wait for the certificate to issue (minutes, occasionally an hour).
4. Re-run the checker against the real host:
   ```bash
   npm run site:check-live -- https://www.roybalconstruction.com
   ```

### What is still on Madwire after 6c

Only the apex. `roybalconstruction.com` keeps its `A` record at `34.95.85.224`,
whose server performs the apex→`www` 301. **Do not cancel Marketing 360 yet** —
bare `roybalconstruction.com` is on business cards and the Google Business
Profile, and nothing else is serving that redirect until the zone is on
Cloudflare in October and step 7's redirect rule replaces it.

## 7. The switch — move DNS to Cloudflare

Workers Custom Domains require the domain to be an active Cloudflare zone
("you cannot create a Custom Domain … on a zone you do not own" —
developers.cloudflare.com/workers/configuration/routing/custom-domains). So the
nameservers move to Cloudflare — **from Porkbun, after step 6b**, not from Wix.
Pages would have allowed a plain CNAME from Wix for `www`, but this site is
deployed as a Worker, and a CNAME could never have covered the apex anyway.

### ⚠️ THE COMPLETE ZONE, captured 2026-08-12 BEFORE any change

Cloudflare scans and imports existing records, but **verify every line below is
present before you flip the nameservers.** Two of these are easy to miss and
take down systems the crew and customers use daily.

| Type | Name | Value | After the move |
|---|---|---|---|
| A | `@` (apex) | `34.95.85.224` (Madwire) | **replaced** — see below |
| CNAME | `www` | `roybalconstruction.com` | **replaced** — Worker Custom Domain |
| CNAME | `app` | `brandenroybal.github.io` | **KEEP — DNS only (grey cloud)** |
| CNAME | `portal` | `cname.vercel-dns.com` | **KEEP — DNS only (grey cloud)** |
| MX (10) | `@` | `aspmx.l.google.com` | keep |
| MX (20) | `@` | `alt1.aspmx.l.google.com` | keep |
| MX (30) | `@` | `alt2.aspmx.l.google.com` | keep |
| MX (40) | `@` | `alt3.aspmx.l.google.com` | keep |
| MX (50) | `@` | `alt4.aspmx.l.google.com` | keep |
| TXT | `@` | `v=spf1 include:_spf.createsend.com include:_spf.google.com ~all` | keep |
| TXT | `@` | `google-site-verification=TZSrekgUL4A7NiQfaKgKC2Xs9W1bGIRqIU6OwhZefC0` | keep |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | keep |
| TXT | `cm._domainkey` | `k=rsa; p=MIGf…` (Campaign Monitor DKIM) | keep |

**`app` and `portal` must be DNS-only (grey cloud), not proxied.** GitHub Pages
and Vercel terminate TLS themselves; proxying them through Cloudflare invites
certificate errors and redirect loops. `app` serves the field, admin, and board
apps the crew uses; `portal` serves customers.

**Thirteen records — and neither discovery method found all of them.** The
`cm._domainkey` entry is Campaign Monitor's DKIM key. It pairs with
`_spf.createsend.com` in the SPF record, and losing it makes marketing email
start failing DKIM and landing in spam. The `dig` sweep that produced this table
missed it (that sweep probed a fixed list of subdomain names); Cloudflare's zone
scan caught it.

But the scan is not complete either. Wix's DNS editor shows a **fourteenth**
record the Cloudflare scan did not import:

| Type | Name | Value | Verdict |
|---|---|---|---|
| CNAME | `en` | `cdn1.wixdns.net` | dead — **do not recreate** |

Checked 2026-08-13: it answers `404` (with a valid certificate), and `en.` appears
nowhere in `.site-archive/content.json`, so no ranking URL depends on it. It is
Wix-site debris. Letting it die at cutover is correct.

**The lesson is that no single source is authoritative.** Read the zone from the
provider's own editor *and* the Cloudflare scan *and* a `dig` sweep, then
reconcile. Each one missed something the others caught.

**Set every record to DNS only (grey cloud) for the nameserver move.** Not just
`app` and `portal` — the apex and `www` too. They still point at Madwire, and
proxying them puts Cloudflare's cache and an unverified SSL mode in front of a
server that performs its own apex→www redirect, which is how redirect loops
happen. The move should change nothing for visitors; grey-clouding everything
guarantees that. Proxying gets turned on deliberately when the Worker is bound.

**The five MX records and the SPF TXT are the business's email.** Miss one and
mail stops — far worse than any website problem. Do not flip nameservers until
you have counted all five.

### ⚠️ DNSSEC MUST BE DISABLED FIRST — this one can black out the whole domain

Verified 2026-08-12: DNSSEC **is enabled**. The `.com` registry holds a DS record
for this domain:

```
DS  24292 8 2 A07F093628041FBBE58E688C8DA2B1C0F1CDEFAF89A9F913AB05D440 8E7183F1
```

That record tells every validating resolver "answers for this domain are signed
by Wix's key". Move the nameservers to Cloudflare while it is still published
and those resolvers — Google 8.8.8.8, Cloudflare 1.1.1.1, Quad9, most ISPs —
get answers signed by the wrong key and **refuse to resolve the domain at all.**

Not just the website: email, `app`, and `portal` go with it, for an
unpredictable subset of people depending on which resolver they use. There is
no fast rollback; the DS record's TTL is **86400s (24 hours)**, so recovery
means waiting out the same cache either way.

Cloudflare's setup page lists this under "Recommended". For this domain it is
mandatory.

Order:

1. **Wix → Domains → DNSSEC → turn OFF.** This asks the registry to drop the DS.
2. Poll until this returns **nothing**:
   ```bash
   dig +short DS roybalconstruction.com @a.gtld-servers.net
   ```
3. **Then wait out the 24h TTL** before switching nameservers. The registry
   dropping the record does not evict it from resolvers that already cached it.
4. Only then do the nameserver change below.
5. Re-enable DNSSEC afterwards from Cloudflare's side if wanted — free, a real
   improvement, and safe once Cloudflare is authoritative. Never during the move.

### Steps

1. **Cloudflare → Add a site** → `roybalconstruction.com` → Free plan.
   ✅ Done 2026-08-13 — zone `4df71ef17338f142d605ec839604bd6c`, Free plan.
2. **Review the imported records against the table above.** Add anything
   missing. Set `app` and `portal` to DNS-only.
   ✅ Done 2026-08-13 — 13 records, all DNS-only. The scan imported only one MX;
   the four `alt1`–`alt4` were added by hand. Verified from both nameservers.
3. **Porkbun → Domain Management → Authoritative Nameservers** → replace
   Porkbun's defaults with the two Cloudflare nameservers. Do this the moment
   the transfer completes (see step 6b — Wix stops serving DNS at that point).
   Propagation is usually minutes, up to 24h.
4. Wait for Cloudflare to report the zone **Active**.
5. **Workers → `roybal-site` → Settings → Domains & Routes → Add Custom Domain**
   → `www.roybalconstruction.com`. Cloudflare creates the DNS record and issues
   the certificate automatically. This replaces the old `www` CNAME.
6. **Apex → www redirect.** Cloudflare → Rules → Redirect Rules → create:
   *If* hostname equals `roybalconstruction.com` → *then* dynamic redirect,
   **301**, to `concat("https://www.roybalconstruction.com", http.request.uri.path)`.
   This replaces the redirect Madwire's server was performing, and preserves the
   path so deep links keep working.
7. Delete the old apex `A` record pointing at `34.95.85.224`.

**Do it on a weekday morning**, not a Friday afternoon.

### Immediately verify email still works

Before touching anything else:

```bash
dig +short MX roybalconstruction.com   # must list all five Google servers
dig +short TXT roybalconstruction.com  # must include the SPF line
```

Then send yourself a message from an outside address and confirm it arrives.

### And that nothing else broke

```bash
curl -sI https://app.roybalconstruction.com/    -o /dev/null -w "app    %{http_code}\n"
curl -sI https://portal.roybalconstruction.com/ -o /dev/null -w "portal %{http_code}\n"
```

## 8. Immediately after

Within the first hour:

```bash
for u in / /contact-us /restoration-services/water-damage-restoration-in-fairbanks /kitchen-remodeling-in-fairbanks /blog; do
  printf "%-60s " "$u"; curl -s -o /dev/null -w "%{http_code}\n" "https://www.roybalconstruction.com$u"
done
```

All should be `200`. Then check:

- `https://www.roybalconstruction.com/sitemap.xml` loads and lists 36 URLs
- `https://www.roybalconstruction.com/robots.txt` loads
- **Non-www and http still redirect in one hop to `https://www.`** — this is
  the apex forward you just set up replacing Madwire's. Test it explicitly:
  ```bash
  curl -sI https://roybalconstruction.com/ -o /dev/null -w "%{http_code} -> %{redirect_url}\n"
  ```
  It must print `301 -> https://www.roybalconstruction.com/`. If it doesn't,
  every link and business card without `www` is dead.
- Submit the quote form for real and watch the lead land on the board
- Rich Results Test on the homepage and one service page — LocalBusiness and
  Service should both be detected

In Search Console, resubmit the sitemap and request indexing on the homepage.

## 9. Then, and only then

Cancel Marketing 360 — after the new site has served clean traffic for at
least a few days and you've salvaged the reviews and analytics from step
"what you lose".

## First month

Rankings commonly wobble for 1–3 weeks after any platform migration, even a
clean one. That's normal and not a reason to panic or revert.

Watch weekly in Search Console:

- **Coverage** — any URL moving to "Crawled, not indexed" or "Excluded"
- **Performance** — impressions per page vs. the 28 days before cutover
- **Enhancements** — structured data errors (this site has more markup than
  the old one ever did, so this section will be newly populated)

The one number that actually matters: phone calls and form submissions. The
new site logs every web lead to the job board with `source: "web"`, so you can
count them directly rather than inferring from traffic.
