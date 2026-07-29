# Customer Material Selection — Design Brainstorm

**Status:** proposal, nothing built yet
**Date:** 2026-07-25
**Prototype:** [`docs/prototypes/material-selector.html`](prototypes/material-selector.html) — open it in a browser, it's clickable

---

## 1. The idea in one paragraph

The customer opens their existing portal link. There's a new card: **Your selections — 9 choices**. Every choice was generated automatically from the reconstruction estimate: we tore out laminate in the kitchen, so the kitchen needs flooring. Each choice offers exactly three things — *put back what was there* (recommended, insurance pays), *a different look at the same price* (still free), and *upgrade* (you pay the difference, shown as a real dollar number). There is a single button at the top that answers all nine at once: **Match everything we took out.** A customer who doesn't care is done in one tap. A customer who cares gets a 30-second, three-question setup that pre-picks everything, and they just review. Whatever they choose flows back as a signed change order with the correct credit-line math.

---

## 2. Why this is worth building

The research found something surprising: **the restoration industry has no homeowner-facing selection tool at all.** Not a weak one — none.

| Product | Homeowner picks materials? |
|---|---|
| Xactimate / ClaimXperience | No — evidence intake only |
| Symbility / Cotality | No homeowner surface at all |
| Encircle Link | No — read-only + e-sign |
| Contractor Connection | Contractor choice only |
| Matterport | No catalog |

The builder-market tools (Buildertrend, CoConstruct, Houzz Pro) do have selections, but they're gated into $830–1,100/mo tiers, and the module everyone agrees is best designed — CoConstruct's — **is being sunset**. The most common complaint about Buildertrend selections on Capterra and Reddit is that they're hard to use.

The structural reason nobody has built this for restoration is worth understanding, because it's also the reason we *can*: **Xactimate line items have no SKU, brand, or color field.** A line item encodes a category and a quality grade (`FCW` + average grade) and nothing else. There is literally nowhere in the estimate to put "the homeowner picked Sterling Oak." That's why the selection layer has to live in our own database, keyed to the line item — and that's exactly the shape our `price_list` + project-blob architecture already supports.

One more thing the industry has and hasn't connected: Contractor Connection runs a white-labeled Renoworks visualizer for lead-gen on one side of the house, and owns the claim workflow on the other, and **has never wired them together.**

---

## 3. The customer experience

The design principle is that **the fastest path through this screen should be one tap**, and everything else is optional depth. Restoration customers didn't sign up for a design project; they had a flood.

### The one-tap default

> ✓ **Match everything we took out**
> One tap. Nothing extra on your bill — insurance covers it all.

This is the most important element on the page. It is the honest default for insurance restoration (like kind and quality), it costs the customer nothing, and it lets someone who is overwhelmed be finished immediately. Every other pattern in the flow is a detour off this.

### The three doors, per selection

Each selection shows what we removed (with a job photo), then:

1. **Put back what was there** — marked *Recommended*, "Covered by insurance." One wide card.
2. **A different look, same price** — up to 4 equal-grade alternates. Still $0.
3. **Upgrade** — up to 3, each showing "+$722 on your bill."

Capping each tier at ~4 is deliberate. Bollen et al. (RecSys 2010) found a top-20 of all-good items is no more satisfying than a top-5 — the added attractiveness is cancelled by added difficulty. NN/g independently caps comparison at 5 items, 2 on mobile.

### The 30-second setup, not a wizard

Three questions, all about **needs**, not attributes:

1. Who lives with this floor? (kids and pets / just adults / it's a rental)
2. What feels like home? (warm and traditional / light and simple / keep it exactly as it was)
3. About the budget (stay with what insurance covers / a little extra where it counts / do it right)

Then it pre-picks all nine and says "here's what we'd pick — change anything." Randall, Terwiesch & Ulrich (*Marketing Science* 2007) found needs-based configurators produce measurably better outcomes for novices than parameter-based ones. Homeowners are novices.

This is deliberately **not** a step-by-step wizard. Landauer & Nachbar (CHI 1985): selection time grows logarithmically with items per screen but *linearly* with depth. And wizards block cross-step comparison, which selection is inherently about.

### Things the research says not to do

- **Don't build good/better/best on the decoy effect.** Yang & Lynn (*JMR* 2014) ran 91 replication attempts across 23 product classes and got 11 reliable effects — and attraction effects occurred *only at chance levels* when options were differentiated by pictures. Finish selection is inherently photo-differentiated. Mark one option "Recommended" instead; a dominant option genuinely does reduce overload.
- **Don't lead with a big photo grid.** Townsend & Kahn (*JCR* 2013): people *prefer* visual arrays but process them less systematically, producing more overload at scale. Every swatch needs a short verbal differentiator next to it.
- **Don't itemize toward a total.** Santana, Dallas & Morwitz (*Marketing Science* 2020) found drip pricing doesn't just annoy — it traps. Show one total, then itemize underneath. The prototype does this.
- **Never derive a paint color from a job-site photo.** Auto white balance is a destructive guess and camera ISPs apply nonlinear corrections that can't be undone downstream. If the original color is unknown, either take a physical reading with a colorimeter or let the customer pick fresh.

### Adoption is not a login problem

We already have no-login share-token URLs, which is the friction everyone else is still fighting. But the portal-adoption research is blunt about where the real barriers are (Turner et al., *JMIR* 2020, n=4,815):

| Barrier | Share |
|---|---|
| Prefers to talk to a person | 64% |
| No perceived need | 49% |
| Difficulty logging on | 19% |

The single strongest lever found anywhere: of people **encouraged by a human** to use the portal, 87% did; of those not encouraged, 57%. **A 30-point swing from a project manager simply saying "go make your picks in the portal."** That belongs in the workflow — probably an SMS from `roybal-notify` plus a scripted line for the PM — not in more features.

---

## 4. How the AI figures out *what* needs selecting

This was the core of the ask, and there's a better answer available than the obvious one.

**The obvious approach** is to read the demo notes and infer put-back. That's fragile here, because `demoNotes()` in [`apps/field/js/convert.js:156`](../apps/field/js/convert.js) is scraping free text out of moisture-map row notes and construction-log task fields. There is no structured demo record anywhere — no flood-cut height field, no per-room "flooring removed / doors pulled / base removed."

**The better approach** is to derive selections from the reconstruction estimate, which already solved this problem. The `roybal-ai-office` estimating engine already applies a PUT-BACK COMPLETENESS rule ("every tear-out / flood cut / removal in `facts.demoNotes` and `facts.affectedAreas` needs its FULL rebuild"), and it emits lines tagged `{room, desc, qty, unit, category, code, priceBasis}` with authoritative prices stamped from `price_list`. Those lines *are* the put-back list, already priced, already loaded, already the LKQ baseline.

So the pipeline is:

```
demo notes + moisture maps + photos
        ↓  (existing) invoiceDraft / reconEstimate
reconstruction estimate line items          ← already has room, qty, unit, code, loaded price
        ↓  NEW: selectionPlan
selection sheet                             ← filtered to customer-visible finishes, grouped by room
```

`selectionPlan` is a new action in the existing `ACTIONS` registry. It does two things:

1. **Deterministic spine.** Map estimate line items to selection types by category code. `FCW/FCC/FCV` → flooring. `CAB` → cabinets/vanity. `CNT` → countertops. `PNT` → paint color. `DRY` texture codes → texture. `FNC` base/case/door codes → trim and doors. `APP` → appliances. Anything not in the map is scope, not a selection — insulation and drywall don't get a choice.
2. **AI pass on top.** A `forcedTool` call that groups lines sensibly (all 186 LF of base across the house is *one* decision, not six), writes the plain-language "what we took out" description, and flags gaps — reusing the same instinct as the existing `invoiceAudit` "find missed items" action.

This is the CoConstruct **spec vs. selection** split, which was the single best structural idea in the competitive research and is being retired with the product. In restoration it maps perfectly: **LKQ-matched scope is locked spec; upgrade-eligible finishes are selections.**

### ⚠️ The blocker you need to know about

`price_list` today has **2,959 rows across ten categories**, and I verified which:

```
FRM 888 · WTR 610 · PNT 532 · FNC 483 · DRY 144
APP 100 · INS 94 · LAB 51 · ACT 38 · ACC 19
```

**There is no flooring (`FCW`/`FCC`/`FCV`), no cabinets (`CAB`), no countertops (`CNT`), no plumbing fixtures (`PLM`), and no lighting (`LIT`).** Those are precisely the categories a customer would be selecting — flooring, vanity, cabinets, countertops. Framing and water extraction are well covered; the finish trades a homeowner cares about mostly aren't.

> **CORRECTED 2026-07-25 — do NOT seed these from Xactimate.** An earlier draft of this doc called that the blocking first task. Two findings reversed it. First, the Verisk EULA prohibits it: §3.5(h) bars creating "an archive or database of the data received from the Services without our prior approval," §13.1 asserts ownership of all Price Data and bars copying it "in any form or format," and a new §3.6 (April 2026) specifically bans AI-assisted extraction and creates a delete-and-certify obligation. Second, and more usefully — **the selector doesn't need them.** Trace the arithmetic: the LKQ side comes from the carrier's own approved estimate, which we hold legitimately as a party to the claim and already transcribe via `estimateImport`; the upgrade side is our own supplier quote and our own margin, which Verisk has nothing to do with. So the finish categories are a blocker for *drafting reconstruction estimates*, not for the selector. See §5 for where that data actually comes from.

---

## 5. The product catalog — the honest answer on Home Depot and Lowe's

I researched this hard because it's the piece most likely to break the plan. **There is no legitimate way to get Home Depot or Lowe's local store inventory into the app.** Specifically:

| Path | Reality |
|---|---|
| Home Depot public API | **Doesn't exist.** `developer.homedepot.com` is DNS-dead. |
| Lowe's API portal | Exists (`portal.apim.lowes.com`) but is **invitation-only** and lists zero APIs anonymously. |
| Home Depot affiliate feed (Impact) | **Real** — daily product feed with SKU, price, image, `StockAvailability`. But: one national stock flag, **no store-level data**, requires a live public website, 1% commission on building materials, 24-hour cookie, and homedepot.com "ships a limited selection of products to Alaska." |
| Lowe's affiliate | Runs through **CreatorIQ** — an influencer program, not an affiliate network. **No product feed offered.** |
| Pro Xtra / Lowe's Pro | Rewards + purchase history. **No API.** Lowe's Pro does have QuickBooks export with job itemization. |
| Scraping either site | **Both terms of use prohibit it explicitly.** Lowe's bans "any robot, spider… to retrieve, index, data mine." Post-*hiQ*, this isn't a CFAA crime — but hiQ **lost the contract claim** and settled. It's a live cause of action. |
| Third-party (SerpApi, BigBox/Traject) | These *do* return Fairbanks store-level price and stock (`store_id`, `customer_zipcode`), from $23–275/mo. But they're unlicensed by the retailers, and buying through a reseller doesn't transfer the risk — we'd be the ones ingesting it. **Medium-high legal risk; your call, and worth an attorney's five minutes given our estimates go to carriers.** |

### The recommendation: a curated house catalog, and it's the better product anyway

Build a **`selection_catalog` table** in Supabase holding the products Roybal actually installs — maybe 8–15 per selection type, with photos, the local store, the loaded price, and a "verified [date]" stamp. Refresh it monthly, by hand or by an office-side job.

This sounds like the compromise. It isn't:

- Every UX finding above says **curate to ≤5 per tier**. A live search across 40,000 SKUs is the thing that makes these tools feel awful.
- **Catalog depth is the hard part, not UI.** Hover's worst-reviewed weakness is "limited color and material availability" — on *exteriors*, with 30 manufacturers. Roomvo needed 6,000 brands to cover interiors. We are not going to win by having more SKUs; we win by having the right fifteen.
- The customer doesn't need live stock. They need to know *we can get it*. A **"In stock · Home Depot Fairbanks · checked Jul 24"** stamp is honest and cheap. Pretending to be real-time is a promise we'd break the first time the Fairbanks store was out.
- Zero legal risk, zero API cost, works offline, and it captures Roybal's actual judgment about what holds up in Interior Alaska — which is worth more to the customer than a search box.

If you later want automated price/stock refresh, the clean move is a cron job hitting a third-party API to update *catalog rows we already curated* — a few hundred calls a month on the $23 tier — rather than live customer-facing search. Still a ToS question; still your decision.

**One thing to avoid regardless:** don't build a multi-supplier price-comparison screen. ABC Supply's API terms explicitly prohibit "direct price comparison tools across competitors or markets," and QXO's likely do too. If we ever wire in distributor APIs, single-supplier estimating is the sanctioned use.

---

## 6. Paint colors — the one place we get everything free

Verified live today, 2026-07-25:

```
GET https://prism-api.sherwin-williams.com/v1/colors/sherwin?lng=en-US&_corev=2.0.5
→ 200, 1,424,505 bytes, Access-Control-Allow-Origin: *, no API key
```

1,948 current Sherwin-Williams colors with name, code, hex, RGB, **LAB**, **LRV**, color family, coordinating colors, and `storeStripLocator` — the physical fan-deck rack position, so the customer can go touch the real chip in the store. The same host also serves `dutchboy` (with LRV), `valspar`, `hgtv`, and `minwax` — and Valspar and HGTV Home are the Lowe's brands.

Cache it in Supabase server-side, refresh weekly on cron. Don't call it from the customer's browser on every page load, and don't republish it as a dataset.

### Matching an existing color — solved, because we own the hardware

Roybal has a **Sherwin-Williams ColorSnap Match Pro**, which is OEM'd from Variable Technologies and publishes <0.05 ΔE00 short-term repeatability and <0.2 ΔE00 inter-instrument agreement. That closes the one gap a software-only design can't: reading the color of a wall that nobody has the paint code for.

This should be a first-class step in the field workflow, not an afterthought:

1. Before demo, the tech takes a Match Pro reading from an **undamaged** section of each painted surface — ideally behind a switch plate or inside a closet, where the paint hasn't been sun-faded.
2. The reading resolves to an SW color number, which we store on the room record and match against our cached Prism API rows to get name, hex, LRV, and fan-deck locator.
3. The portal then shows the customer *"Your kitchen was SW 7029 Agreeable Gray — we'll put that back"* instead of a guess, and the "different color, same cost" tier can be generated from that color's own `coordinatingColors` and `similarColors` fields, which the API already returns.

Two caveats worth encoding in the UI. The device reads color but **not sheen**, so eggshell-vs-satin still has to be captured by the tech as a separate field. And SW's own FAQ concedes the screen can't faithfully represent the scanned surface — so the portal should present a matched color as *a color number to trust*, with the on-screen swatch labelled as an approximation, and lean on the fan-deck strip locator for anyone who wants to see the real chip.

Because we can now source the original color reliably, the honest default on paint shifts from "pick something" to **"put back exactly what you had"** — which is the same one-tap default as every other selection, and it's now defensible rather than approximate.

**Legal posture** (researched separately, and it's reassuring): paint color *names* are categorically uncopyrightable under 37 C.F.R. § 202.1(a). Across GitHub's entire public DMCA corpus there is **not one takedown by any paint manufacturer over color data, ever** — versus two from Pantone. Sherwin-Williams publishes the whole set as free Excel/PDF/`.ase` downloads on their contractor page with no license terms. The residual risks are (a) their site ToU, and (b) implied endorsement — so use **text-only brand references, no logos, no brand color in our chrome**, plus a line saying color names are trademarks of their manufacturers and we're not affiliated. Behr has no free source with LRV; Behr codes are available from the `colornerd` dataset but it's been frozen since 2019.

---

## 7. The money — and one word we must never use

### The arithmetic

An upgrade delta is **the net of two complete loaded line items**, not two material prices:

```
delta = (upgrade.loaded − lkq.loaded) × qty × (1 + O&P)
```

This is the Xactimate credit-line method: you flip the original line to a Credit Line, add the upgrade at the same quantity, and the difference is what the customer owes. It matters enormously — a carpet→tile swap changes the *labor* dramatically, and quoting upgrades material-only is a well-known way to eat the difference on tile and cabinets.

Our `price_list` already stores `replace_price` / `remove_price` / `detach_reset_price` as loaded assembly prices, so **the correct math is natively supported.** That's a real advantage.

Two gotchas to encode:
- **Waste asymmetry.** Per Xactware, `FCC` (carpet) and `FCV` (sheet vinyl) do **not** include waste in unit pricing — you add it manually; most other categories bake it in. A carpet→LVP upgrade changes waste treatment between the credit line and the new line.
- **No sales tax in Fairbanks**, so tax is zero here — but don't hardcode that, hardcode the rate as 0 with a field.

### The word "betterment" is a trap — especially in Alaska

In property-insurance regulatory language, betterment means the *opposite* of what contractors usually mean. NAIC Model Regulation MDL-902 § 9(A)(1) — **adopted verbatim by Alaska at 3 AAC 26.090(l)(2)** — says:

> "the claimant is not required to pay for betterment or any other cost except for the applicable deductible."

So a form saying "customer is responsible for betterment" asserts the opposite of Alaska's own regulation. Use these three terms, and never interchangeably:

| Term | Trigger | Who pays | Vehicle |
|---|---|---|---|
| **Betterment** (technical) | Unavoidable new-for-old | Insurer | nothing — inherent in RCV |
| **Customer-selected upgrade** | Homeowner chooses above LKQ | Homeowner | signed change order, net of credit line |
| **Code upgrade** | Law requires it | Insurer, if Ordinance & Law coverage exists | supplement, not change order |

The product copy should say **"upgrade"** everywhere. The prototype does.

Also: **don't submit an upgrade as a supplement** — it gets denied and we hold it. Supplements are insurance-related scope; change orders are customer-discretionary.

### Timing

Collect the upgrade delta **when we place the material order**, not at completion — that's the documented way contractors end up absorbing it. And it can't come from mortgage escrow, because escrow is tied to the insurance scope. The prototype says both out loud on the summary screen, which is also the fairness play: Kahneman, Knetsch & Thaler's dual-entitlement work found a ~55-point swing in perceived fairness on identical dollar amounts based purely on whether the charge reads as a pass-through cost or as pricing the customer's emergency. A restoration customer is standing in the snowstorm. Itemized pass-through framing is not decoration.

One more, from the returns literature: **an explicit "you can change this until August 15" increases commitment more than it increases changes** (Janakiraman et al., *Journal of Retailing* 2016 meta-analysis).

---

## 8. Where this goes in the code

Everything slots into existing patterns; there's no new architecture.

**Database**
- `111_price_list_finishes.sql` — seed `FCW`/`FCC`/`FCV`, `CAB`, `CNT`, `PLM`, `LIT` from the Fairbanks list. **Blocking prerequisite.**
- `112_selection_catalog.sql` — the curated products: `id, selection_type, tier (lkq|same|upgrade), name, brand, retailer, store, sku, image_path, loaded_price, unit, price_list_code, stock_note, verified_at, active`.
- `113_paint_colors.sql` — cached Sherwin-Williams/Valspar/HGTV rows.
- `114_portal_selections.sql` — the per-job sheet: one row per selection with `portal_job_id, room, title, line_code, qty, unit, lkq_option_id, chosen_option_id, delta_cents, chosen_at, signed_at`.

**Customer side** — [`apps/portal/js/portal.js`](../apps/portal/js/portal.js) renders one page via `app.replaceChildren(...)`, so this is **a fifth card, no routing work.** [`supabase/functions/roybal-portal/index.ts`](../supabase/functions/roybal-portal/index.ts) gets three new actions on the existing `serve()` switch — `selections`, `choose`, `signSelections` — reusing `jobByToken()` and the `enabled=eq.true` revocation switch exactly as-is.

**AI** — a `selectionPlan` action in [`roybal-ai-office/index.ts`](../supabase/functions/roybal-ai-office/index.ts)'s `ACTIONS` registry, using `forcedTool()` and inheriting the whole `capture_events` → spend-cap → `ai_usage` envelope for free. The customer-facing "help me choose" should be a **single structured `forcedTool` call, not a chat loop** — bounded cost, no hallucination surface, and the portal already has `CONCIERGE_DAILY_MAX` and flood guards for the free-text asks.

**Office side** — `publishSelections()` in [`apps/field/js/portal.js`](../apps/field/js/portal.js) mirroring `publishPortal()`; a review panel in `forms.js` next to the existing Client Portal panel; a `selectionNudge` chip in `personas.ts` so the assistant can text a customer who hasn't picked. Signing reuses `signaturePad()` from `core.js`. The change order lands in `project.changeOrders`, which already exists.

---

## 9. Suggested build order

1. **Add a stable `id` to `blankLineItem()`** (`apps/field/js/model.js:352`). It currently returns `{room,desc,qty,unit,price}` with no identity, and `forms.js:1306` splices mid-array, so indexes shift. Any selection row keyed to a line item by index will silently de-sync. Small change, hard prerequisite, and it has to land before anything references a line.
2. **Selection catalog + admin CRUD, on an own-cost basis.** Hand-curate ~15 products for flooring, cabinets, countertops, vanity, trim, doors, priced from supplier quotes and your own purchase history — not from Xactimate. This is the real work and it's mostly your judgment, not code. Keep Xactimate `CAT`/`SEL` codes as interoperability keys so we can talk to carrier estimates, but write our own descriptions.
3. **Paint color cache** from the Sherwin-Williams API. Half a day, free, and it's the most visually impressive part.
4. **`selectionPlan`** — estimate lines → selection sheet, deterministic mapping first, AI grouping second.
5. **Portal card** — the three doors, the one-tap default, the sticky total.
6. **Change order + e-sign**, with credit-line math and the waste rule.
7. **The 30-second setup quiz.**
8. **Nudges** — SMS when the sheet is published, PM script for the "go make your picks" ask.

Steps 1–3 are independently useful even if the rest slips: seeded finish categories improve every estimate the AI writes, and the color cache is reusable anywhere.

---

## 10. Open decisions for you

1. **Third-party product data — in or out?** Curated catalog is my recommendation and is genuinely the better product. Live Fairbanks pricing via SerpApi/BigBox is available for $23–275/mo but breaches both retailers' ToU. Worth an attorney's opinion before we touch it, given our estimates go to carriers.
2. **Do we show the customer the insurance allowance?** The prototype does ("your claim allowed $6.42/SF"). It's the strongest fairness move available and makes the upgrade delta self-evident — but it exposes our loaded unit prices. Houzz Pro makes this per-field toggleable, which is probably the right long-term answer.
3. **Physical samples.** Floor & Decor's $3-per-sample-credited-back model is the best-validated digital-to-physical bridge in this category, and Benjamin Moore now resells Samplize peel-and-stick rather than fight it. Worth considering — "we'll drop off the top two" is a very Roybal move and the prototype already offers it in the ask flow.
4. ~~Do we need a paint colorimeter?~~ **Resolved — Roybal already owns a ColorSnap Match Pro.** The open question is now a workflow one: does taking a pre-demo reading from every painted room become a standard step on the field checklist? It should, and it's cheap — but it only works if it happens *before* demo, so it belongs in the same checklist as the pre-demo photos.

---

## 11. Sources worth keeping

- Alaska matching regulation: 3 AAC 26.090(l) — Alaska is one of ~15 states with one
- Xactimate change-order credit-line method: [growmyrestorationbusiness.com](https://growmyrestorationbusiness.com/how-to-create-change-orders-in-xactimate-the-right-way/)
- Waste rule: [Xactware — calculating square feet of waste](https://xactware.helpdocs.io/l/enUS/article/Vtkqga2oxE-calculate-the-square-feet-of-waste)
- ITEL material matching (the carrier-side equivalent, incl. a homeowner-facing report): [Nearmap](https://www.nearmap.com/products/itel-analysis/material-matching)
- Choice overload, properly stated: Chernev, Böckenholt & Goodman, *JCP* 2015 — four moderators, all significant; finish selection scores high on all four
- Decoy effect failure for visual products: Yang & Lynn, *JMR* 2014
- Portal adoption barriers: Turner et al., *JMIR* 2020; ASTP/ONC Data Brief 77, July 2025
- Fairness framing: Kahneman, Knetsch & Thaler, *AER* 1986
