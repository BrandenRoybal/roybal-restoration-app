/* ============================================================
   Office Admin — 📧 Job email (the brief's number, finally visible)
   ------------------------------------------------------------
   The morning brief has always counted "job emails waiting" with no
   UI anywhere to see them — the rows only fed the assistant. This
   card lists the unread job-matched inbound mail on Today, with
   per-email and mark-all read buttons. The gmail-proxy pull now
   also clears the flag on its own when a message was handled in
   Gmail (read/archived/deleted), so this card is for triage, not
   bookkeeping.
   Online-only; every fetch degrades quietly (the messagesPanel
   rule: render nothing rather than an error card).
   ============================================================ */
import { h, clear, Store, toast } from "../../js/core.js";
import { SYNC_ENABLED } from "../../js/config.js";
import { fetchUnreadEmails, markEmailRead } from "../../js/gmail.js";

const when = (iso) => String(iso || "").slice(0, 10);

export function emailsPanel() {
  const box = h("div");
  if (!SYNC_ENABLED) return box;
  const list = h("div", { style: "margin-top:8px" });
  const head = h("div", { style: "display:flex;align-items:center;gap:10px" },
    h("div", { style: "font-weight:700;flex:1" }, "📧 Job email waiting"));
  const card = h("div", { class: "card", style: "margin-top:14px" }, head,
    h("p", { class: "muted", style: "font-size:12px;margin:4px 0 0" },
      "Inbound mail matched to a job, not yet answered. Handle it in Gmail and it clears itself within 15 minutes — or mark it read here."),
    list);
  box.append(card);

  (async () => {
    let rows = [], projects = [];
    try {
      [rows, projects] = await Promise.all([fetchUnreadEmails(15), Store.all().catch(() => [])]);
    } catch (_) { box.replaceChildren(); return; }   // Gmail lane unreachable — no card, no error
    const jobName = (id) => {
      const p = projects.find((x) => x.id === id);
      return p ? (p.customer || p.address || "job") : "job";
    };
    clear(list);
    if (!rows.length) {
      list.append(h("p", { class: "muted", style: "font-size:13px;margin:6px 0 0" }, "Nothing waiting. 🎉"));
      return;
    }
    const allBtn = h("button", { class: "btn btn--ghost btn--sm" }, "Mark all read");
    allBtn.addEventListener("click", async () => {
      if (!confirm(`Mark all ${rows.length} waiting email${rows.length === 1 ? "" : "s"} as read? They stay in Gmail either way.`)) return;
      allBtn.disabled = true;
      let done = 0;
      for (const m of rows) { try { await markEmailRead(m.id); done++; } catch (_) { /* keep going */ } }
      toast(`${done} marked read`);
      clear(list);
      list.append(h("p", { class: "muted", style: "font-size:13px;margin:6px 0 0" }, "Nothing waiting. 🎉"));
    });
    head.append(allBtn);
    for (const m of rows) {
      const row = h("div", { class: "erow" });
      const read = h("button", { class: "btn btn--ghost btn--sm", title: "Stop counting this one — the email itself stays in Gmail" }, "✓ Read");
      read.addEventListener("click", async () => {
        read.disabled = true;
        try { await markEmailRead(m.id); row.remove(); }
        catch (_) { read.disabled = false; toast("Couldn't mark it — try again"); }
      });
      row.append(
        h("div", { style: "min-width:0;flex:1" },
          h("div", { style: "font-size:13px" },
            h("strong", {}, jobName(m.job_id)),
            h("span", { class: "muted" }, ` · ${m.from_addr || "?"} · ${when(m.received_at)}`)),
          h("div", { style: "font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, m.subject || "(no subject)"),
          m.body_text ? h("div", { class: "muted", style: "font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, String(m.body_text).slice(0, 160)) : null),
        read);
      list.append(row);
    }
  })();
  return box;
}
