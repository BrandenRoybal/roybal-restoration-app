# Content review — what needs your eyes before launch

Every page was migrated verbatim from the Marketing 360 site so nothing is
blank and no ranking page lost its text. You flagged four areas as stale.
This is the working list.

**The rule that matters:** change any wording you like. Do **not** change the
`path:` field in a content file's frontmatter — those are the URLs that
currently rank. `npm run build` fails if one goes missing.

Each content file carries `reviewed: false`. Flip it to `true` as you go, so
we can tell reviewed copy from carried-over copy at a glance.

---

## 1. Services list — you said it's out of date

The site currently advertises these 14. Mark them up:

| Service | Page | Still offer? |
|---|---|---|
| Water Damage Restoration | `/restoration-services/water-damage-restoration-in-fairbanks` | |
| Fire Damage Restoration | `/restoration-services/fire-damage-restoration-in-fairbanks` | |
| Mold Removal | `/restoration-services/mold-removal-in-fairbanks` | |
| Storm Repair | `/restoration-services/storm-repair-in-fairbanks` | |
| Residential Remodeling | `/residential-remodeling-in-fairbanks` | |
| Kitchen Remodeling | `/kitchen-remodeling-in-fairbanks` | |
| Commercial Remodeling | `/commercial-remodeling-in-fairbanks` | |
| Painting Services | `/painting-services-in-fairbanks` | |
| Exterior Painting | `/exterior-painting-in-fairbanks` | |
| Roofing Services | `/roofing-services-in-fairbanks` | |
| Flooring Services | `/flooring-services-in-fairbanks` | |
| Deck Construction | `/deck-construction-in-fairbanks` | |
| Snow Removal | `/snow-removal-in-fairbanks` | |
| New Construction | `/new-construction-services-in-fairbanks` | |

**Anything missing?** Services you do now that aren't listed are pure upside —
a new page can rank without disturbing anything existing.

**Dropping one is the risky direction.** A page that ranks and gets deleted
should 301 to the nearest surviving service, not 404. Tell me which to drop
and I'll wire the redirects.

Edit the list in `src/data/site.ts` — it feeds the nav, footer, homepage
grids, and the JSON-LD service catalog from one place.

## 2. Business info

Updated 2026-08-11 from Branden. All in `src/data/site.ts`:

| Field | Now says | Status |
|---|---|---|
| Address | 3850 Royal Rd, Fairbanks, AK 99701 | ✅ updated |
| Phone | (907) 371-9868 — **unchanged** | ✅ the 866 was reverted 2026-08-12 |
| Toll-free | (866) 345-2290 — held as a spare, **never published** | ✅ not on the site |
| Email | info@roybalconstruction.com | ✅ updated — **mailbox must be created** |
| Office hours | Monday–Friday, 8:00am–5:00pm | ⬜ still unverified |
| Emergency | 24/7 response, under 60 minutes on site | ⬜ still unverified |
| Founded | 2023 | ⬜ still unverified |
| Experience claim | "over 20 years" (in page copy) | ⬜ still unverified |
| Geo coordinates | Fairbanks city centre, **approximate** | ⬜ needs the real parcel lat/long |

### Two things these changes create work for

**1. `info@roybalconstruction.com` doesn't exist yet.** The site now prints it
on all 36 pages and in the privacy policy. Create it in Google Workspace admin
(as a mailbox or an alias onto `branden@`) **before** cutover, or the site
advertises an address that bounces. I can't create it — it needs your admin
console.

**2. The address is now the only NAP change.** That is a much smaller job than
it was on 2026-08-11, when the plan also swapped the phone number.

Reverting to the 907 removed the riskiest item on this project. There is now
nothing to do about the phone at all: it already matches the Google Business
Profile, every directory listing, every truck, and every backlink. No
re-verification, no citation sweep, no ranking wobble.

The address still needs the GBP-first ordering in `CUTOVER.md`. Once GBP shows
the Royal Rd address live, pull the real lat/long from the listing and replace
the approximate coordinates in `site.ts`.

**On the toll-free number:** (866) 345-2290 stays as the Twilio line the AI
receptionist answers, but it is published nowhere. To have the AI answer the
907 instead, **port the 907 into Twilio** — do not solve it by forwarding
907 → 866. The reasoning is in the `LOCAL_NUMBER_NOTE` comment in
`src/data/site.ts`: `services/phone-agent` keys `createLead`, `lookupCaller`,
and its per-caller rate limits on the calling number, and forwarding can
present the forwarding line to Twilio instead of the real caller.

## 3. Photos

132 images came across. Honest assessment:

- **The 18 gallery photos are real project work and genuinely good** — the
  cable-rail deck and stair build especially.
- **Some service-page images are stock.** The kitchen on the old homepage was
  an AdobeStock file. Your own photos will always beat stock here.
- **Marketing 360 badge graphics** ("Commitment to Excellent Service", the
  5-star image) are their branding, not yours. Already excluded.
- **Resolution is low.** The homepage hero is only ~711px wide. It works
  behind the dark gradient but a full-resolution replacement would be a
  visible upgrade.
- **No alt text anywhere.** Gallery images are currently `alt=""`. Real
  captions ("Custom cable-rail deck, Chena Ridge") earn image-search traffic
  and are an accessibility requirement.

**What would help most:** a folder of your best current project photos at
full resolution, roughly labelled by service. I'll handle sizing and alt text.

## 4. Reviews

Four testimonials carried over (Pat T., Shorty W., Greg H., Chad H.) on
`/read-reviews`. You said you have better ones now.

Two notes worth knowing:

- **Review schema is deliberately absent.** Google stopped honouring
  "self-serving" review markup — a business publishing reviews about itself —
  in 2019. Adding it earns no stars and risks a manual action. Stars come from
  your Google Business Profile instead.
- **The old `/leave-review` page was doing review gating** — asking "Good or
  Bad?" and routing happy customers to public review sites while unhappy ones
  went to a private form. That violates Google's review policies and can get a
  profile's reviews suppressed. The rebuilt page offers both paths openly.

**Needed:** your Google Business Profile review link, from the GBP dashboard
under "Ask for reviews". It's hardcoded as a Maps search fallback right now
in `src/pages/post-a-review.astro`.

---

## Also worth your attention

**Service areas are Fairbanks, North Pole, Fox, and Ester**, with College and
Hamilton Acres correctly treated as neighbourhoods *inside* Fairbanks rather
than separate towns. The structured data models them that way — towns as
`City`, neighbourhoods as `Place` contained in Fairbanks.

**Fort Wainwright was removed 2026-08-12.** The post is military-owned and runs
its own contractors, so listing it advertised work you don't really do. Nothing
had to be redirected: no Fort Wainwright page or URL ever existed, on this site
or on the Marketing 360 site before it — the only location URLs are `fairbanks`,
`college`, and `hamilton-acres`. It lived solely in the service-area list, so
removing it there removed it from the nav, footer, homepage, and `areaServed`
markup at once. **No SEO was at stake.**

**The College and Hamilton Acres pages stayed live on purpose.** They're two
of the 36 URLs the site ranks for; deleting them throws that away. Each now
opens by stating it's a Fairbanks neighbourhood and links up to the Fairbanks
page. If you'd rather consolidate, say so and I'll 301 them into
`/general-contractor-in-fairbanks` — but keeping them costs nothing.

**They're still the weakest pages on the site**, though. All three location
pages run 359–431 words of near-identical copy with the place name swapped.
Google reads that pattern as doorway pages. Two honest options:

1. **Make them real** — name actual streets and subdivisions, reference real
   projects there, mention what's specific about building in that area. Then
   adding North Pole, Fox, and Ester pages is genuine upside, since nobody else
   has covered them well. North Pole especially: it's the largest of the three
   and has its own search volume.
2. **Consolidate** — fold all of them into one strong "Areas We Serve" page
   and 301 the rest to it.

Option 1 is more work and much better. Note the migrated copy still says
things like "in College, Alaska", which now reads wrong — that's on the
rewrite list either way.

**The blog stops in 2024.** Seven posts, all still useful. Restoration search
traffic is seasonal and Fairbanks-specific — frozen pipe bursts in
January, ice dams in spring, deck season in June. Two posts a season timed to
what's actually happening would compound.
