# Cutover runbook — Marketing 360 → self-hosted

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

### Getting the AI receptionist onto the 907

The receptionist currently answers the toll-free `(866) 345-2290`, which is a
Twilio number. The website publishes the 907 regardless, because that number
already rings you today — so there is no dependency and nothing is broken
while you decide.

**Port the 907 into Twilio** and the AI answers it directly. Usually $1–15
one-time; schedule the cutover and don't cancel the losing carrier until the
port completes.

**Do not forward 907 → 866 instead.** Three reasons:

- `TWILIO_FROM` is one number for voice *and* SMS, so a customer who dialled
  the 907 would get texts back from a number they don't recognise.
- Depending on the carrier, forwarding presents the *forwarding* line to
  Twilio rather than the real caller. `services/phone-agent` keys `createLead`,
  `lookupCaller`, and its per-caller rate limits on `session.from` — so the
  receptionist could lose the callback number and collapse every caller into
  one rate-limit bucket. That's a functional break, not a cosmetic one.
- It's a config on another carrier's system that can silently stop working.

Keep the 866 afterwards as a spare — it's already provisioned, and it's a
ready-made tracking number if you ever want to measure one ad channel without
touching the published NAP.

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
Optional tuning:

```bash
supabase secrets set LEAD_IP_MAX=5 LEAD_HOURLY_MAX=40
```

Then submit a real test through the site and confirm a card appears on the job
board in the lead column.

## 2b. Deploy the AI receptionist (optional — the site works without it)

The panel renders only when `PUBLIC_WEB_AGENT_ENDPOINT` is set, so you can ship the
site first and turn the receptionist on afterwards.

```bash
supabase db push
supabase secrets set WEB_AGENT_SECRET="$(openssl rand -hex 32)"
supabase functions deploy roybal-web-agent --no-verify-jwt
```

Then set `PUBLIC_WEB_AGENT_ENDPOINT` in `apps/site/.env` and rebuild.

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

## 6. Set up Cloudflare Pages and test on its temporary URL

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

⚠️ **`apps/site/.env` is gitignored, so Cloudflare will never see it.** Miss
these two and the build still succeeds — but the quote form posts nowhere and
the receptionist panel doesn't render at all. Silent, and exactly the kind of
thing nobody notices for a week.

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

## 7. The switch — TWO records, not one

⚠️ **The apex is not just an A record — it is also doing a job.** Today:

```
www.roybalconstruction.com  CNAME → roybalconstruction.com
roybalconstruction.com      A     → 34.95.85.224   (Madwire)
```

and **Madwire's server performs the `roybalconstruction.com` → `www.` 301**.
So cancelling them breaks two things: the apex stops resolving anywhere useful,
*and* the redirect that catches everyone who types the domain without `www`
disappears with it. Handle both.

### The safe route: keep DNS at Wix

Change one record and add one forward:

1. **`www`** — change from a CNAME pointing at the apex to a CNAME pointing at
   `<your-project>.pages.dev`. In Cloudflare Pages, add
   `www.roybalconstruction.com` under **Custom domains** first; it tells you
   the exact target and issues the certificate automatically.
2. **Apex** — use Wix's domain forwarding to redirect `roybalconstruction.com`
   → `https://www.roybalconstruction.com`, replacing what Madwire was doing.

**This leaves email completely untouched**, which is the point. Your MX and SPF
records stay exactly where they are and Google Workspace never notices.

### The better long-term route: move DNS to Cloudflare

Free, faster, and the apex works properly via CNAME flattening with a Redirect
Rule for apex → www. But moving nameservers means **re-creating your email
records**, and getting that wrong takes down mail — which is far worse than a
website problem.

If you do it, Cloudflare's import scan runs before you flip the nameservers.
**Do not flip until you have confirmed all seven of these are present:**

```
MX   10 aspmx.l.google.com          MX   40 alt3.aspmx.l.google.com
MX   20 alt1.aspmx.l.google.com     MX   50 alt4.aspmx.l.google.com
MX   30 alt2.aspmx.l.google.com
TXT  v=spf1 include:_spf.createsend.com include:_spf.google.com ~all
TXT  google-site-verification=TZSrekgUL4A7NiQfaKgKC2Xs9W1bGIRqIU6OwhZefC0
```

**Recommendation: take the safe route on cutover day.** Move DNS to Cloudflare
later, on a quiet afternoon, once the site is proven. Don't change two risky
things at once — if something breaks, you want to know which one did it.

### Either way

**Do it on a weekday morning**, not a Friday afternoon. Lower the TTL on the
`www` record to 300 seconds a day beforehand so a rollback propagates in
minutes rather than hours.

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
