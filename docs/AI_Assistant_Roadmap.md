# Roybal AI Assistant — Voice & Text Roadmap

*The path from today's app to a fully AI-integrated virtual assistant that helps
run the office: answers the phone, schedules work, keeps customers informed,
nudges the crew, and briefs the owner. Living document — updated as phases ship.*

**Last updated:** July 11, 2026

---

## Ground rules (apply to every phase)

- **Human-in-the-loop tiers.** Every automated message type starts at
  *compose → review → tap send*, earns its way to *auto-send with a log*, and
  only the routine stuff (reminders, confirmations) ever goes fully automatic.
  The office can demote any message type back to review-first at any time.
- **Everything is logged.** Every text, call transcript, and AI action lands on
  the job (Message log + `sms_messages` table) — it's claim documentation, not
  just plumbing.
- **Spend caps everywhere.** Texting has `SMS_MONTHLY_CAP`; AI rides the
  existing monthly cap + `ai_usage` ledger; voice minutes get their own cap.
  Nothing can run away with the account.
- **Compliance built in.** Customers opt in via the Work Authorization; STOP
  always works (Twilio enforces it); quiet hours (no automated customer texts
  before 8am / after 8pm) baked into the scheduler.
- **Rides the job spine.** Every channel (SMS, voice, email) keys to
  `unified_jobs`, so the field app, Job Board, and assistant all see the same
  conversation history.

---

## Phase 0 — Foundation (SHIPPED ✅)

What already exists and what everything else builds on:

- **Ask the Office** in-app assistant: chat + hands-free voice (Deepgram STT +
  Aura TTS), job-aware via the facts digests, cites IICRC + building codes
- **Facts digests** (`narrativeFacts` / `constructionFacts`): the compact,
  current picture of every job — including plan dimensions, labor,
  notifications, crew field reports
- **SMS links (Path 1)**: Field Report → office, "on our way" → customer,
  sent from the tech's phone; **Message log** on every job
- **`roybal-notify` edge function** (built, awaiting Twilio): company-number
  sends with JWT-gated logging + monthly cap
- **Job Board**: schedule engine (Gantt, crew, work calendar), field↔board
  bridge, QuickBooks Time hours

**Gate to everything below:** Twilio compliance profile approval → buy the
toll-free number (Voice + SMS + MMS) → toll-free SMS verification.

---

## Phase 1 — Company-number texting goes live (S)

*Gate: Twilio number + toll-free verification. Effort: small — the function
is already written.*

- [ ] Run migration 106, set `TWILIO_FROM`, deploy `roybal-notify`
- [ ] App buttons send through the company number (SMS links stay as the
      offline/unverified fallback)
- [ ] Field Report photos attached as **MMS**
- [ ] **Delivery statuses** via Twilio status webhook → `sms_messages` →
      Message log shows *delivered*, not just *composed*
- [ ] **Inbound replies** webhook → logged to the job; office sees customer
      responses in the Message log
- [ ] **Template library**: office-editable message templates (on our way /
      running late / done for today / equipment pickup / walkthrough ready)
- [ ] Job Board texting: text customer from the job tile, per-crew
      "text today's assignment" from the roster

## Phase 2 — Automated notifications (M)

*No-tap sends, driven by schedules and the watchers that already exist.*

- [ ] **Scheduled sends**: appointment reminders the evening before;
      equipment-pickup notices when drying certifies; draw-invoice notices;
      review request at closeout
- [ ] **Trigger-driven alerts** (reuse Drying Watch / Build Watch): drying
      stalled → text the office; failed inspection or overdue selection →
      text the coordinator; board schedule change → text affected crew
- [ ] **Notification preferences** per job (some customers want everything,
      some want nothing) + quiet hours + per-type auto/review setting
- [ ] Message log filters: outbound vs inbound vs automated

## Phase 3 — Virtual receptionist v1 (M/L)

*The phone answers itself. Gate: Fly.io account (~$5/mo always-on host).*

- [ ] **Fluid conversation** via Twilio ConversationRelay (streaming STT/TTS,
      barge-in) → our agent loop on Fly.io → Claude with the office persona
- [ ] **New-loss intake**: gathers caller, address, phone, what happened, how
      bad → creates a **Job Board lead** → texts the owner a summary →
      confirmation text to the caller
- [ ] **Emergency escalation**: active water loss → live transfer to the
      owner's cell + urgent text
- [ ] **FAQ pack**: hours, service area, insurance process, licensing —
      answered naturally
- [ ] **Call logging**: every call transcribed onto the job / a leads log
- [ ] Routing choice: 24/7 line, or no-answer forwarding from the office
      number (gentle rollout — AI only takes calls that would have been missed)

## Phase 4 — Scheduling brain (L)

*The receptionist stops taking messages and starts booking work.*

- [ ] **Appointments on the Job Board**: inspections, estimates, walkthroughs
      as first-class calendar items (visible on the board's calendar/Gantt)
- [ ] Receptionist **reads real availability** (crew calendar, work days,
      existing jobs) and proposes slots: "Tuesday at 9 or Thursday at 1?"
- [ ] **Books it** → board appointment + confirmation text + reminder text
      the evening before
- [ ] **Reschedule/cancel by text or call** — two-way: "REPLY 1 to confirm,
      2 to reschedule"
- [ ] Owner override: every AI booking shows on the board flagged "AI-booked"
      until acknowledged

## Phase 5 — The proactive office agent (L)

*Stops waiting to be asked. This is "help run the office."*

- [ ] **Morning briefing** to the owner (text, or a voice call that talks
      through it): today's schedule, who's where, stalled jobs, unbilled
      hours, pending selections, overdue draws, yesterday's field-report
      issues
- [ ] **Crew outreach**: assignment reminders, "no Field Report filed
      yesterday" nudges, timesheet-missing nudges before payroll
- [ ] **Customer journey automation**: milestone-driven updates (demo
      complete → drying certified → rebuild started → walkthrough scheduled),
      each type individually set to auto or review-first
- [ ] **Collections assistant**: unpaid draw/invoice → polite reminder
      sequence with escalation to the owner
- [ ] **Review & referral engine**: closeout + happy walkthrough → review
      request with the Google link; tracks who was asked

## Phase 6 — Deep integrations (ongoing)

- [ ] **QuickBooks Online**: invoice-sent and payment-received triggers;
      payment links delivered by text (Intuit app setup is the gate)
- [ ] **Email lane**: the adjuster-email drafting that exists today becomes a
      send-and-track lane; inbound email parsed onto the job
- [ ] **Owner calendar sync** (Google/Apple) so the scheduling brain sees
      personal commitments
- [ ] **Weather triggers** (Fairbanks freeze/thaw events): surge-prep
      checklist + outreach campaigns to past customers
- [ ] **Outbound voice**: reminder calls with "press 1 to confirm" — last,
      because outbound AI calls need the most care to not irritate
- [ ] **Unified inbox on the Job Board**: one conversation thread per
      customer across SMS, calls, and email

---

## What each gate needs from the owner

| Gate | Unlocks | Status |
|---|---|---|
| Twilio compliance approval → buy toll-free | Phases 1–2 texting | In review |
| Toll-free SMS verification | Customer-facing texts deliver | Submit after purchase |
| `supabase secrets set TWILIO_*` + deploy | Phase 1 go-live | 2 commands |
| Fly.io account (~$5/mo) | Phases 3–4 voice | Not started |
| Intuit developer app (QBO) | Phase 6 payments | Migration done, app pending |

## Cost picture (steady state, rough)

- Toll-free number ~$2/mo · texts ~1¢ · photo texts ~2¢
- Voice ~10–15¢ per call-minute all-in (a 5-min intake ≈ 60¢)
- Fly.io host ~$5/mo · AI usage rides the existing monthly cap
- Realistic total at current volume: **tens of dollars a month** — priced like
  one hour of admin time, working every hour of the month
