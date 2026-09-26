# Narrated Walkthrough — the walk becomes the scope, on the job file, by itself

**Status:** approved 2026-09-24 — the six open decisions in §11 are ruled (owner took every proposed default); nothing built
**Date:** 2026-09-24
**Companion to:** `docs/Lead_Bid_Workflow_Design.md` (the bid file, the Bid card, the Site Visit packet) and `docs/Magicplan_Integration_Design.md` (measured quantities, room-tagged photos). Magicplan answers *how big*. This doc answers *what happened, what's there, and what we're going to do about it* — the half of the estimate that today lives in Branden's head between the driveway and the desk.
**Builds on, does not replace:** the Site Visit panel that shipped in #217/#219 (`apps/field/js/sitevisit.js`, `supabase/functions/roybal-ai-office/sitevisit.ts`) — the packet already takes a walk recording and room videos and the draft already cites `walk 14:20`. Everything here is a widening of that seam.

*The site walk is where the estimate is actually decided: which wall gets the flood cut, what's pre-existing, what the homeowner said the leak did, what finish is on the cabinets, where the sub is needed. Right now that knowledge is a silent Magicplan clip, one audio file uploaded after the fact, and whatever survived the drive home. The plan is to make a narrated walk — talk while you film — the primary scope capture on every bid and every mitigation day 1, and to make a recorded client meeting the primary source for the homeowner's account. Both land on the job file, transcribed and turned into reviewable scope notes, without a laptop.*

---

## 1. What exists today (verified on `origin/main` through #229)

| Piece | Where | What it does now | Gap for a narrated walk |
|---|---|---|---|
| Site Visit panel | `sitevisit.js` | Five slots: Magicplan report PDF · photos · **Magicplan room videos** (silent; 8 evenly spaced stills pulled in the browser at ≤1568 px, `videoFrames()`, `FRAMES_PER_VIDEO = 8`) · photographed note pages · **one** "Site walk recording" (`audio/*,video/*`, `kind:'audio'`, replaces on re-add). All uploaded to `field-media/sitevisit/<job>/` with `uploadSiteFile()`. | A narrated video is *either* stills (no words) *or* a transcript (no pictures). One recording per visit. No offline queue — the tap must happen with signal. |
| Transcription | `index.ts siteVisitTranscribe`, `sitevisit.ts formatTranscript` | Deepgram pre-recorded by signed URL, `diarize=true&utterances=true&smart_format&punctuate` + `STT_KEYTERMS`; keeps `mm:ss` and speaker per utterance; metered into `ai_usage` as `deepgram-stt`. | Runs synchronously inside the edge function's wall clock. Fine for 20 minutes; fragile for an hour-long meeting. Transcript stored flat (`sv.transcript` text) — the utterance times aren't kept as data. |
| Estimate draft | `sitevisit.ts` prompt + Message Batches | Reads report, photos, stills, notes, transcript, typed scope; every line carries a citable `basis` ("walk 14:20: 'take it to four feet on the sink wall'"). | The transcript goes in raw. Nothing in between extracts *scope notes* a person can review before the estimate is drafted; nothing from the walk reaches the narrative, the Scope of Work, or a proposal. |
| In-app audio | `dictate.js` | Tap-to-record with MediaRecorder (`audio/mp4`, 250 ms chunks — the iOS-safe recipe), base64 → `transcribeOnly`. | Built for a 10-second answer, not a 40-minute meeting: chunks live in memory, nothing persists if Safari reloads. |
| Upload path | `supa.js uploadSiteFile` | One `POST /storage/v1/object/…`, `x-upsert`. 413 → "larger than the storage upload limit". | Not resumable. A 300 MB clip on North Pole LTE that drops at 80 % starts over — or dies when the screen locks. |
| Crew capture SOP | `docs/architecture/05-CREW-CAPTURE-SOP.md` | "Type readings. Never dictate them." Photos' caption text is the only link to rooms. Day-1 emergency-service times are captured on the internal Field Report and the office hand-builds a loss-intake summary for Supporting Docs (§211, §12.4). | Video is not in the SOP at all. The loss-intake summary is retyped from memory. |
| P1 contract | `0004_p1_contract_tables.sql` (#209) | `proposals`, `events`, `jobs_queue`; owner ruling: nothing money-adjacent applies without a human. | The walk's findings ("you said a sub for the electrical; there's no electrical line") have no proposal path yet. |

Two things the existing build got right and this doc keeps: **files never ride inside the job record** (they go to `field-media/sitevisit/<job>/` and are read by signed URL), and **the AI reads evidence and cites it** — every extracted note here carries the clip and timestamp it came from.

## 2. Locked decisions

Decisions 1–7 were proposed with the doc; 8–13 are the owner's rulings of 2026-09-24 on the questions that were §11.

1. **A narrated walk clip is one thing, not two.** New file kind `walk` (video with speech). Each clip produces *both* stills and a timestamped transcript, and the stills are captioned with what was being said at that second. The old `videos` (silent) and `audio` (voice-only) kinds keep working — a Voice Memo is still a valid walk recording — but the UI leads with 🎥 Walk.
2. **Many short clips, not one long take.** One clip per room or area, 1–3 minutes, named by what you say in the first five seconds ("Kitchen."). Short clips upload in the driveway, survive a dropped connection, and map one-to-one onto Magicplan rooms and estimate room groups. A long take is accepted but split by spoken room cues at extraction time.
3. **Capture works offline; understanding needs signal.** Recording uses the phone's own Camera (native quality, works with zero bars). The file is queued in the app's local store and uploads when the phone has signal — resumable, with progress. Transcription and extraction run server-side afterward. This is the SOP's own rule ("useful in the office, never a step you depend on in the field") applied to video.
4. **The video is the primary record; the AI output is a proposal.** Scope notes, homeowner statements, flagged discrepancies, and any estimate or narrative text derived from a recording land **amber** — reviewable, citable to clip + timestamp, accepted by a person. Nothing a recording says ever writes a reading, an equipment row, a price, or a customer-facing sentence on its own. Where the finding is actionable (unbilled item, missing line, sub needed), it becomes a P1 `proposals` row.
5. **Meetings are recorded with the customer's knowledge, every time.** Alaska is a one-party-consent state (AS 42.20.310 — see §8.4), so a participant may lawfully record; company policy is stricter: the recorder announces on tape and gets a yes, the app shows the script and stamps the consent. No announcement → no recording, notes only. Phone calls with adjusters or anyone who may be out of state are **out of scope** for this doc (§8.4).
6. **The company's STT/LLM keys never reach a browser.** All transcription and extraction runs in `roybal-ai-office` behind the existing JWT + `ai_usage` metering. Deepgram reads the file by signed URL as today; the browser never re-uploads audio to the AI function.
7. **Additive.** New file kinds, new optional blob fields on `siteVisit` and on the job, one new server action family, one queue job type. No new table. Deleting all of it restores today.
8. **Who records (ruled).** Owner and office/estimator roles record walks and meetings on bids. Crew leads record the day-1 arrival clip and the optional monitoring clip on mitigation jobs. Nobody else. The 🎥/🎙️ buttons render for those roles only (`profiles.role`, the same gate the Bid card's office-only actions use); crew see the clips and stills, not the record buttons.
9. **Consent policy (ruled).** Announce on tape every time, per the §8.4 script; a no stops the recording and stamps `consent.declined`. No phone-call recording anywhere in this doc. A one-line notice goes on the work authorization / intake form: *"Roybal Construction may record site walks and on-site meetings for documentation of scope and conditions."* — its own small PR against the authorization form, before V3 ships.
10. **Retention (ruled).** Raw walk video and meeting audio: **3 years from job close** (`project.closedAt`, else the last estimate's `sentAt` for a lost bid), purged **by job** by a scheduled retention job that writes `purgedAt` on each file row and an `events` row — never by a tap on the panel. Transcripts, stills, scope notes and meeting summaries stay with the job for its life. Owner-facing override: a per-job **Hold** flag that suspends purge (disputes, litigation, open claims).
11. **Camera rule (ruled).** Every company phone: Settings → Camera → Record Video = **1080p at 30 fps**, Formats = **High Efficiency (HEVC)**. ~60 MB/min. Written into the SOP's device-setup paragraph and checked on shop day. 4K and 60 fps are never used for walk clips.
12. **What the carrier sees (ruled).** Stills and transcript *excerpts* quoted in the narrative and the loss-intake summary. Raw video and meeting audio go to a carrier only on a written request and only by the owner's hand — nothing in the packet builder, the portal, or any send rail can attach them.
13. **Recap to the customer (ruled).** After every recorded meeting the recap text is **drafted always**, in the owner's voice, and **sent only on his tap** on the existing human-approved rails (bid doc §7 row 5). It never auto-sends and it never contains prices.

## 3. The flow — bid / site visit

| # | Step | Where | Writes |
|---|---|---|---|
| 1 | Site visit scheduled; bid file `bj-<tileId>` exists (bid doc §3 steps 3–4). Magicplan project ready (Magicplan doc §3 step 2). | admin / board / field | existing |
| 2 | **NEW — 🎥 Walk.** On the Site Visit panel (and a shortcut on the Bid card), tap **🎥 Record walk**. Opens the phone's Camera in video mode (`<input type="file" accept="video/*" capture="environment">` — native app, native stabilization, works offline). Record the room while narrating (§7). Tap ✓. Repeat per room. | field | `siteVisit.files[] += {kind:'walk', status:'queued', …}`; the blob goes to the local media queue (§4.3) — **not** into the project JSON |
| 3 | **NEW — stills, right away.** As each clip lands, the browser pulls stills exactly as it does for Magicplan videos today (`videoFrames()`), so the packet gains pictures even before the upload finishes. Still count scales with clip length: 8 for a clip under 90 s, one every 12 s after that, capped at 24. | field | `siteVisit.files[] += {kind:'frames', videoId, …}` (existing shape) |
| 4 | **NEW — upload, resumable.** The media queue uploads each clip to `field-media/sitevisit/<job>/walk-<id>.<ext>` over Supabase's resumable (TUS) endpoint, 6 MB chunks, progress on the row, retry on reconnect. Stills go by the existing `uploadSiteFile`. Screen locked / app backgrounded → the upload pauses and resumes on next open (§4.3). | field | file row `status:'uploaded'`, `path` |
| 5 | **NEW — transcribe.** When a clip's `status` flips to uploaded and the device is online, the app calls `walkTranscribe {path}`. Same Deepgram call as today plus `paragraphs=true`; the **utterances are kept as data** (`{start, end, speaker, text}[]`), not flattened. Recordings over ~25 minutes go through Deepgram's `callback` parameter to a new `roybal-ai-ingest` route instead of waiting inside the edge function. | `roybal-ai-office` | file row `transcript: {utterances[], seconds, model}`; `sv.transcript` (the flat text the draft already reads) regenerated from *all* walk clips in capture order, each clip prefixed `— Clip 3 · Kitchen · 02:14 —` |
| 6 | **NEW — align.** Client-side, pure, tested: each still gets `caption = frameCaption(...) + ' · "' + <the utterance(s) within ±6 s of t> + '"'`. The estimator now sees the picture *and* what was being said while it was taken — "still at 01:42 from walk clip Kitchen · 'this base cabinet run is swollen at the toe kick, all of it goes'". | field | `siteVisit.files[frames].caption` |
| 7 | **NEW — scope notes (the new step).** Once every queued clip is transcribed (or on tap), **✨ Draft scope notes** calls `walkExtract`. Input: the walk transcript(s), the aligned stills, `project.rooms`, Magicplan room names when present, the job kind. Output (§4.2): per-room observations, materials/finishes, damage and cause, quantities spoken aloud, **instructions** (what the owner said to do), pre-existing conditions, homeowner statements, unknowns to verify, safety, subs/trades needed, each item with `{clip, at}`. Lands amber in a **Scope Notes** section of the Site Visit panel. | `roybal-ai-office` (Batches for big packets, direct for small) | `siteVisit.scopeNotes` (proposed, `status:'draft'`) |
| 8 | **Review.** He reads the notes room by room in the truck or at the desk. Per item: ✓ keep · ✎ edit · ✕ drop; per room: **Use as typed scope** appends the accepted lines to `siteVisit.typedScope` in the estimator's own words. Unknowns become a **Verify** checklist on the Bid card. | field | `scopeNotes.status:'reviewed'`, `typedScope` |
| 9 | Draft the estimate (bid doc §3 step 7). **NEW:** the prompt gains a `WALK SCOPE NOTES (reviewed)` block ahead of the raw transcript and is told: *accepted notes are instructions; the transcript is evidence.* `basis` cites `walk Kitchen 02:14` (clip name + time) instead of a bare minute mark. | existing `sitevisit.ts` | estimate lines |
| 10 | **NEW — proposals.** Extraction items typed `instruction`, `sub_needed`, or `unbilled_risk` that have no matching estimate line after the draft are written as `proposals` rows (`kind:'estimate.missing_line'`, payload = the note + citation) — visible on the office review surface P1 already defines, never auto-applied. | `roybal-ai-office` | `proposals` |
| 11 | Won: the walk clips, stills and scope notes stay on the job (they are the job file). The **reviewed** scope notes seed the Scope of Work and the "before" condition text. Lost: archived with the file (bid doc §3 step 11); raw video purged 3 years after the last estimate's `sentAt` (decision 10). | field | — |

**Nothing above changes what the Bid card, the estimate form, or the board already do.** A visit with zero clips runs exactly as it runs today.

## 4. Data — blob fields, one queue job, zero DDL

### 4.1 On `siteVisit.files[]` (existing array, new kinds and optional fields)

```
{ id, kind: 'walk' | 'meeting' | 'videos' | 'audio' | 'frames' | 'photos' | 'notes' | 'report',
  name, mime, size, path, at,
  status:    'queued' | 'uploading' | 'uploaded' | 'transcribed' | 'failed',   // walk/meeting only
  progress:  0..1,                     // while uploading (not synced — device-local, see §4.3)
  duration:  seconds,                  // from the <video>/<audio> element at capture
  room:      "Kitchen",                // spoken cue → parsed (§7) or set by hand; matches project.rooms / Magicplan names
  transcript: { utterances: [{start, end, speaker, text}], seconds, model, at },   // walk/meeting
  frames:    n,                        // walk/videos: count of stills (existing)
  consent:   { announced: true, at, by, declined: false }   // meeting only (§8)
}
```

`kind:'frames'` rows already carry `videoId` and `caption`; the alignment step only rewrites `caption`. `sv.transcript` (flat text) stays the field the draft reads — it is now *derived* from every `walk`/`audio`/`meeting` transcript in order, never typed into.

### 4.2 `siteVisit.scopeNotes` — the reviewable middle layer

```
scopeNotes: {
  status: 'draft' | 'reviewed',  generatedAt, model, fromClips: [ids],
  rooms: [{
    room: "Kitchen",                                 // as spoken / as Magicplan names it
    observations: [{ text, clip, at, stillId? }],    // "ceiling drywall stained ~4×6 at the sink wall"
    materials:    [{ text, clip, at }],              // "oak shaker uppers, laminate tops, LVP over OSB"
    damage:       [{ text, cause?, clip, at }],      // "supply line under sink, Cat 1, ~3 days"
    quantities:   [{ text, value?, unit?, clip, at }], // "about twelve feet of base"
    instructions: [{ text, clip, at }],              // "take it to four feet on the sink wall"
    preExisting:  [{ text, clip, at }],              // "that crack was there before"
    homeownerSaid:[{ text, clip, at }],              // quoted or paraphrased, attributed
    verify:       [{ text, clip, at }],              // "check if the subfloor is wet under the fridge"
    safety:       [{ text, clip, at }],
    trades:       [{ trade, text, clip, at }]        // "electrician for the disposal circuit" — trade only, never a company name
  }],
  jobWide: { … same buckets, room: 'Main Level' },
  accepted: { [itemKey]: true | false }              // review state per item (§3 step 8)
}
```

Every item is citable. The extraction prompt is forbidden from inventing a room the transcript never names and from stating a quantity that wasn't spoken or visible — a quantity it *infers* from a still must say so (`"~12 LF (est. from still 01:42)"`) and lands in `verify`, not `quantities`.

### 4.3 The local media queue (device-side, IndexedDB, never synced)

Video cannot ride the project JSON: a 3-minute 1080p clip is ~180 MB. The field app already keeps projects in IndexedDB (`Store`); this adds one object store `media_queue` `{id, projectId, fileId, blob, mime, bytesSent, tusUrl, createdAt}`. Rules: a clip is written to the queue **before** stills are pulled or anything is shown as saved; the queue drains oldest-first whenever `navigator.onLine` flips true or the app foregrounds; a TUS upload URL is stored so a resume continues from `bytesSent`; a row is deleted only after the server confirms the final chunk; the queue's total size shows on the Site Visit panel ("2 clips waiting to upload · 410 MB"). Installed PWAs are exempt from Safari's 7-day eviction of script-writable storage, but the operating rule is still *upload the same day* — the queue is a buffer, not an archive.

**Upload limits to set before V1 ships:** the project's global file-size limit (Storage → Settings; the default is far below a video clip) and the `field-media` bucket's own `file_size_limit`, raised to 1 GB. Resumable uploads require the 6 MB chunk size exactly and upload URLs expire after 24 hours — a clip queued Friday night uploads Monday from byte 0, which is fine.

### 4.4 Queue job (P1)

`jobs_queue` kind `walk.transcribe {projectId, fileId, path}` — used by the Deepgram `callback` route for long recordings so the result is stored server-side (`field-media/sitevisit/<job>/walk-<id>.transcript.json`) and adopted by the field app on next open, the same adopt-on-open pattern the Magicplan doc uses for `magicplan_exports`. Short clips skip the queue and return inline as today.

## 5. Where it shows up

- **Site Visit panel** (`sitevisit.js`): the five slots become six, led by **🎥 Walk clips** (list: name/room · duration · stills · status chip `queued 40 % · uploaded · transcribed ✓` · ▶ play from storage · ✕). "Magicplan room videos" stays, relabeled *Silent clips (Magicplan)*. **🎙️ Client meeting** slot (§8). Below the slots: **Scope Notes** — room accordions, amber items with the ✓/✎/✕ trio and a clip-time chip that seeks the player to that second.
- **Bid card** (bid doc §5.4): the Packet line reads `4 clips · 11 min · transcript ✓ · scope notes ✓ (2 to verify)`; a **Verify** line lists the open `verify` items with a checkbox each — the thing to look at before you leave the driveway.
- **Estimate form**: Pricing Basis gains "Scope from narrated site walk (4 clips, 2026-09-26) reviewed by the estimator." Per-line `basis` cites `walk Kitchen 02:14`.
- **Job home (mitigation)** — §9.
- **Admin ⚙ Settings → AI**: a *Recordings* row showing minutes transcribed this month, the 3-year retention rule (decision 10), the next purge date, and the jobs on Hold.
- **Office review** (P1 surface): `estimate.missing_line` proposals with their citation and a **Play** link that opens the clip at the timestamp.

## 6. Server — three actions, one prompt family

| Action | Input | Does | Returns |
|---|---|---|---|
| `walkTranscribe` | `{path}` | Signs the URL (`signMedia`, `isSitePath`), calls Deepgram `listen` with `diarize&utterances&paragraphs&smart_format&punctuate&keyterm…`; for `duration > 1500 s` (from the file row) passes `callback=<roybal-ai-ingest>/dg-callback?job=…` and returns `{queued:true}`. Meters `audioSeconds` into `ai_usage` exactly as `siteVisitTranscribe` does. | `{utterances[], seconds}` or `{queued}` |
| `walkExtract` | `{projectId, clips:[{id, room?, transcript}], stills:[{path, caption, clip, at}], rooms[], jobKind}` | One structured-output request (JSON schema = §4.2) with the same evidence-first rules the estimator uses; Batches when stills > 20, direct otherwise (`siteVisitStart/Result` pattern). Speaker labels: speaker 0 assumed the recorder unless a `meeting` transcript names otherwise. | `scopeNotes` |
| `meetingSummarize` | `{projectId, fileId, transcript, participants[]}` | §8.3 schema. | `meeting.summary` |

**Extraction rules baked into the prompt** (mirrors `sitevisit.ts`):
- Quote before paraphrase; keep the recorder's own words for `instructions`.
- Every item has `clip` and `at`; an item with no citation is dropped by the parser.
- Rooms come from the transcript's spoken cues, then `project.rooms`, then Magicplan names — never invented. Unplaceable items go to `jobWide`.
- Never name a subcontractor's company (the estimate rule, `sitevisit.ts:211`); trade only.
- `homeownerSaid` is attributed ("Homeowner: …") and never rewritten into a finding.
- Readings, equipment counts and dates spoken on a mitigation clip go to `verify` with the spoken value — they are **never** applied to the Drying Log (SOP §5: "Type readings. Never dictate them.").

**Cost, so it's on the table:** Deepgram pre-recorded is well under a cent per minute — a 12-minute walk plus a 40-minute meeting is under 40 cents of STT. Stills at ≤1568 px run ~1.5 k input tokens each; a six-clip walk is ~50 stills, ~75 k tokens, halved on Batches. Storage: 1080p30 HEVC from an iPhone is ~60 MB/min, so a 12-minute walk is ~700 MB — about 1.5 ¢/month at Supabase's storage rate, and one LTE upload. **Set the phone to 1080p/30 (not 4K, not 60 fps) and HEVC "High Efficiency"** — that single setting is the difference between a driveway upload and a shop upload.

## 7. The narration protocol — what the recorder says (crew card, one page)

The extraction is only as good as the words. These cues are the whole training:

1. **Open every clip with the room, then the material you're standing on.** *"Kitchen. LVP over OSB, painted drywall, eight-foot ceiling."* Say the room exactly as Magicplan / the room list has it — the clip is filed under the first room name spoken.
2. **Point, then say what you see, with a number.** *"Sink wall, staining about four by six on the ceiling, drywall soft to the touch for about eight feet along the base."* Approximate numbers are fine — say "about." A number said out loud is a `quantity`; a number never said is `verify`.
3. **Say "instruction:" for scope you're deciding.** *"Instruction: flood cut to four feet on the sink wall and the two returns, save the uppers."* This is what the estimator follows. Say "leaning toward" when you're not deciding yet.
4. **Say "pre-existing:"** for anything you won't be fixing on the claim. *"Pre-existing: the crack over the window, not related."* This is the line that keeps the adjuster and the homeowner off the same page you're on.
5. **Say "homeowner says:"** when you're repeating the customer. *"Homeowner says the supply line let go Tuesday night, found it Wednesday morning."* Attribution keeps their statement theirs.
6. **Say "verify:"** for anything you'd want to check with a meter, a sub, or a second look. *"Verify: subfloor under the fridge."* These become the checklist on the Bid card.
7. **Say "needs an electrician / plumber / HVAC"** — the trade, not the company.
8. **Close with "end kitchen."** Stop. Start the next clip in the next room. **1–3 minutes per clip.** If the phone says storage is full or you have no signal, keep recording — the clips upload themselves later.
9. **Mitigation day 1 (added to the SOP §4):** one clip at the door before anything moves — *"Arrival 3:40 pm, water on the floor in the utility room and hall, homeowner says it started this morning, shut-off is closed."* That clip is the emergency-service time record the packet currently gets from memory (SOP §211). Then one clip per affected room, same cues. **Readings are still typed into the app**; the clip is context, not a data entry.
10. **Every monitoring visit (optional, 60 seconds):** *"Day 3, utility room, six air movers and the LGR still running, nothing moved."* It exists so the office can see the room and hear the count; if it disagrees with the log, the office gets a flag, not a changed number.

Deepgram's `STT_KEYTERMS` list gains the cue words (`instruction`, `pre-existing`, `homeowner says`, `verify`, `end`) and the common material/trade vocabulary already on the estimating price list, so they transcribe cleanly over air movers.

## 8. Recorded client meetings — yes, and here is how it helps

### 8.1 What it buys

The site walk captures what the *building* says. The meeting captures what the *customer* says, and on an insurance job that is half the file: cause of loss and date first noticed (the sentence the adjuster reads first), what's been done since (shut-off, towels, a plumber's visit), pre-existing conditions they volunteer, what they want back (like-kind vs upgrade — the alternates section), who's paying for what (deductible conversations, out-of-pocket upgrades), and the commitments made in the kitchen ("we'll have the dehus in tonight," "I'll send the estimate Friday"). Today those live in memory and in a text the next morning. On a recording they become: attributed statements for the narrative ("per the homeowner, the leak was first observed on…"), the commitments list on the Bid card, a recap text to the customer in Branden's words, and a record when a homeowner later remembers the conversation differently — the dispute-reduction he's asked for in every estimate's assumptions section, applied to the conversation that preceded it.

### 8.2 The flow

| # | Step | Where | Writes |
|---|---|---|---|
| 1 | Tap **🎙️ Record meeting** on the Site Visit panel (bids) or the Field Report (mitigation day 1). The screen shows the **consent script** (§8.4) large enough to read aloud and a single **Start** button. | field | — |
| 2 | Recording: `dictate.js`'s iOS recipe (MediaRecorder, `audio/mp4`, 250 ms chunks) hardened for length — chunks flushed to the `media_queue` row every 15 s, so a reload or a call coming in loses at most 15 seconds; a running timer; **Pause / Resume**; **Stop**. Or: import a Voice Memo through the same slot (accepts `audio/*`). | field | `files[] += {kind:'meeting', consent:{announced:true, at, by}}` |
| 3 | Upload (resumable) → `meetingTranscribe` (= `walkTranscribe`, `diarize` matters here) → utterances with speakers. First-pass speaker naming: the consent script names the recorder and the customer in the first 20 seconds, so the LLM labels `Speaker 0 → Branden`, `Speaker 1 → Kal Kennedy`; a one-tap correction on the panel. | field / office | `transcript`, `participants[]` |
| 4 | **✨ Summarize meeting** → `meetingSummarize` (§8.3). Amber, reviewed like scope notes. | office | `siteVisit.meeting.summary` |
| 5 | What it feeds, each behind a tap: **Bid card → Commitments** (what we promised, with dates); **Site Visit → homeownerSaid** merged into scope notes; **Narrative** (`narrative.js` / `roybal-ai-narrative`) gains a *Homeowner account* paragraph on claims; **Recap text/email** drafted in Branden's words through the existing human-approved `roybal-notify` / `gmailSend` rails (bid doc §7 row 5) — never sent by itself; **Loss-intake summary** (mitigation day 1) drafted for Supporting Docs from the arrival clip + meeting, replacing the retyped one (SOP §12.4). | field / office | proposals / drafts |

### 8.3 `siteVisit.meeting` (blob, additive)

```
meeting: {
  fileId, participants: [{speaker: 0, name: "Branden", role: "contractor"}, {speaker: 1, name: "Kal Kennedy", role: "homeowner"}],
  consent: { announced: true, at, by, declined: false },
  summary: {
    status: 'draft' | 'reviewed', generatedAt, model,
    lossAccount:   [{ text, speaker, at }],   // cause, dates, sequence — attributed
    conditions:    [{ text, speaker, at }],   // pre-existing / unrelated items the customer raised
    wants:         [{ text, speaker, at }],   // finishes, upgrades, "just make it like it was"
    money:         [{ text, speaker, at }],   // deductible, out-of-pocket, who's paying what — flagged, never priced
    commitments:   [{ who, text, due?, at }], // "Roybal: dehus tonight" · "Customer: send the plumber's invoice"
    questions:     [{ text, at }],            // open items either side asked and nobody answered
    redFlags:      [{ text, at }],            // scam / scope-creep / third-party-payment signals (intake preferences)
    recapDraft:    "…"                        // the follow-up text, Branden's voice, ≤ 600 chars
  }
}
```

### 8.4 Consent, law, and policy (not legal advice — confirm with counsel)

- **Alaska:** one-party consent for in-person and telephone conversations (AS 42.20.310; *Palmer v. State* read the statute as aimed at third-party interception). A participant recording is lawful without the other party's agreement. Sources in the chat summary.
- **Company policy, stricter than the law:** announce, on tape, every time. Script shown on screen: *"This is Branden Roybal with Roybal Construction. It's Thursday, September 26th, about two o'clock, and I'm at 1465 Noble Street with Kal Kennedy. I'm recording our conversation so my notes for your estimate are accurate — is that all right with you?"* A yes → `consent.announced = true`. A no → **Stop**, `consent.declined = true`, the slot shows "Declined — notes only." The announcement itself is what makes the recording persuasive later; a secret recording persuades no one.
- **Out of scope here:** recording **phone calls** — with adjusters, agents, or a customer who may be in another state. Several states require every party's consent and the other party's location governs. If that's ever wanted, it is a separate design with a spoken disclosure at the top of every call, on the company number, through `roybal-voice` — not the phone in a kitchen.
- **Minors, medical details, and anything a customer asks to keep off the record:** stop, and say so on tape before stopping.
- **Retention** is ruled (decision 10): 3 years from job close, purged by job by the retention job, never by a tap on the panel — the file row keeps `path` and gains `purgedAt`; a per-job Hold flag suspends it.

## 9. Mitigation jobs — the same seam, three narrow uses

The Site Visit packet exists on bid files; active mitigation jobs have the Field Report, the Drying Log and Job Photos. The walk slot is added to the **Field Report** (internal, never in the carrier packet — SOP §211), not to the Drying Log, so nothing here can be mistaken for a reading:

1. **Day-1 arrival clip + meeting** (§7 step 9, §8) → the **loss-intake summary** draft (arrival time, conditions found, cause per homeowner, emergency actions and their times) for Supporting Docs, and the *Homeowner account* paragraph of the narrative. This is the highest-value item in the doc for collections: the emergency-service and after-hours lines currently have no defensible time record in the packet.
2. **Monitoring clip (optional, 60 s)** → `walkExtract` in *mitigation mode* returns only `verify` items compared against that day's Drying Log rows: *"Clip says six air movers in Utility; log has five rows"* → an `events` row and a chip on the office's job view. **Never a write to the log.** Retires nothing from the SOP; adds one 60-second habit.
3. **Scope-change clip** ("Instruction: the tile in the hall is coming up, it's delaminated — add it") → `proposals` `kind:'scope.change'` with the citation, for the office to turn into a change order / supplement. Today this is a text to Branden that gets lost.

The SOP gets a §4.0 and §5.0 paragraph and the laminated card gets three lines (§7 steps 9–10). Nothing else in the SOP moves.

## 10. Sequencing

| # | Ship | Contents | Effort | Depends on |
|---|---|---|---|---|
| **V0** | **Narrated clips into the packet** | `kind:'walk'` slot with native Camera capture; stills per clip (scaled count); `walkTranscribe` keeping utterances; flat `sv.transcript` regenerated from all clips with clip headers; still captions aligned to speech (pure helper + Node test); estimator prompt reads clip-named basis. Standard upload (as today) with a size warning at 200 MB. | M | — |
| **V1** | **Offline queue + resumable upload** | `media_queue` store; TUS uploads with progress, pause on background, resume on open; bucket and global size limits raised; Deepgram `callback` route in `roybal-ai-ingest` + `jobs_queue walk.transcribe` for long files; adopt-on-open. | M | V0 |
| **V2** | **Scope notes** | `walkExtract` + schema + parser; Scope Notes section with ✓/✎/✕ and seek-to-timestamp; "Use as typed scope"; Verify line on the Bid card; `WALK SCOPE NOTES` block in the draft prompt; `estimate.missing_line` proposals. | M–L | V0 (V1 for comfort) |
| **V3** | **Client meetings** | 🎙️ slot with consent script + stamp; long-form recorder (chunk flush, pause/resume); speaker naming; `meetingSummarize`; Commitments line; recap draft on the existing approved-send rails; narrative *Homeowner account* block. **Before it ships:** the one-line recording notice on the work authorization / intake form (decision 9, its own small PR) and the counsel check in §11. | M | V1 |
| **V3b** | **Retention job** | Scheduled purge of raw walk/meeting files 3 years after job close, by job; `purgedAt` on file rows, `events` row per purge; per-job Hold flag on the job home (owner/office); Settings → AI *Recordings* row. Ships any time after V1; nothing to purge for three years, but the flag and the date must exist from the first recording. | S | V1 |
| **V4** | **Mitigation** | Walk slot on the Field Report; day-1 arrival clip → loss-intake summary draft to Supporting Docs; monitoring clip → log-discrepancy flags (events + chip); scope-change proposals; SOP §4.0/§5.0 + card lines. | M | V2, V3 |
| **V5** | **Nice-to-haves, each its own PR** | In-app recorder with a room-cue overlay ("Say the room name") for crews who won't learn the card; smart still selection (a still at each spoken cue instead of evenly spaced); auto-join clips to Magicplan rooms and print the room SVG beside its scope notes; Verify items → a site-visit punch list text to the crew lead. | S each | V2 + Magicplan M2 |

**Rollback (all):** every field is optional; a project without them renders as today. The old `videos`/`audio` kinds are never removed.
**Done when (V0):** a narrated clip recorded with the Camera app on a bid file yields, in the packet, stills captioned with the words spoken at that second and a transcript headed by clip and room — and the draft estimate's `basis` reads `walk Kitchen 02:14`.
**Done when (V1):** four clips recorded with no signal at a job in Salcha upload themselves in the truck on the Richardson without anyone reopening the panel, and a 45-minute recording transcribes without an edge-function timeout.
**Done when (V2):** the Scope Notes section shows a room-by-room list he can accept in under two minutes, every item plays back its clip at the right second, and an instruction with no estimate line shows up as a proposal.
**Done when (V3):** a recorded kitchen-table meeting produces a Commitments list on the Bid card and a recap text he can approve and send from the truck.
**Done when (V4):** the day-1 loss-intake summary in a mitigation packet was drafted from the arrival clip and the meeting, not retyped.

## 11. Rulings — 2026-09-24

All six ruled 2026-09-24 — the owner took the proposed default on each. The rulings are now decisions 8–13 in §2; the original questions are kept here for the record.

| # | Question | Ruling |
|---|---|---|
| 1 | Who records | Owner + office/estimator on bids; crew leads for the day-1 arrival clip and optional monitoring clip on mitigation; nobody else (decision 8) |
| 2 | Consent policy | Announce on tape every time, stop on a no, no phone-call recording; one-line notice added to the work authorization / intake form (decision 9) |
| 3 | Retention | 3 years from job close, purged by job by the retention job, never by tap; per-job Hold flag (decision 10) |
| 4 | Camera setting | 1080p/30, HEVC, on every company phone (decision 11) |
| 5 | What the carrier sees | Stills and transcript excerpts only; raw video/audio only on written request, by the owner's hand (decision 12) |
| 6 | Recap to the customer | Drafted always, sent only on the owner's tap (decision 13) |

**Still owed, but not blocking V0–V2:** one question to counsel confirming the §8.4 consent posture and the 3-year retention figure before V3 ships.

## 12. Fence — what this deliberately does not do

- **No measurements from video.** Quantities come from Magicplan or from what was said aloud; a still-inferred number is a `verify` item, never a `quantity`. (Photogrammetry from phone video is a different doc and, for interiors, a worse tool than the LiDAR you already carry.)
- **No writes to the Drying Log, equipment rows, psychrometrics, or invoice lines from any recording.** Flags and proposals only.
- **No autonomous customer sends.** Recap and follow-up drafts ride the existing human-approved rails.
- **No phone-call recording.** §8.4.
- **No new tables.** `jobs_queue` and `proposals` are P1's; everything else is blob fields and storage objects.
- **No changes to the estimate engine's pricing or structure.** It gets one more evidence block and better citations.
- **No Xactimate/Verisk data on any customer surface** (CRM decision 8 stands).

## 13. Suggestions beyond the ask

- **The Verify list is the sleeper feature.** "Verify: subfloor under the fridge" spoken in the kitchen becomes a checkbox you see before you get in the truck. That is the cheapest reduction in second site visits available.
- **Speak the estimate number and the follow-up date at the end of the meeting** ("I'll have RC-KEN-0925 to you Friday") — the summarizer turns it into the commitment, and the Bid card's Sent line has a promise date to be measured against.
- **Crew training video** (docs/architecture/06) — a 90-second clip of you narrating one room, per §7, is the whole training for the walk; add it to the shop-day agenda (SOP §12.1).
- **Later, the same clips train pricing.** Reviewed scope notes + the estimate that shipped + the job's actual hours (QB Time) is the feedback loop the PM app has wanted since day one, with the scope described in words rather than inferred from line items.
