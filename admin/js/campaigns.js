/* ============================================================
   Roybal Admin — CF-5 Campaigns: the human-approved send surface

   Segments are honest at this shop's scale: the opted-in roster IS
   the segment — a checkbox list the office curates by eye before
   every send. One message (with {name} personalization), sent one
   recipient at a time through roybal-notify kind 'campaign', where
   EVERY send is re-gated server-side (consent re-checked, the
   campaign's own monthly cap, the shared reserve floor, quiet
   hours, and a per-tag duplicate refusal). This panel is the human
   approval the design doc requires; the gate is the law either way.

   The campaign record is the sms_messages log itself: every send
   carries captured_by = "campaign:<slug>", so past campaigns are an
   aggregation, and re-opening a title resumes it — recipients who
   already got that tag are unchecked and locked, so a partial send
   (budget stop, closed tab) finishes instead of repeating.

   Adversarially reviewed 2026-08-16; the fixes that matter:
   - a `sending` latch: nothing re-enables the send button mid-loop,
     and the roster/inputs freeze for the duration
   - campaignsBusy() exported — the dashboard's 45s sync repaint
     must NOT rebuild this panel mid-compose or mid-send
   - dials the contact's REAL phone field (phone_norm is a lookup
     key; its last-10 truncation turns a non-US number into some
     stranger's valid US number that passes every gate)
   - contacts sharing one number are excluded up front (the server's
     exactly-one-contact consent rule refuses them anyway)
   - honest arithmetic: sent / refused / not-attempted reported as
     three numbers, never blended
   ============================================================ */
import { h, clear, toast } from "../../js/core.js";
import { rest } from "../../js/supa.js";
import { sendViaCompany } from "../../js/sms.js";

const AK_HOUR = () => Number(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Anchorage", hour: "numeric", hourCycle: "h23",
}).format(new Date()));
const inSendWindow = () => { const hr = AK_HOUR(); return hr >= 7 && hr < 20; };
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";
const slugify = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "").slice(0, 40) || "untitled";
const personalize = (msg, c) => msg.replaceAll("{name}", firstName(c.name));
/* dialable = a US-shaped number in the REAL phone field (10 digits, or 11
   with a leading 1). phone_norm is for lookups only — never dial it. */
const usDialable = (raw) => {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length === 10 || (d.length === 11 && d.startsWith("1"));
};

/* the dashboard's sync repaint checks this before rebuilding panels — a
   composer full of curation (or a loop mid-send) must never be clobbered */
let busy = false;
export const campaignsBusy = () => busy;

export function campaignsPanel() {
  const body = h("div");
  const card = h("div", { class: "card" }, h("h2", {}, "📣 Campaigns"), body);

  async function summary() {
    busy = false;
    clear(body);
    body.append(h("p", { class: "subtle" }, "Loading…"));
    let audience = null, recent = null;
    try {
      [audience, recent] = await Promise.all([
        rest("contacts?marketing_opt_in=eq.true&merged_into=is.null&select=id,name,phone,phone_norm,role&order=name&limit=500",
          { method: "GET" }).then((r) => r.ok ? r.json() : null),
        rest("sms_messages?kind=eq.campaign&select=sent_by,status,created_at&order=created_at.desc&limit=1000",
          { method: "GET" }).then((r) => r.ok ? r.json() : null),
      ]);
    } catch { /* fall through to the error state */ }
    if (!Array.isArray(audience)) {
      clear(body);
      body.append(h("p", { class: "warn" }, "Couldn't load the audience — check the connection and reopen the dashboard."));
      return;
    }
    // contacts sharing one number can't pass the server's exactly-one-contact
    // consent rule — surface them as fix-first instead of letting sends fail
    const byNorm = new Map();
    for (const c of audience) if (c.phone_norm) byNorm.set(c.phone_norm, (byNorm.get(c.phone_norm) || 0) + 1);
    const sendable = audience.filter((c) => usDialable(c.phone) && byNorm.get(c.phone_norm) === 1);
    const shared = audience.filter((c) => c.phone_norm && byNorm.get(c.phone_norm) > 1).length;
    const unreachable = audience.length - sendable.length - shared;

    const groups = new Map();
    for (const m of (Array.isArray(recent) ? recent : [])) {
      const key = String(m.sent_by || "");
      if (!key.startsWith("campaign:")) continue;
      const g = groups.get(key) || { sent: 0, failed: 0, last: "" };
      m.status === "failed" ? g.failed++ : g.sent++;
      if (!g.last || m.created_at > g.last) g.last = m.created_at;
      groups.set(key, g);
    }

    clear(body);
    body.append(h("p", { class: "subtle" },
      `${sendable.length} customer${sendable.length === 1 ? "" : "s"} opted in and textable.`,
      shared ? ` ${shared} share a phone number with another contact — merge them in Contacts first.` : "",
      unreachable > 0 ? ` ${unreachable} opted in but have no textable US number.` : ""));
    if (!Array.isArray(recent)) body.append(h("p", { class: "subtle" }, "⚠ Campaign history didn't load — counts below may be missing."));
    if (groups.size) {
      // full history on the tab (doc §13.2) — with one-tap resume: Reopen
      // prefills the title so markAlreadySent locks everyone already texted
      const rows = [...groups.entries()].sort((a, b) => (b[1].last || "").localeCompare(a[1].last || ""));
      body.append(h("div", { class: "subtle", style: "font-size:12px;margin:6px 0 2px" }, "Campaign history"),
        ...rows.slice(0, 20).map(([key, g]) => {
          const reopen = sendable.length
            ? h("button", { class: "btn btn--ghost btn--sm", onclick: () => composer(sendable, key.slice(9)),
                title: "Reopen to finish or re-check this campaign — people already texted stay locked out" }, "Reopen")
            : null;
          return h("div", { style: "display:flex;align-items:center;gap:10px;font-size:13px;padding:3px 0" },
            h("div", { style: "flex:1;min-width:0" },
              h("strong", {}, key.slice(9)),
              ` — ${g.sent} sent${g.failed ? `, ${g.failed} refused/failed` : ""} · ${String(g.last).slice(0, 10)}`),
            reopen);
        }));
      if (rows.length > 20) body.append(h("p", { class: "subtle", style: "font-size:12px" }, `…and ${rows.length - 20} older.`));
    }
    // no dead controls: an audience of zero gets the explanation, not a
    // disabled-but-clickable-looking primary button ("I click, nothing happens")
    if (sendable.length) {
      const newBtn = h("button", { class: "btn btn--primary btn--sm" }, "＋ New campaign");
      newBtn.addEventListener("click", () => composer(sendable));
      body.append(h("div", { style: "margin-top:8px" }, newBtn));
    } else {
      body.append(h("p", { class: "subtle", style: "margin-top:6px" },
        "Nobody's opted in yet, so there's no one to text. Customers join from the ",
        h("strong", {}, "“Seasonal tips & reminders”"),
        " card on their portal page or the checkbox on the website's quote form — or open a ",
        h("a", { href: "#/", onclick: (e) => { e.preventDefault(); const s = document.querySelector("input[type=search]"); if (s) s.focus(); } }, "contact"),
        " and check “Opted in to marketing” after they've told you yes. This panel lights up the moment the first person is in."));
    }
  }

  function composer(sendable, prefillTitle) {
    busy = true;                 // survives the dashboard's 45s sync repaint
    let sending = false;
    clear(body);
    const boxes = new Map();     // contact.id -> { cb, c, badge }
    const roster = h("div", { style: "max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin:6px 0" },
      ...sendable.map((c) => {
        const cb = h("input", { type: "checkbox", checked: true });
        const badge = h("span", { class: "subtle", hidden: true, style: "font-size:11.5px" }, " · already texted in this campaign");
        boxes.set(c.id, { cb, c, badge });
        cb.addEventListener("change", refresh);
        return h("label", { style: "display:flex;gap:8px;align-items:center;font-size:14px;padding:2px 0" },
          cb, h("span", {}, c.name || c.phone), c.role && c.role !== "customer" ? h("span", { class: "subtle" }, ` · ${c.role}`) : null, badge);
      }));
    const title = h("input", { type: "text", placeholder: "Campaign name — e.g. Freeze-up prep 2026", maxlength: "60" });
    const msg = h("textarea", { rows: "4", maxlength: "480", placeholder: "Hi {name} — cold snap coming next week. Three things that prevent frozen pipes: … — Roybal Construction. Reply STOP to opt out." });
    const preview = h("p", { class: "subtle", style: "font-size:12.5px;white-space:pre-wrap" });
    const counter = h("span", { class: "subtle", style: "font-size:12px" });
    const windowWarn = h("p", { class: "warn", hidden: inSendWindow() },
      "⏰ It's outside 7am–8pm Alaska — every send would be refused by quiet hours. Come back in the window.");
    const status = h("p", { class: "subtle", role: "status" });
    const sendBtn = h("button", { class: "btn btn--primary btn--sm" }, "Review & send");
    const cancel = h("button", { class: "btn btn--ghost btn--sm" }, "Cancel");
    cancel.addEventListener("click", () => { if (!sending) summary(); });

    function selected() { return [...boxes.values()].filter((x) => x.cb.checked).map((x) => x.c); }
    function refresh() {
      if (sending) return;       // nothing re-enables the button mid-loop
      const n = selected().length;
      const first = selected()[0];
      counter.textContent = `${msg.value.length}/480 · ${n} recipient${n === 1 ? "" : "s"}`;
      preview.textContent = msg.value && first ? "Preview → " + personalize(msg.value, first) : "";
      sendBtn.disabled = !n || !msg.value.trim() || !title.value.trim() || !inSendWindow();
    }
    msg.addEventListener("input", refresh);

    /* Resume-not-repeat: when the title resolves to a tag that already has
       sends, those recipients uncheck and LOCK — a partial campaign (budget
       stop, closed tab, lost response) finishes with the leftovers only.
       The server refuses tag+number duplicates too; this is the polite copy. */
    let tagSeq = 0;
    async function markAlreadySent() {
      const mine = ++tagSeq;
      const tag = "campaign:" + slugify(title.value);
      let sentTo = new Set();
      try {
        const r = await rest(`sms_messages?kind=eq.campaign&sent_by=eq.${encodeURIComponent(tag)}&status=neq.failed&select=to_number&limit=1000`, { method: "GET" });
        if (r.ok) sentTo = new Set((await r.json()).map((m) => String(m.to_number || "").replace(/\D/g, "").slice(-10)));
      } catch { /* offline — the server duplicate gate still protects */ }
      if (mine !== tagSeq || sending) return;
      for (const { cb, c, badge } of boxes.values()) {
        const done = sentTo.has(String(c.phone_norm || ""));
        badge.hidden = !done;
        cb.disabled = done;
        if (done) cb.checked = false;
      }
      refresh();
    }
    title.addEventListener("input", refresh);
    title.addEventListener("change", markAlreadySent);

    // the quiet-hours gate must not go stale in an open composer (7:58pm →
    // 8:01pm); self-clears when the panel leaves the DOM
    const windowTick = setInterval(() => {
      if (!document.body.contains(card)) { clearInterval(windowTick); return; }
      windowWarn.hidden = inSendWindow();
      refresh();
    }, 30_000);

    sendBtn.addEventListener("click", async () => {
      if (sending) return;
      const list = selected();
      const text = msg.value.trim();
      const tag = "campaign:" + slugify(title.value);
      if (!list.length || !text) return;
      if (!confirm(`Send this to ${list.length} customer${list.length === 1 ? "" : "s"}?\n\n"${personalize(text, list[0])}"\n\nEach send is checked against consent, the campaign budget, and duplicates — refusals are reported, not retried.`)) return;
      sending = true;
      sendBtn.disabled = true; cancel.disabled = true; title.disabled = true; msg.disabled = true;
      for (const { cb } of boxes.values()) cb.disabled = true;
      let sent = 0, notAttempted = 0;
      const refused = [];
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        status.textContent = `Sending ${i + 1}/${list.length}…`;
        try {
          await sendViaCompany({ to: c.phone, body: personalize(text, c), kind: "campaign", by: tag });
          sent++;
        } catch (e) {
          refused.push(`${c.name || c.phone}: ${String(e && e.message || e).split(":")[0]}`);
          // a BUDGET/WINDOW refusal applies to every later send too — stop.
          // (campaign_duplicate and campaign_consent are per-person: keep going.)
          if (/campaign_cap_reached|campaign_reserve|sms_cap_reached|quiet_hours/.test(String(e && e.message))) {
            notAttempted = list.length - i - 1;
            break;
          }
        }
      }
      status.textContent = "";
      const bits = [`${sent} sent`];
      if (refused.length) bits.push(`${refused.length} refused`);
      if (notAttempted) bits.push(`${notAttempted} not attempted (stopped at the budget/window)`);
      toast(`Campaign: ${bits.join(" · ")}`, 6000);
      busy = false; sending = false;
      clear(body);
      body.append(...[
        h("p", {}, h("strong", {}, bits.join(" · "))),
        ...refused.map((r) => h("p", { class: "subtle", style: "font-size:12.5px" }, r)),
        notAttempted ? h("p", { class: "subtle" }, `Re-open a campaign with the SAME name to finish it — everyone already texted stays unchecked.`) : null,
        h("button", { class: "btn btn--ghost btn--sm", onclick: summary }, "Done"),
      ].filter(Boolean));   // DOM append() stringifies null — h() skips it, append doesn't
    });

    body.append(
      h("p", { class: "subtle" }, "Pick who, write it once — {name} becomes each person's first name. Every send re-checks consent, budget, and duplicates on the server."),
      roster,
      h("div", { class: "grid2" }, h("div", {}, title), h("div", {}, counter)),
      msg, preview, windowWarn, status,
      h("div", { class: "btn-row" }, sendBtn, cancel));
    // A Reopen from the history list: the tag is a slug and slugify() is
    // idempotent on slugs, so prefilling with it resolves to the SAME tag —
    // resume-not-repeat locks everyone already texted before the first click.
    if (prefillTitle) { title.value = prefillTitle; markAlreadySent(); }
    refresh();
  }

  summary();
  return card;
}
