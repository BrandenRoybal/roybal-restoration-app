/* ============================================================
   Office Admin — 💬 company-number texting, office view
   ------------------------------------------------------------
   The durable message log lives in sms_messages (written by the
   roybal-notify edge function: outbound sends AND the customer
   replies the Twilio webhook records). This panel shows the latest
   conversations grouped by customer number so the office sees both
   sides without opening Twilio. Forward copies (kind='forward',
   the relay to the owner's cell) are excluded — they duplicate the
   inbound row. Online-only; renders nothing if the fetch fails.
   ============================================================ */
import { h, fmtDate, Store } from "../../js/core.js";
import { SYNC_ENABLED } from "../../js/config.js";
import { rest } from "../../js/supa.js";

const digits10 = (n) => String(n || "").replace(/[^\d]/g, "").slice(-10);
const fresh = (iso) => Date.now() - new Date(iso || 0).getTime() < 48 * 3600 * 1000;

/* Postgres timestamps are UTC — render LOCAL time, or an evening Fairbanks
   reply shows tomorrow's date at a 00:xx hour and looks like the future. */
function localWhen(iso) {
  const d = new Date(iso || "");
  if (isNaN(d)) return "";
  const day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  return fmtDate(day) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function msgRow(m) {
  const inbound = m.direction === "inbound";
  const when = localWhen(m.created_at);
  return h("div", {
    style: "padding:5px 8px;border-bottom:1px solid var(--line,#e2e6ec);font-size:13px" +
      (inbound ? ";background:rgba(242,106,33,.08);border-left:3px solid #f26a21" : ""),
  },
    h("div", {},
      h("strong", {}, inbound ? "← reply" : "→ " + (m.kind === "onOurWay" ? "on our way" : m.kind === "fieldReport" ? "field report" : "text")),
      h("span", { class: "muted", style: "font-size:12px" },
        "  " + when + (inbound ? "" : m.status === "failed" ? " · failed" : " · " + (m.status || "sent")) +
        (m.sent_by && !inbound ? " · " + m.sent_by : "")),
      inbound && fresh(m.created_at) ? h("span", { class: "badge cat3", style: "margin-left:8px" }, "new") : null),
    m.body ? h("div", { class: "muted", style: "font-size:12px" }, String(m.body).slice(0, 160)) : null);
}

/** Latest company-number conversations, grouped by customer number. */
export function messagesPanel() {
  const box = h("div");
  if (!SYNC_ENABLED) return box;
  (async () => {
    try {
      const res = await rest(
        "sms_messages?select=created_at,direction,to_number,from_number,body,kind,status,sent_by" +
        "&kind=neq.forward&order=created_at.desc&limit=60", { method: "GET" });
      if (!res.ok) return;
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) return;

      // customer names from the shared local job store (same-origin IndexedDB)
      const projects = await Store.all().catch(() => []);
      const nameByPhone = new Map();
      for (const p of projects) {
        const d = digits10(p.phone);
        if (d && !nameByPhone.has(d)) nameByPhone.set(d, p.customer || p.address || "");
      }

      // group by the customer-side number (from on inbound, to on outbound)
      const groups = new Map();
      for (const m of rows) {
        const other = m.direction === "inbound" ? m.from_number : m.to_number;
        const key = digits10(other) || String(other || "?");
        if (!groups.has(key)) groups.set(key, { number: other || "", msgs: [] });
        groups.get(key).msgs.push(m);   // rows arrive newest-first
      }

      const unread = rows.filter((m) => m.direction === "inbound" && fresh(m.created_at)).length;
      const cards = [...groups.values()].slice(0, 8).map((g) => {
        const name = nameByPhone.get(digits10(g.number)) || "";
        return h("div", { style: "margin-top:10px" },
          h("div", { style: "font-weight:600;font-size:13px" },
            (name ? name + " · " : "") + (g.number || "unknown number")),
          ...g.msgs.slice(0, 3).map(msgRow));
      });

      box.append(h("div", { class: "card", style: "margin-top:14px" },
        h("div", { style: "font-weight:700" },
          "💬 Company texting" + (unread ? ` — ${unread} new repl${unread === 1 ? "y" : "ies"} (48h)` : "")),
        h("p", { class: "muted", style: "font-size:12px;margin:4px 0 0" },
          "Both sides of the toll-free number, newest first. Replies also appear on each job's Message log in the field app."),
        ...cards));
    } catch (_) { /* offline — panel simply doesn't render */ }
  })();
  return box;
}
