/* ============================================================
   ✅ Approvals — everything waiting on the owner's yes (operations
   spine, step 4). The #/approvals tab of the office admin.
   ------------------------------------------------------------
   One list of every ask from both queues, with the evidence and
   Approve / Decline. It sits beside "text YES 12", not instead of
   it: a row can be answered by text or by tap, and only the first
   answer counts (both doors are guarded on the row still being
   open).

     text queue   pending_actions. Any signed-in login may read it;
                  only the service role may change it, so a tap goes
                  through roybal-notify's decidePending, which checks
                  the caller is the owner and runs the same executor
                  a YES text does.
     spine queue  proposals, read under the owner's RLS and answered
                  with op_proposal_approve / op_proposal_decline. Not
                  through supa.js's private rpc(): that adds p_build
                  and reads P0002 as "needs update", which here means
                  "no such proposal".

   Owner only (ownerCheck, below): any other login gets one line and
   no badge; a check that couldn't answer says so and offers Retry.
   The page never repaints under his hands: admin.js leaves
   #/approvals out of the sync repaint, and the page refreshes itself
   every 45 s while it is open, visible and no answer is in flight,
   and when the tab comes back into view.

   admin.js loads this file by dynamic import, and it imports only
   names that existed in the field modules before it was written (the
   receiptlibrary.js rule: an office browser can run one load on a
   stale cached field module after a deploy, and a missing export
   would blank the tab). What a card says lives in ../../js/approvals.js.
   That module is no longer new, so the same rule now covers it too:
   this page calls none of its exports added after step 4. Step 5's
   additions (the spine's YES number, spine jobs looked up in both job
   tables, whether the worker is sending email) arrive through calls
   step 4 already made: fields on the card (yesHint, laneHint), needs'
   answer (lanes), inbox's answer (older: the sends answered before the
   48 hours, whose outbox rows say whether one died since and so shows
   again) and lookFrom's options (heartbeats, now). An older
   cached copy ignores what it doesn't know, and the cards read as
   they did. The nightly billing check's invoice gaps ride the same
   way (kind "gaps", its lines and total as text on the card); an
   older copy makes them a plain card for that one load: Why and
   Evidence, a plain Approve, and a YES number roybal-notify won't
   take. The nightly QuickBooks match's receipts cards ride the
   same way (kind "qbo": a line per receipt, the project link, an
   outcome counted from the card's outbox rows, the "qbo" lane in
   needs' answer), and so does "Approve all QuickBooks cards": a
   loop over the one call a single Approve makes (decisionRequest,
   spineAnswer), shown only when the field module names the kind.
   Anything added later that has to be a call is checked first
   (typeof A.x === "function"). The sends that died in the last
   48 hours with a proposal older than the 7-day read (diedLate) are
   plain reads here, no new call: their proposal rows join the rest
   before inbox runs.
   ============================================================ */
import { h, clear, toast, likelyOffline } from "../../js/core.js";
import { SYNC_ENABLED } from "../../js/config.js";
import { rest, callFunction, isSignedIn, currentEmail } from "../../js/supa.js";
import * as A from "../../js/approvals.js";

const HASH = "#/approvals";
const REFRESH_MS = 45000;
const enc = encodeURIComponent;
/* the shared .badge tones: the chip by kind, the outcome line by how it went
   (invoice gaps and QuickBooks receipts, money asks, get admin.css's own) */
const TONE = { email: "disp-b", text: "disp-g", phase: "cat2", stage: "disp-x", gaps: "ap-money", qbo: "ap-qbo", other: "disp-x" };
const tone = (kind) => (Object.prototype.hasOwnProperty.call(TONE, kind) ? TONE[kind] : TONE.other);   // not Object.hasOwn: Safari < 15.4

const TEXT_COLS = "id,code,kind,label,params,job_id,proposed_by,status,result,created_at,expires_at,executed_at";
const SPINE_COLS = "id,operation,input,edited_params,proposed_by_kind,proposed_by_id,rationale,evidence_refs," +
  "job_id,status,expires_at,approved_at,decline_reason,result,error,created_at,updated_at,sms_code";
/* the newest worker heartbeat: is the worker sending email, or QuickBooks
   changes, right now (owner/office RLS, 0016) */
const BEAT_PATH = "worker_heartbeats?select=at,meta&order=at.desc&limit=1";
const JOB_COLS = "id,title:data->>title,customer:data->>customer,address:data->>address";

/* ---------- reads ---------- */
async function rows(path) {
  const res = await rest(path, { method: "GET" });
  if (!res.ok) { const e = new Error("read failed"); e.status = res.status; throw e; }
  return res.json();
}
const inList = (ids) => `in.(${ids.join(",")})`;          // uuids only (A.needs)
/* a name the page couldn't read just stays off the card; so does one from a
   read that answered with something other than a list */
const lookup = (ids, path) => (ids.length ? rows(path).then((r) => (Array.isArray(r) ? r : []), () => []) : Promise.resolve([]));
const laneWarn = (r, what) => (r.status === "fulfilled" ? null
  : `${what} didn't load${r.reason && r.reason.status ? ` (${r.reason.status})` : ": no connection"}.`);

let catalog = null;                    // operation_catalog (five rows today), read once per page load

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* The sends the worker gave up on in the last 48 hours (outbox rows gone
   'dead' since then: the row's last update) whose proposals the 7-day read
   didn't reach: an email approved a week or more ago that waited out a
   stopped worker, then died when it came back. Their proposal rows, read by
   id with the same columns, so each comes back to Recently decided as
   "Couldn't send" like the rest. Only beside a spine read that answered (a
   queue that didn't load stays one warning); a read that fails, or answers
   with something other than a list, adds nothing, and the tab reads as it
   would without it. */
async function diedLate(spine, dead) {
  const pr = spine.status === "fulfilled" ? spine.value : null;
  if (!Array.isArray(pr) || dead.status !== "fulfilled" || !Array.isArray(dead.value)) return [];
  const have = new Set(pr.map((r) => r && r.id));
  const ids = [...new Set(dead.value.map((o) => o && o.proposal_id))]
    .filter((x) => typeof x === "string" && UUID.test(x) && !have.has(x));
  return lookup(ids, `proposals?select=${SPINE_COLS}&id=${inList(ids)}&limit=100`);
}

/** Both queues and the names around them. Every row whose expiry is within
    the last 7 days or still ahead: that is every live ask, every expired one
    the count needs, and every recent answer (an ask is answered while it is
    open, so it expires after the answer). Plus, past that, the proposals of
    sends that died in the last 48 hours (diedLate). */
async function load(now) {
  const since = enc(new Date(now - A.EXPIRED_MS).toISOString());
  const [text, spine, dead] = await Promise.allSettled([
    rows(`pending_actions?select=${TEXT_COLS}&expires_at=gte.${since}&order=expires_at.desc&limit=200`),
    rows(`proposals?select=${SPINE_COLS}&expires_at=gte.${since}&order=expires_at.desc&limit=200`),
    rows(`outbox?status=eq.dead&updated_at=gte.${enc(new Date(now - A.RECENT_MS).toISOString())}` +
      `&proposal_id=not.is.null&select=proposal_id&order=updated_at.desc&limit=100`),
  ]);
  const pa = text.status === "fulfilled" ? text.value : [];
  const late = await diedLate(spine, dead);
  const pr = spine.status !== "fulfilled" ? [] : late.length ? [...spine.value, ...late] : spine.value;
  const warn = [laneWarn(text, "The text queue"), laneWarn(spine, "The new approvals queue")].filter(Boolean);

  const bare = A.inbox(pa, pr, {}, now);              // the cards to name: waiting and recent
  const shown = A.needs([...bare.waiting, ...bare.recent]);
  // and the sends answered before the 48 hours: one whose outbox row died
  // since comes back to Recently decided (A.isRecent keys it on the row's
  // updated_at), so their outbox rows and names are read as well. An older
  // field module has no `older` and reads just what it shows.
  const later = A.needs(Array.isArray(bare.older) ? bare.older : []);
  const need = {};
  for (const k of ["field", "board", "agents", "people", "outbox"]) need[k] = [...new Set([...(shown[k] || []), ...(later[k] || [])])];
  // only when a spine email or a QuickBooks receipts card is on the page (an
  // older field module never asks); a read that fails is null, "can't
  // tell", never "sending is off". An older send that comes back has died,
  // and a dead row waits on nothing.
  const beat = Array.isArray(shown.lanes) && (shown.lanes.includes("email") || shown.lanes.includes("qbo"));
  const [ops, field, board, agents, profiles, outbox, heartbeats] = await Promise.all([
    pr.length && !catalog ? rows("operation_catalog?select=name,version,description&limit=100").catch(() => null) : catalog,
    lookup(need.field, `field_projects?select=${JOB_COLS}&id=${inList(need.field)}&limit=100`),
    lookup(need.board, `coordination_jobs?select=${JOB_COLS}&id=${inList(need.board)}&limit=100`),
    lookup(need.agents, `agents?select=id,name&id=${inList(need.agents)}&limit=100`),
    lookup(need.people, `profiles?select=id,full_name&id=${inList(need.people)}&limit=100`),
    // a QuickBooks receipts card has a row per receipt (up to 50), so the
    // read takes up to PostgREST's 1000, not one row per card
    lookup(need.outbox, `outbox?select=proposal_id,status,next_attempt_at,error,provider_status,created_at,updated_at` +
      `&proposal_id=${inList(need.outbox)}&order=created_at.desc&limit=1000`),
    beat ? rows(BEAT_PATH).then((r) => (Array.isArray(r) ? r : null), () => null) : null,
  ]);
  if (ops) catalog = ops;
  const look = A.lookFrom({ catalog: catalog || [], agents, profiles, jobs: [...field, ...board], outbox, heartbeats, now });
  return { box: A.inbox(pa, pr, look, now), look, warn, failed: warn.length === 2, textOk: text.status === "fulfilled", readAt: now };
}

/* ---------- is this the owner? ----------
   Three answers, not two: true or false once role_is said so (kept for the
   page's life, per login), or null when it couldn't say (a 5xx, a token it
   turned down, no connection). null is never kept, so one blip at boot
   can't tell the owner the tab isn't his until he reloads: the next paint
   asks again. Not magicplan.js's callerRole(), which keeps a failed check
   as "no role". The server gates stay the real ones (the proposals RLS,
   decidePending's own owner check). */
let owner = { who: "", is: null, asking: null };
function ownerCheck() {
  const who = currentEmail();
  if (owner.who !== who) owner = { who, is: null, asking: null };     // another login: ask afresh
  if (owner.is !== null) return Promise.resolve(owner.is);
  if (!owner.asking) {
    const mine = owner;
    mine.asking = (async () => {
      const res = await rest("rpc/role_is", { method: "POST", body: JSON.stringify({ p_roles: ["owner"] }) });
      if (res.status !== 200) return null;
      const yes = await res.json().catch(() => null);
      return yes === true || yes === false ? yes : null;
    })().catch(() => null).then((yes) => { mine.asking = null; if (yes !== null) mine.is = yes; return yes; });
  }
  return owner.asking;
}

/* ---------- nav badge: what's waiting, both queues ---------- */
let badgeCache = { n: 0, at: 0, who: "" };
const paintBadge = (el, n) => { el.hidden = !n; el.textContent = String(n); };
function setBadge(n) {
  badgeCache = { n, at: Date.now(), who: currentEmail() };
  const el = document.getElementById("approvalsBadge");
  if (el) paintBadge(el, n);
}
async function count(path) {
  const res = await rest(path, { method: "GET", headers: { Prefer: "count=exact", Range: "0-0" } });
  if (!res.ok) throw new Error(String(res.status));
  return Number((res.headers.get("content-range") || "").split("/")[1]) || 0;
}
/** admin.js paintNav(): fills #approvalsBadge, owner only, 20 s cache. Hidden
    while the owner check can't answer; the next paint asks again. */
export async function refreshApprovalsBadge() {
  const el = document.getElementById("approvalsBadge");
  if (!el || !SYNC_ENABLED || !isSignedIn()) return;
  if (Date.now() - badgeCache.at < 20_000 && badgeCache.who === currentEmail()) { paintBadge(el, badgeCache.n); return; }
  if ((await ownerCheck()) !== true) {
    const cur = document.getElementById("approvalsBadge");     // paintNav may have repainted meanwhile
    if (cur) paintBadge(cur, 0);
    return;
  }
  const at = enc(new Date().toISOString());
  const [t, s] = await Promise.allSettled([
    count(`pending_actions?select=id&status=eq.pending&expires_at=gt.${at}`),
    count(`proposals?select=id&status=eq.proposed&expires_at=gt.${at}`),
  ]);
  if (t.status === "rejected" && s.status === "rejected") return;     // offline: leave whatever it shows
  setBadge((t.value || 0) + (s.value || 0));
}

/* ---------- the page ---------- */
let seq = 0;
/* card key → "approve" | "decline": the answers in flight. Each card latches
   on its own (its buttons off, the pressed one saying so) and the others stay
   usable; no refresh repaints while any is out. */
const inflight = new Map();
let epoch = 0;                   // bumps on every answer; a refresh that started before one drops its paint
let timer = null;
let onShow = null;               // the open page's refresh, for coming back to the tab
const notes = new Map();         // card key → { text, gone, declineOnly }: the error line under a card, kept across repaints
/* card key → when this tab first saw that text-queue row at 'approved'. For a
   few minutes it may be mid-run, not stuck (A.outcome); kept across
   refreshes and re-renders, brought up to date by A.sawApproved */
const seenApproved = new Map();
let lastTextRead = NaN;          // when the text queue last loaded: a longer gap restarts those sightings
let bulk = null;                 // "Approve all QuickBooks cards" while it runs: { at, of }
/* card key → the card as this tab's own answer settled it (Sent, Declined,
   Failed: …). A send whose executed stamp didn't land leaves the server row
   at 'approved', and the refresh that rebuilds the card from it would turn a
   "Sent" this tab heard into "waiting", then "never reported back". Kept
   while the server row stays at 'approved', dropped once it moves on. */
const heard = new Map();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && onShow && !inflight.size) onShow();
});

/** admin.js route(): #/approvals lands here. */
export async function renderApprovals(view) {
  if (!location.hash.startsWith(HASH)) return;   // a late call after the office moved on
  const my = ++seq;
  const live = () => my === seq && location.hash.startsWith(HASH);
  clear(view).append(h("p", { class: "muted", style: "padding:20px 2px" }, "Loading approvals…"));
  if (!SYNC_ENABLED) {
    clear(view).append(h("div", { class: "atoolbar" }, h("h1", {}, "✅ Approvals")),
      h("p", { class: "muted" }, "Approvals need the cloud connection."));
    return;
  }
  const isOwner = await ownerCheck();
  if (!live()) return;
  const body = clear(view);
  const refreshBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "↻ Refresh");
  body.append(h("div", { class: "atoolbar" }, h("h1", {}, "✅ Approvals"), isOwner === true ? refreshBtn : null));
  if (isOwner === false) {
    body.append(h("p", { class: "muted" }, "Approvals belong to the owner's login."));
    return;
  }
  if (isOwner !== true) {
    // the check couldn't answer: say so, never "not yours"; Retry (or coming back to the tab) asks again
    const again = () => { if (live()) renderApprovals(view); };
    onShow = again;
    body.append(h("p", { class: "muted" }, likelyOffline()
        ? "You're offline. Approvals load when you're back online."
        : "Couldn't check your login just now."),
      h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: again }, "Retry"));
    return;
  }

  const page = h("div");
  const uis = new Map();          // card key → its waiting card on screen now (paint rebuilds them)
  body.append(h("p", { class: "ap-intro" },
    "Everything waiting on your yes. A card that says “or text YES 12” can also be answered by text; the first answer counts."), page);
  let state = await load(Date.now()).catch(() => ({ box: { waiting: [], recent: [], expired: 0, skipped: { text: 0, spine: 0 } },
    look: {}, warn: ["Approvals didn't load. Try again in a minute."], failed: true, textOk: false }));
  if (!live()) return;
  show();

  async function refresh() {
    if (inflight.size || !live()) return;
    const at = epoch;
    let next;
    try { next = await load(Date.now()); } catch { return; }
    if (!live() || inflight.size || at !== epoch) return;
    state = next;
    show();
  }
  refreshBtn.addEventListener("click", () => refresh());
  onShow = refresh;
  clearInterval(timer);
  timer = setInterval(() => {
    if (!live()) { clearInterval(timer); timer = null; return; }
    if (document.visibilityState === "visible") refresh();
  }, REFRESH_MS);

  function show() {
    // a card no longer waiting drops its error line; a "gone" line on a card
    // the server still lists as open gives the buttons back
    const open = new Set(state.box.waiting.map((c) => c.key));
    for (const [k, n] of notes) if (!open.has(k) || n.gone) notes.delete(k);
    // a text queue that didn't load says nothing about which rows are still 'approved'
    if (state.textOk) {
      A.sawApproved(seenApproved, state.box.recent, state.readAt, lastTextRead);
      lastTextRead = state.readAt;
      for (const k of [...heard.keys()]) if (!seenApproved.has(k)) heard.delete(k);
    }
    const { skipped } = state.box;
    if (!state.warn.length) setBadge(state.box.waiting.length + skipped.text + skipped.spine);
    paint();
  }

  function paint() {
    const now = Date.now();
    const { box } = state;
    uis.clear();
    const kids = state.warn.map((w) => h("div", { class: "warn" }, w));
    if (state.failed) {
      kids.push(h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => refresh() }, "Try again"));
      page.replaceChildren(...kids);
      return;
    }
    kids.push(h("h2", {}, "Waiting on you", box.waiting.length ? h("span", { class: "navbadge" }, String(box.waiting.length)) : null));
    // an ask that wouldn't make a card (console.warn names it) is still said out loud
    const skipped = A.skippedLine(box.skipped);
    if (skipped) kids.push(h("div", { class: "warn ap-skipped", role: "status" }, skipped));
    // the nightly QuickBooks match files one card per job: two or more can be answered in one go
    const qbo = box.waiting.filter((c) => c.kind === "qbo");
    if (qbo.length >= 2 || bulk) kids.push(approveAllBar(qbo));
    if (box.waiting.length) kids.push(...box.waiting.map((c) => waitingCard(c, now)));
    else if (!skipped) kids.push(h("p", { class: "muted ap-none" }, "Nothing is waiting on you."));
    const gone = A.expiredLine(box.expired);
    if (gone) kids.push(h("p", { class: "ap-expired" }, gone));
    kids.push(h("h2", {}, "Recently decided"));
    if (box.recent.length) kids.push(...box.recent.map((c) => recentCard(c, now)));
    else kids.push(h("p", { class: "muted ap-none" }, "Nothing answered in the last 48 hours."));
    page.replaceChildren(...kids);
  }

  function waitingCard(c, now) {
    const note = notes.get(c.key);
    const approve = h("button", { type: "button", class: "btn btn--primary btn--sm" }, c.approveLabel);
    const decline = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Decline");
    const err = h("div", { class: "warn ap-err", role: "alert", hidden: !note }, note ? note.text : "");
    const ui = {
      // its answer is out: both off, the pressed one says so
      working: (decision) => {
        approve.disabled = decline.disabled = true;
        (decision === "approve" ? approve : decline).textContent = "Working…";
      },
      // settled: the labels back; both off if the ask is gone, Approve alone if only Decline can answer it
      idle: (n) => {
        approve.textContent = c.approveLabel; decline.textContent = "Decline";
        approve.disabled = !!(n && (n.gone || n.declineOnly)); decline.disabled = !!(n && n.gone);
      },
      note: (t) => { err.textContent = t; err.hidden = !t; },
    };
    uis.set(c.key, ui);
    if (inflight.has(c.key)) ui.working(inflight.get(c.key));
    else ui.idle(note);
    approve.addEventListener("click", () => decide(c, "approve"));
    decline.addEventListener("click", () => decide(c, "decline"));
    return h("div", { class: "card ap-card", dataset: { key: c.key } },
      head(c),
      meta(c.job, c.by && "from " + c.by, "asked " + A.akTime(c.createdAt, now), A.expiresIn(c.expiresAt, now)),
      evidence(c),
      // what approving does while the worker isn't sending email, read before the tap
      c.laneHint ? h("div", { class: "ap-lane", role: "note" }, c.laneHint) : null,
      h("div", { class: "ap-actions" }, approve, decline, c.yesHint ? h("span", { class: "ap-yes" }, c.yesHint) : null),
      err);
  }

  /* "Approve all QuickBooks cards (N)": one confirm for all of them, then
     each card in turn (soonest expiry first) through the very call its own
     Approve makes, with that card's buttons showing Working… as usual. It
     stops at the first one that doesn't go through, a refusal or a card
     the executor failed (the receipts changed since filing, say): that card
     says why, the rest stay waiting, and the page reads where things stand. */
  function approveAllBar(cards) {
    const label = bulk ? `Approving ${bulk.at} of ${bulk.of}…` : `Approve all QuickBooks cards (${cards.length})`;
    const all = h("button", { type: "button", class: "btn btn--primary btn--sm", disabled: !!bulk }, label);
    all.addEventListener("click", () => approveAll(cards));
    return h("div", { class: "ap-bulk" }, all);
  }
  async function approveAll(cards) {
    if (bulk || !cards.length) return;
    const n = cards.reduce((k, c) => k + (Array.isArray(c.evidence.receipts) ? c.evidence.receipts.length : 0), 0);
    const jobs = new Set(cards.map((c) => c.jobId || c.key)).size;
    if (!confirm(`Update QuickBooks for all ${cards.length} cards: ${n} ${n === 1 ? "receipt" : "receipts"} on ${jobs} ${jobs === 1 ? "job" : "jobs"}? ` +
      "Each card is approved in turn, and it stops at the first one that doesn't go through.")) return;
    bulk = { at: 0, of: cards.length };
    let stopped = false, done = 0;
    try {
      for (const c of cards) {
        if (!live()) { stopped = true; break; }
        // answered meanwhile (another tap, a refresh): nothing left to approve on it
        if (!state.box.waiting.some((w) => w.key === c.key)) continue;
        bulk.at++;
        paint();
        const ok = await decide(c, "approve", true);
        if (ok === false) { stopped = true; break; }
        if (ok) done++;
      }
    } finally { bulk = null; }
    if (!live()) return;
    toast(stopped ? `Stopped after ${done} of ${cards.length}: one didn't go through, and the rest are still waiting.`
      : `Approved ${done} QuickBooks ${done === 1 ? "card" : "cards"}.`);
    paint();
    refresh();
  }

  /* Approve: one confirm naming the action (asked: the Approve-all confirm
     already covered it). Decline: a confirm on the text queue, a prompt for
     an optional reason on the spine (op_proposal_decline keeps it). While it
     runs that card's buttons are off, the other cards stay usable, and no
     refresh repaints. Another card's answer can repaint the page meanwhile,
     so the card is found again (uis) when this one lands. Returns true when
     the answer landed and the ask didn't fail, false when it didn't, and
     null when nothing was sent (already out, or not confirmed). */
  async function decide(c, decision, asked = false) {
    if (inflight.has(c.key)) return null;
    let reason = "";
    if (decision === "approve") { if (!asked && !confirm(A.approveConfirm(c))) return null; }
    else if (c.lane === "text") { if (!confirm(A.declineConfirm(c))) return null; }
    else {
      const r = prompt(A.declinePrompt(c), "");
      if (r === null) return null;
      reason = r;
    }
    inflight.set(c.key, decision); epoch++;
    notes.delete(c.key);
    const ui0 = uis.get(c.key);
    if (ui0) { ui0.working(decision); ui0.note(""); }
    const req = A.decisionRequest(c, decision, reason);
    let res = null, b = null;
    try {
      res = req.fn ? await callFunction(req.fn, req.body)
        : await rest("rpc/" + req.rpc, { method: "POST", body: JSON.stringify(req.body) });
      b = await res.json().catch(() => null);
    } catch { /* no answer at all */ } finally { inflight.delete(c.key); }
    badgeCache.at = 0;
    refreshApprovalsBadge();
    const ans = !res ? { ok: false, error: isSignedIn() ? A.NO_CONNECTION : A.SIGNED_OUT }
      : c.lane === "text" ? A.pendingAnswer(res.status, b, c, decision) : A.spineAnswer(res.status, b);
    let landed = false;
    if (ans.ok) {
      const done = c.lane === "text" ? A.decidedText(c, ans) : A.fromProposal(ans.row, state.look);
      if (c.lane === "text" && done.status !== "approved") heard.set(c.key, done);
      state = { ...state, box: A.settle(state.box, c, done) };
      toast(A.outcome(done).text);
      landed = done.status !== "failed";
    } else {
      notes.set(c.key, { text: ans.error, gone: !!ans.gone, declineOnly: !!ans.declineOnly });
    }
    // the office moved off this page while it was out; if it came back, that page reads where things stand
    if (!live()) { if (onShow) onShow(); return landed; }
    const ui = !ans.ok && uis.get(c.key);
    if (ui) { ui.idle(notes.get(c.key)); ui.note(ans.error); }
    else paint();
    return landed;
  }
}

/* ---------- card parts ---------- */
const meta = (...parts) => h("div", { class: "ap-meta" }, parts.filter(Boolean).join(" · "));
const head = (c) => h("div", { class: "ap-head" },
  h("span", { class: "badge " + tone(c.kind) }, c.chip),
  h("strong", { class: "ap-title" }, c.title));
const kv = (k, v) => (v ? h("div", { class: "ap-kv" }, h("span", { class: "ap-k" }, k), h("span", { class: "ap-v" }, v)) : null);

/* a link's label is the proposer's words, so where it really goes comes
   first, in its own bold element the label can't reach: "opens
   evil.example — Invoice" (A.labelOf drops a host the label claims) */
const refItem = (r) => h("li", {},
  r.url ? [h("span", { class: "ap-host" }, "opens " + r.host), " — ",
    h("a", { href: r.url, target: "_blank", rel: "noopener noreferrer" }, r.text)] : r.text);
const refList = (refs, cls = "ap-refs") => (Array.isArray(refs) && refs.length ? h("ul", { class: cls }, ...refs.map(refItem)) : null);

/* what would happen, in full: the whole email, the whole text, the phase,
   every invoice line (the body is never clamped, so nothing he approves is
   out of sight) */
function evidence(c) {
  const e = c.evidence;
  const parts = [];
  if (c.kind === "email") {
    parts.push(kv("To", e.to), kv("Cc", e.cc), kv("Subject", e.subject),
      e.body ? h("div", { class: "ap-mail" }, e.body) : null);
  } else if (c.kind === "text") {
    parts.push(kv("To", e.to), e.message ? h("div", { class: "ap-mail" }, e.message) : null);
  } else if (c.kind === "phase") {
    parts.push(kv("Phase", e.phase), kv("Hours", e.hours != null ? `${e.hours} h logged` : ""));
  } else if (c.kind === "stage") {
    parts.push(kv("Job", c.job || "a board job"), kv("New stage", e.stage));
  } else if (c.kind === "gaps") {
    // the nightly billing check: each line the new draft invoice would get,
    // with its figures ("no rate" when the job has none) and the records
    // behind it, the total of the priced lines, then what it noticed but
    // never adds. Every figure arrives as text from the field module.
    const lines = Array.isArray(e.lines) ? e.lines : [];
    const hints = Array.isArray(e.hints) ? e.hints : [];
    parts.push(kv("Adds", e.invoice),
      lines.length ? h("div", { class: "ap-kv" }, h("span", { class: "ap-k" }, "Lines"),
        h("ol", { class: "ap-v ap-lines" }, ...lines.map((l) => h("li", { class: "ap-line" },
          h("div", { class: "ap-line__what" }, l.text),
          h("div", { class: "ap-line__fig" + (l.priced ? "" : " ap-line__fig--open") }, l.figures),
          l.basis ? h("div", { class: "ap-line__why" }, l.basis) : null,
          refList(l.refs))))) : null,
      kv("Total", e.total),
      hints.length ? h("div", { class: "ap-kv" }, h("span", { class: "ap-k" }, "To check"),
        h("ul", { class: "ap-v ap-hints" }, ...hints.map((x) => h("li", {}, x.text, refList(x.refs))))) : null);
  } else if (c.kind === "qbo") {
    // the nightly QuickBooks match: the project link approving sets (the job
    // had none), then each receipt with the expense it matched and what that
    // expense gets, a job tag or the photo. Every line arrives as text from
    // the field module.
    const receipts = Array.isArray(e.receipts) ? e.receipts : [];
    parts.push(kv("Project", e.link),
      receipts.length ? h("div", { class: "ap-kv" }, h("span", { class: "ap-k" }, "Receipts"),
        h("ol", { class: "ap-v ap-lines" }, ...receipts.map((x) => h("li", { class: "ap-line" }, x.text)))) : null);
  }
  parts.push(kv("Why", e.rationale));
  if (e.refs.length) {
    parts.push(h("div", { class: "ap-kv" }, h("span", { class: "ap-k" }, "Evidence"), refList(e.refs, "ap-v ap-refs")));
  }
  const shown = parts.filter(Boolean);
  return shown.length ? h("div", { class: "ap-ev" }, ...shown) : null;
}

function recentCard(c, now) {
  // a row this tab's own answer is still out on (the office came back to the
  // tab mid-answer) is running, not stuck
  // and one whose answer this tab heard reads as that answer, not as the stale row
  const mine = c.status === "approved" && heard.get(c.key);
  const shown = mine ? { ...c, status: mine.status, result: mine.result, error: mine.error, answeredHere: true }
    : inflight.has(c.key) ? { ...c, answeredHere: true } : c;
  const o = A.outcome(shown, now, seenApproved.get(c.key));
  return h("div", { class: "card ap-card ap-card--done", dataset: { key: c.key } },
    head(c),
    h("div", { class: "ap-out ap-out--" + o.tone }, o.text),
    meta(c.job, c.by && "from " + c.by,
      c.answeredAt ? "answered " + A.akTime(c.answeredAt, now) : "asked " + A.akTime(c.createdAt, now)));
}
