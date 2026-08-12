# Runbook: the local number, AT&T forwarding, and the AI receptionist

**Changed:** 2026-08-12 · **Owner:** Branden · **Blast radius:** every inbound call to the business

The published number **(907) 371-9868** is Branden's AT&T cell. It was never a
Twilio number and is not being ported — porting it would give the handset a new
number (bank, 2FA, every contact). Instead, AT&T's *conditional* call
forwarding — the same mechanism that used to deliver unanswered calls to AT&T
voicemail — now delivers them to Twilio, where the AI receptionist answers.

```
caller → (907) 371-9868  ── AT&T rings the handset ~20s ──┐
                                                          │ answered → humans talk
                          ── no answer / busy / no service┘
                             └→ AT&T forwards to (866) 345-2290 (Twilio)
                                └→ roybal-voice → AI receptionist
                                   └→ capped / down → voicemail (never a dead end)
```

**The 866 is no longer a number anyone dials.** It is (a) the forwarding target
and (b) `TWILIO_FROM`, the sender for every outbound text — crew, customers,
lead alerts, morning brief, approve-by-text. It is toll-free verified for SMS.
**Do not release it.** ~$2/mo.

---

## What was changed

### 1. AT&T — conditional call forwarding (done 2026-08-12)

Dialled from the cell itself:

```
*61*18663452290#
```

Sets *forward on no answer*. Confirmed with `*#61#`.

Consider also setting the busy and unreachable conditions, so a call that
arrives while Branden is already on the phone — or in a dead zone out at a
job — reaches the receptionist too, instead of dying:

```
*67*18663452290#     forward on busy
*62*18663452290#     forward when unreachable / no service
```

> **iPhone note:** Settings → Phone → Call Forwarding does **unconditional**
> forwarding only. That would send *every* call straight to the AI and the
> handset would never ring. Conditional forwarding must be the star codes.

### 2. Twilio — voice webhook on the 866

Phone Numbers → +1 866 345-2290 → Voice Configuration → "A call comes in" =
Webhook, HTTP **POST**:

```
https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-voice
```

Messaging config is untouched — the SMS lane lives there.

### 3. `roybal-voice` — skip the redundant second ring

Before this change the function dialled `OWNER_CELL` for 15s on *every*
inbound call. On a forwarded call that means the caller waits out AT&T's ~20s
timer and then listens to Twilio ring the same handset that just went
unanswered: **~35–40s before the AI says hello.** Most callers hang up first.

Two new optional secrets on the `roybal-voice` function:

| Secret | Value | Effect |
|---|---|---|
| `FORWARD_ONLY_TO` | `+18663452290` | Calls arriving on this number skip the owner dial and go straight to the receptionist |
| `ESCALATE_TIMEOUT` | `15` (default) | Replaces a hardcoded 25s — see the loop warning below |

With `FORWARD_ONLY_TO` set, the caller hears the AI **~1–2s after AT&T hands
the call over**, exactly like voicemail used to pick up.

The function also skips the dial whenever Twilio sends a `ForwardedFrom`
parameter, which covers any future carrier that sets it. Both signals are
checked because neither is reliable alone: `To` is always present but only
meaningful for a dedicated forwarding target, and `ForwardedFrom` is general
but plenty of carriers strip it.

> ### ⚠️ Both dial timeouts must stay UNDER AT&T's no-answer timer
>
> `roybal-voice` dials `OWNER_CELL` in two places: the initial screen
> (`DIAL_TIMEOUT`, 15s) and the AI's escalate handoff (`ESCALATE_TIMEOUT`,
> now 15s, previously a hardcoded **25s**).
>
> The cell that Twilio is dialling is the same cell that conditionally
> forwards to Twilio. If Twilio rings **longer** than AT&T waits, AT&T
> forwards Twilio's own call back into `roybal-voice` and the caller meets the
> receptionist a second time, on a second billed call. At 25s versus AT&T's
> ~20s, the old escalate path did exactly that.
>
> **If you shorten AT&T's timer (below), re-check both.** A 10s AT&T timer
> with a 15s `DIAL_TIMEOUT` re-opens the loop.

---

## Tuning the ring time

Total caller wait = **AT&T's no-answer timer** + ~1–2s of Twilio handoff.

AT&T's default is ~20s (about 4–5 rings). To shorten it, set the timer in the
same code — valid values are 5 to 30 seconds in 5-second steps:

```
**61*18663452290**15#
```

That gives ~15s on the handset, receptionist at ~16s. If that syntax errors on
your device, the fully-qualified GSM form is `**61*18663452290*11*15#`.

Trade-off: less time to dig the phone out of a pocket, versus less time before
the caller gives up. 15s is a reasonable floor. Do not go below 10s — and if
you do, drop `DIAL_TIMEOUT` and `ESCALATE_TIMEOUT` to match, per the warning
above.

---

## Reverting

### Back to AT&T voicemail

```
*61*12142269138#
```

**`+1 214-226-9138` is the AT&T voicemail deposit number for this specific
line**, captured from `*#61#` before the 2026-08-12 change. It is not a
universal AT&T number — each line gets its own, which is why it is written
down here. This single command restores the pre-change behaviour exactly.

Do **not** revert with `#61#`. That deactivates conditional forwarding, and
since voicemail *is* the forwarding target on AT&T, it can leave unanswered
calls ringing out with **no voicemail at all**. Always repoint explicitly.

For the record, the full pre-change state (`*#61#`, 2026-08-12) was: **Voice**
call forwarding when unanswered → `+12142269138`, Enabled. Every other class —
Data, Fax, SMS, Sync Data Circuit, Async Data Circuit, Packet Access, Pad
Access — Disabled. Only the Voice line matters; the rest are GSM-era service
classes this line has never used, and they should stay disabled.

Check current state at any time:

```
*#61#     no answer      *#67#     busy      *#62#     unreachable
```

Avoid `##61#` (erase) — it wipes the entry rather than repointing it.

### Turn off the AI, keep everything else

Any one of these, fastest first:

1. **Remove the Twilio voice webhook** on the 866 → forwarded calls land on
   Twilio with no instructions.
2. **`fly scale count 0 -a roybal-phone`** → `roybal-voice` still answers and
   sends callers to voicemail; the recording is in the Twilio console.
3. **Unset `FORWARD_ONLY_TO`** → reverts only the ring-time fix; the AI still
   answers, just after a redundant 15s of ringing.

The AI going down never dead-ends a caller — every failure path in
`roybal-voice` ends in `<Record>`.

---

## Verifying

Call the 907 from a phone that is **not** the owner's cell, let it ring out.

1. Handset rings, then the receptionist greets — no second round of ringback.
2. `fly logs -a roybal-phone` shows the session.
3. **Twilio Console → Monitor → Logs → Calls → that call → `From`.** This is
   the one that matters. It must be the *caller's* number, not (907) 371-9868.

If `From` shows the 907, AT&T is presenting the forwarding line rather than the
caller. That is a functional break, not a cosmetic one:
`services/phone-agent/tools.mjs` keys `lookupCaller`, `createLead`'s fallback
phone, and `callerBudget(last10(session.from))` on that value — so every caller
would look like the same person, and the first call of the day would eat the
1-lead-per-caller limit, leaving later callers with **no lead created at all**.
Fix before relying on the lane.

---

## Related

- `services/phone-agent/README.md` — the agent itself, secrets, day-2 ops,
  the "answers but can't hear me" diagnosis
- `apps/site/src/data/site.ts` — `LOCAL_NUMBER_NOTE`, why the 907 is the
  published number and stays that way
- `supabase/functions/roybal-voice/index.ts` — the TwiML routing
