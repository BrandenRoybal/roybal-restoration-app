# Selling the Software: A $10,000 Plan

**Prepared for:** Branden Roybal — Roybal Construction, LLC
**Date:** September 7, 2026
**Horizon:** 90 days (Sept 7 – Dec 6, 2026)
**Premise:** Turn the field ops stack you already built into a product other restoration
contractors pay for.

---

## 1. The one-paragraph version

You are an owner-operator who got priced out of restoration software and built your own. So
did 60,000 other shops — except they didn't build it. The market leaders (DASH, PSA, Albi,
Xcelerate, Restoration Manager) are aimed at 5–50 truck enterprises and, in the words of the
category's own reviewers, sit "at a price that prices out most owner-operator shops." Those
shops instead run a three- or four-tool stack: a CRM, Encircle for field docs, a Xactimate
seat, and QuickBooks behind it. **You built the thing that collapses the middle of that stack,
and you built it as the customer.** That is the most credible founder story this market has.

**But you cannot sell it as a multi-tenant SaaS in 90 days**, and the reason is in your own
architecture review dated two days ago. The plan below is the version that actually ships:
**single-tenant managed deployments**, one isolated stack per customer, sold with a setup fee
so it produces cash inside the horizon.

---

## 2. The blocker, stated plainly

Your architecture review (`docs/architecture/01-ARCHITECTURE-REVIEW.md`, 2026-09-05) grades the
system **D+** and lists, as Critical:

| Finding | Why it blocks multi-tenant SaaS |
|---|---|
| "Any signed-in user… can read and rewrite about eighteen tables" (`using(true)` policies) | Customer B reads Customer A's claims |
| No `org_id` anywhere; open question A3 proposes adding it "as tables are created" | Nothing in the schema knows what a tenant *is* |
| "The org model cannot hold a second office hire" | It cannot hold a second *company* by a wide margin |
| Publishable key reaches ungated proxy actions that create QuickBooks invoices, dump timesheets, disconnect OAuth | An open production exposure, today |
| Gmail sync dead since 09-01, QuickBooks Time since 09-04, cron reports success | You would not know a customer's integration died |
| "main fails its own test suite while deployed" | Confirmed — the field sync suite is a coin flip on `main` |

The data involved is homeowner PII, photographs of people's houses, and insurance claim
numbers. Putting a second contractor's claims into that database on today's policies is not a
technical shortcut, it is a breach waiting to be discovered — and it would end the venture and
reach past the LLC to you.

**The fix is not the backbone rebuild.** That is months and it is not what $10,000 buys.

**The fix is to make the tenant boundary a deployment boundary.** One Supabase project, one
deploy, one Twilio number per customer. `using(true)` stops mattering when there is exactly one
org in the database. Missing `org_id` stops mattering for the same reason. You trade row-level
isolation you don't have for project-level isolation you get for free.

It costs more to operate per customer, so you price for it. It breaks somewhere north of 30–50
tenants — by which point you have revenue to fund the backbone the review already scoped.

---

## 3. What you are actually selling

Not "a platform." The review is right that the whole is a collection of features. Sell the two
islands it calls real engineering, plus the thing no competitor can copy:

**The offline field documentation and carrier packet system for water mitigation — built by a
working GC.**

| What | Why it wins |
|---|---|
| **Works with no signal** | Offline-first sync engine, content-addressed media, survived four data-loss incidents. Reviewers report competitors show "slowness or mobile friction during photo-heavy field work." Crawlspaces and rural jobs have no bars. |
| **Moisture mapping against IICRC S500** | Material-specific dry standards, wet → monitoring → dry status, drying trend graphs |
| **Drying logs with equipment-day tracking** | Including the 7-day equipment flag — the line adjusters trim first |
| **22 carrier-facing forms** | "Print rules learned from adjuster pushback." This is the moat. It is not a feature list, it is scar tissue. |
| **The packet** | Photo report, contents inventory with ACV/depreciation, moisture logs, certificate of drying — assembled, print-ready, in the order an adjuster expects |
| **After-hours AI phone intake** | Books the 2 a.m. emergency call. Owner-operators lose these constantly. |

### What NOT to sell yet

Leave out the job board scheduling, the QuickBooks sync, and campaigns. Per-tenant QuickBooks
OAuth is a real project, the Gmail lane is currently dead, and these are exactly where the org
model and integration gaps bite hardest. **Sell the field + packet wedge. Add office modules
when the backbone exists.** A narrow product that works beats a broad one that leaks.

### Name

`DryPacket` — says what it does. Alternates: `Fieldstone`, `Sixty Below`. Your call; don't spend
a week on it.

---

## 4. Who buys it

**Owner-operator to 5-truck restoration shops in cold, remote markets.**

- **Not Interior Alaska.** Do not arm your competitors. Geographic exclusivity inside FNSB is a
  selling point elsewhere, not a market to serve.
- **Yes:** Anchorage / Mat-Su, and cold-climate Lower 48 — Montana, the Dakotas, northern
  Minnesota, Wisconsin, Maine, Vermont, upstate New York.
- **Why that segment:** freeze/thaw losses, remote drive times, and poor cell coverage are
  exactly what offline-first solves and what generic tools handle badly. You can also speak the
  customer's language on the first call, because it is your language.

**Market context:** 60,020 US damage restoration businesses, a $7.1B industry growing ~4.3%
a year. You need five of them. This is not a TAM problem, it is a first-ten-customers problem.

---

## 5. Pricing

Public benchmarks, where they exist:

| Product | Price | A 6-person shop pays |
|---|---|---|
| Albi | $6,000/yr minimum; $60/user/mo base, $100/user/mo pro | ~$10,200/yr |
| DASH (Cotality/CoreLogic) | ~$595/mo reported | ~$7,140/yr |
| Encircle | Quote only; complaints cite monthly cost | — |
| **DryPacket** | **$2,500 setup + $450/mo** (≤5 field users) | **$7,900 yr 1, $5,400 after** |

- **Setup / implementation: $2,500 one-time, paid before provisioning.** Covers the dedicated
  stack, data migration, phone number, and two training sessions. This is what makes the venture
  produce cash inside 90 days instead of month 14.
- **Subscription: $450/mo** up to 5 field users; **$650/mo** up to 12.
- **Annual prepay: 2 months free.** Take the cash.

Do not discount below $350/mo. Single-tenant ops cost is real, and a customer who won't pay
$450/mo for the thing that gets their claims paid will not do the work to use it either.

---

## 6. Where the $10,000 goes

| # | Bucket | Amount | Gate |
|---|---|---:|---|
| 1 | Security remediation + provisioning script | **$3,000** | Blocks customer #1 |
| 2 | Legal, entity, insurance | **$2,000** | Blocks customer #1 |
| 3 | Design partner acquisition | **$2,000** | — |
| 4 | Brand, landing page, demo | **$1,500** | — |
| 5 | Reserve | **$1,500** | — |
| | **Total** | **$10,000** | |

### 1 · Security remediation + provisioning — $3,000

Contract backend help, roughly 25–30 hours. You are not hands-on for this. Narrow scope — this
is hardening plus a script, **not** the backbone rebuild:

1. Close the two open production exposures (gate the proxy actions on a real caller; make the
   ledgers insert-only). Your review's own "week one, regardless of anything else" list.
2. Fix CI so `main` is green — the flaky sync assertion is a real data-loss bug, diagnosed in
   PR #183. You cannot ship software to paying customers off a red main.
3. Build `provision.sh`: new Supabase project → migrations → seed → deploy field/admin/portal to
   a per-tenant origin → Twilio number → smoke test. **It must run twice in a row, clean.**
4. Add refresh-failure alerting so a dead integration pages you instead of reporting green.

### 2 · Legal, entity, insurance — $2,000

The bucket you will want to skip. Do not.

1. **A separate LLC.** Do not sell software from Roybal Construction, LLC. Commingling puts your
   trucks, equipment, and construction receivables behind a software bug.
2. **Terms of Service with a real limitation-of-liability clause**, capped at fees paid.
3. **A Data Processing Agreement + privacy policy.** You will be a processor of *their*
   customers' PII. Carriers and larger customers will ask.
4. **Tech E&O / cyber liability insurance.** If your software loses a contractor's moisture logs
   and their $60K claim gets denied, they will come after someone. Uninsured, that is you.

### 3 · Design partner acquisition — $2,000

Five paying pilots. Not free pilots — paying ones, or the feedback is worthless.

- One regional restoration event or IICRC course where your customers already are (~$900
  travel/registration).
- A seeded demo environment with a realistic Cat 3 loss — moisture logs, photos, a finished
  packet. Sell the packet, not the screens.
- Direct outreach: you are IICRC WRT and a working GC. Peer-to-peer beats any ad in this trade.

### 4 · Brand, landing page, demo — $1,500

You already have an Astro marketing site and a design system. Extend, don't restart. One page,
one 4-minute demo video: *phone with no signal → moisture readings → adjuster packet.* That
video is the entire sales pitch.

### 5 · Reserve — $1,500

First-customer support surprises and per-tenant infrastructure overage.

---

## 7. The 90-day sequence

**Weeks 1–4 — the gate.** Nothing customer-facing ships until these are done.
- [ ] Close the two production exposures
- [ ] Green CI on `main`
- [ ] `provision.sh` runs clean twice
- [ ] LLC formed, ToS + DPA drafted, E&O quoted and bound
- [ ] Demo environment seeded with a realistic loss

**Weeks 5–8 — first blood.**
- [ ] Landing page + demo video live
- [ ] 30 targeted outreach conversations; book 10 demos
- [ ] **Close 2 design partners at $2,500 setup + $450/mo**
- [ ] Provision both. Time it. If onboarding takes more than 6 hours, fix that before selling more.

**Weeks 9–13 — prove it repeats.**
- [ ] Close 3 more (5 total)
- [ ] First renewal conversations; ask every partner the only question that matters: *did this
      get a claim paid faster?*
- [ ] Write down what broke. That list is your backbone spec.

---

## 8. What 90 days actually produces

| Line | Amount |
|---|---:|
| 5 × $2,500 setup fees | $12,500 |
| MRR exiting day 90 (5 × $450) | $2,250/mo |
| Subscription collected within the window | ~$4,500 |
| **Cash in, 90 days** | **~$17,000** |
| Less the $10,000 deployed | **≈ +$7,000** |
| **Annualized run rate created** | **$27,000 ARR** |

**Be honest with yourself about this number.** As a 90-day cash play it is roughly break-even.
Software does not pay fast; that is not what it is for. What the 90 days buys is a *proven,
repeatable* $27K ARR with ~90% gross margin and near-zero marginal cost per additional customer
— an asset that compounds while you sleep, which is the opposite of every dollar you currently
earn. Twenty customers is $108K ARR. Fifty is $270K and a real company.

If maximum cash in 90 days were the only goal, this is the wrong option. You chose it because
the ceiling is somewhere no amount of drying equipment reaches.

---

## 9. Risks, ranked

1. **Your time.** You run a GC business with 7+ employees. Founder attention is the binding
   constraint, not the $10,000. If you cannot give this ~10 hours a week, it will not happen —
   and the honest move is to say so now rather than spend the money.
2. **Support burden.** Single-tenant means N deployments to babysit. When a crew cannot document
   a loss at 11 p.m., they call *you*. Cap the pilot at five customers until you know that cost.
3. **Architecture debt compounds.** Every customer onboarded before the backbone exists is
   another migration later. Five is fine. Twenty on this shape is a trap.
4. **Selling to competitors.** Geographic exclusivity inside FNSB, in writing, from day one.
5. **Slow sales cycles.** Trades software sells on relationships and conferences, not ads.
   Budget patience, not just money.
6. **Support is not a product.** If every customer needs you personally, you have bought
   yourself a second job. The onboarding-hours metric in Week 8 is the early warning.

---

## 10. Assumptions and exclusions

**Assumptions**
- Architecture findings are quoted from your own review at `main@1e04694`, dated 2026-09-05.
- Competitor pricing is from public sources; most of this category quotes privately, so treat
  Albi and DASH as anchors, not a full picture.
- $450/mo assumes single-tenant infrastructure well under $60/mo per customer. Measure this on
  pilot #1 before selling #6.
- 5 pilots in 90 days assumes ~10 booked demos at a ~50% close rate on a peer-to-peer sale.
  Reforecast after the first ten conversations.

**Exclusions**
- The backbone rebuild scoped in `docs/architecture/03-TARGET-ARCHITECTURE-AND-ROADMAP.md` is
  not funded here and is not needed to sell five single-tenant deployments.
- No multi-tenant migration path is designed in this document. It is a real project and belongs
  after pilot revenue exists.
- Xactimate integration, per-tenant QuickBooks OAuth, and Gmail sync are out of scope.
- Trademark search and registration for the product name is not budgeted.

---

*Roybal Construction, LLC · Fairbanks, Alaska · IICRC Water Restoration Technician certified*
