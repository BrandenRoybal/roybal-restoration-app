/* ============================================================
   Office Admin — 👥 Contacts (CRM step 5, docs/CRM_Design.md §7)
   ------------------------------------------------------------
   Two surfaces over the contacts spine (migrations 228/229):
     • contactsPanel()      — a dashboard card: search + recent people
     • renderContactPage()  — the person's page: identity, their jobs,
                              the unified timeline, and merge review.
   Online-only; every fetch degrades quietly (the messagesPanel rule).
   All reads/writes ride the shared authenticated session via rest().
   ============================================================ */
import { h, clear, fmtDate, Store } from "../../js/core.js";
import { SYNC_ENABLED } from "../../js/config.js";
import { rest } from "../../js/supa.js";

const FIELD_ROOT = location.pathname.replace(/\/admin\/?.*$/, "/") || "/";
const goContact = (id) => { location.hash = "#/c/" + id; };
const initials = (n) => (n || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString();
const digits = (p) => String(p || "").replace(/[^\d+]/g, "");

const ROLES = ["customer", "adjuster", "agent", "property_manager", "sub", "other"];
const LANES = { sms: "💬", email: "📧", portal: "🌐", call: "📞" };

/* Postgres timestamps are UTC — render local, like messages.js. */
function localWhen(iso) {
  const d = new Date(iso || "");
  if (isNaN(d)) return "";
  const day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  return fmtDate(day) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

const q = (s) => encodeURIComponent(s);

/* ---------- dashboard panel ---------- */
export function contactsPanel() {
  const box = h("div");
  if (!SYNC_ENABLED) return box;
  const card = h("div", { class: "card", style: "margin-top:14px" });
  const search = h("input", { type: "search", placeholder: "Search people — name, phone, email…" });
  const list = h("div", { style: "margin-top:8px" });
  card.append(
    h("div", { style: "font-weight:700" }, "👥 Contacts"),
    h("p", { class: "muted", style: "font-size:12px;margin:4px 0 8px" },
      "Everyone you've worked with — customers and adjusters. Click a person to open their page."),
    search, list);

  let timer = null;
  async function paint(term) {
    // commas/parens are PostgREST or= syntax — strip them from user input
    const t = (term || "").trim().replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
    // recent when empty; a name/phone/email search otherwise
    let path = "contacts?merged_into=is.null&select=id,name,role,phone,email,company&order=updated_at.desc&limit=8";
    if (t) {
      const digitsOnly = t.replace(/[^\d]/g, "");
      const ors = [`name.ilike.*${t}*`, `email.ilike.*${t}*`];
      if (digitsOnly.length >= 3) ors.push(`phone_norm.ilike.*${digitsOnly.slice(-10)}*`);
      path = `contacts?merged_into=is.null&or=(${ors.join(",")})&select=id,name,role,phone,email,company&order=name.asc&limit=12`;
    }
    try {
      const res = await rest(path.replace(/\*/g, "%2A"), { method: "GET" });
      if (!res.ok) return;
      const rows = await res.json();
      clear(list);
      if (!rows.length) { list.append(h("div", { class: "muted", style: "font-size:13px;padding:6px 2px" }, t ? "No one matches." : "No contacts yet.")); return; }
      for (const c of rows) list.append(contactRow(c));
    } catch (_) { /* offline — leave the last render */ }
  }
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => paint(search.value), 180); });

  box.append(card);
  paint("");   // seed with recents; renders nothing on failure (card stays with search)
  return box;
}

function contactRow(c) {
  return h("div", {
    style: "display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--line,#e2e6ec);cursor:pointer",
    onclick: () => goContact(c.id),
  },
    h("span", { class: "cav" }, initials(c.name)),
    h("div", { style: "min-width:0;flex:1" },
      h("div", { style: "font-weight:600;font-size:13px" }, c.name || "—",
        c.role && c.role !== "customer" ? h("span", { class: "badge", style: "margin-left:6px" }, c.role.replace("_", " ")) : null),
      h("div", { class: "muted", style: "font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" },
        [c.company, c.phone, c.email].filter(Boolean).join(" · ") || "—")));
}

/* ---------- the contact page (#/c/:id) ---------- */
export async function renderContactPage(view, id) {
  const body = clear(view);
  body.append(h("div", { class: "atoolbar" },
    h("a", { class: "btn btn--ghost btn--sm", href: "#", onclick: (e) => { e.preventDefault(); location.hash = ""; } }, "‹ Back to jobs")));
  const host = h("div"); body.append(host);
  host.append(h("p", { class: "muted" }, "Loading…"));

  let contact, spine = [], board = [], timeline = [], suggestions = [], others = {};
  try {
    const [rc, ru, rb, rt, rs] = await Promise.all([
      rest(`contacts?id=eq.${id}&select=id,kind,role,name,company,phone,email,address,qbo_customer_id,source,notes,marketing_opt_in,merged_into&limit=1`, { method: "GET" }),
      rest(`unified_jobs?contact_id=eq.${id}&select=id,owner_name,property_address,status,loss_type,claim_number,field_project_id&order=created_at.desc`, { method: "GET" }),
      rest(`coordination_jobs?deleted=eq.false&data->>contactId=eq.${id}&select=id,data`, { method: "GET" }),
      rest(`contact_timeline?contact_id=eq.${id}&select=lane,at,direction,body,ref&order=at.desc&limit=120`, { method: "GET" }),
      rest(`contact_merge_suggestions?status=eq.open&or=(contact_a.eq.${id},contact_b.eq.${id})&select=id,contact_a,contact_b,reason,detail`, { method: "GET" }),
    ]);
    contact = rc.ok ? (await rc.json())[0] : null;
    spine = ru.ok ? await ru.json() : [];
    board = rb.ok ? await rb.json() : [];
    timeline = rt.ok ? await rt.json() : [];
    suggestions = rs.ok ? await rs.json() : [];
    const otherIds = [...new Set(suggestions.map((s) => (s.contact_a === id ? s.contact_b : s.contact_a)).filter(Boolean))];
    if (otherIds.length) {
      const ro = await rest(`contacts?id=in.(${otherIds.join(",")})&select=id,name,phone,email,role`, { method: "GET" });
      if (ro.ok) for (const o of await ro.json()) others[o.id] = o;
    }
  } catch (_) { /* fall through to the error state */ }

  clear(host);
  if (!contact) { host.append(h("div", { class: "card" }, h("p", { class: "muted" }, "Couldn't load this contact — check your connection and try again."))); return; }
  if (contact.merged_into) host.append(h("div", { class: "warn" }, "This contact was merged into another. ",
    h("a", { href: "#/c/" + contact.merged_into }, "Open the surviving contact →")));

  host.append(mergeBanner(id, suggestions, others));
  host.append(identityCard(contact));
  host.append(statRow(contact, spine, board, timeline));
  host.append(jobsCard(spine, board));
  host.append(timelineCard(timeline));
}

function mergeBanner(id, suggestions, others) {
  const wrap = h("div");
  for (const s of suggestions) {
    const pair = !!s.contact_b;
    const otherId = s.contact_a === id ? s.contact_b : s.contact_a;
    const other = others[otherId];
    const card = h("div", { class: "card mergecard" });
    const dismiss = h("button", { class: "btn btn--ghost btn--sm" }, "Not a match");
    dismiss.addEventListener("click", async () => {
      dismiss.disabled = true;
      await rest(`contact_merge_suggestions?id=eq.${s.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "dismissed", resolved_at: new Date().toISOString() }) }).catch(() => {});
      card.remove();
    });
    if (pair && other) {
      const merge = h("button", { class: "btn btn--primary btn--sm" }, "Merge — same person");
      merge.addEventListener("click", async () => {
        if (!confirm(`Merge "${other.name}" into this contact?\n\nEverything linked to them — jobs, texts, emails — moves here, and the duplicate is retired. This can't be undone from the app.`)) return;
        merge.disabled = true; merge.textContent = "Merging…";
        try {
          const res = await rest("rpc/contact_merge", { method: "POST", body: JSON.stringify({ p_winner: id, p_loser: otherId }) });
          const ok = res.ok && (await res.json()) === true;
          if (ok) { location.hash = ""; setTimeout(() => location.hash = "#/c/" + id, 20); }   // reload the page
          else { merge.disabled = false; merge.textContent = "Merge — same person"; alert("Merge was refused (office role required)."); }
        } catch { merge.disabled = false; merge.textContent = "Merge — same person"; }
      });
      card.append(
        h("div", { style: "font-weight:700" }, "⚠ Possible duplicate"),
        h("p", { class: "muted", style: "font-size:13px;margin:4px 0 8px" },
          `Matched by ${s.reason === "email" ? "email" : s.reason === "name-address" ? "name + address" : s.reason}: `,
          h("strong", {}, other.name || "another contact"),
          other.phone || other.email ? ` · ${[other.phone, other.email].filter(Boolean).join(" · ")}` : ""),
        h("div", { style: "display:flex;gap:8px" }, merge, dismiss));
    } else {
      // a field-change proposal (untrusted-fill / conflict) — informational
      const d = s.detail || {};
      const desc = s.reason === "conflict" ? "A different value came in on another channel." : "A public lead offered new contact info.";
      card.append(
        h("div", { style: "font-weight:700" }, "ℹ Review suggested"),
        h("p", { class: "muted", style: "font-size:13px;margin:4px 0 8px" }, desc + " ",
          h("code", { style: "font-size:12px" }, JSON.stringify(d).slice(0, 160))),
        h("div", {}, dismiss));
    }
    wrap.append(card);
  }
  return wrap;
}

function identityCard(c) {
  const card = h("div", { class: "card contactcard" });
  const view = h("div");
  const paintView = () => {
    clear(view);
    view.append(
      h("div", { class: "chead" },
        h("span", { class: "cav cav--lg" }, initials(c.name)),
        h("div", { style: "flex:1;min-width:0" },
          h("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap" },
            h("h1", { style: "font-size:20px;margin:0" }, c.name || "—"),
            h("span", { class: "badge" }, (c.role || "customer").replace("_", " ")),
            c.marketing_opt_in ? h("span", { class: "badge", style: "background:#e3f6ec;color:#1f7a45" }, "marketing ✓") : null),
          c.company ? h("div", { class: "muted", style: "font-size:13px" }, c.company) : null),
        h("button", { class: "btn btn--ghost btn--sm", onclick: () => paintEdit() }, "Edit")),
      h("div", { class: "crows" },
        row("Phone", c.phone ? h("a", { href: "tel:" + digits(c.phone) }, c.phone) : "—"),
        row("Email", c.email ? h("a", { href: "mailto:" + c.email }, c.email) : "—"),
        row("Address", c.address || "—"),
        row("Source", c.source || "—"),
        c.qbo_customer_id ? row("QuickBooks", "linked") : null,
        c.notes ? row("Notes", c.notes) : null));
  };
  const paintEdit = () => {
    clear(view);
    const f = {};
    const fld = (label, key, attrs) => { f[key] = h("input", { value: c[key] || "", ...attrs }); return h("div", { class: "field" }, h("label", {}, label), f[key]); };
    const roleSel = h("select", {}, ...ROLES.map((r) => h("option", { value: r, selected: (c.role || "customer") === r }, r.replace("_", " "))));
    const notes = h("textarea", { rows: "2" }, c.notes || "");
    const optIn = h("input", { type: "checkbox", checked: !!c.marketing_opt_in });
    const err = h("div", { class: "warn", hidden: true });
    const save = h("button", { class: "btn btn--primary btn--sm" }, "Save");
    const cancel = h("button", { class: "btn btn--ghost btn--sm", onclick: () => paintView() }, "Cancel");
    save.addEventListener("click", async () => {
      const patch = { name: f.name.value.trim() || c.name, company: f.company.value.trim(), role: roleSel.value,
        phone: f.phone.value.trim(), email: f.email.value.trim(), address: f.address.value.trim(),
        notes: notes.value.trim(), marketing_opt_in: optIn.checked };
      save.disabled = true;
      try {
        const res = await rest(`contacts?id=eq.${c.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
        if (!res.ok) throw new Error(await res.text());
        Object.assign(c, (await res.json())[0] || patch);
        paintView();
      } catch (e) { err.hidden = false; err.textContent = "Couldn't save — " + String(e.message || e).slice(0, 120); save.disabled = false; }
    });
    view.append(err,
      h("div", { class: "grid2" }, fld("Name", "name"), h("div", { class: "field" }, h("label", {}, "Role"), roleSel)),
      h("div", { class: "grid2" }, fld("Phone", "phone", { type: "tel" }), fld("Email", "email", { type: "email" })),
      fld("Company", "company"), fld("Address", "address"),
      h("div", { class: "field" }, h("label", {}, "Notes"), notes),
      h("label", { class: "optin" }, optIn, h("span", {}, " Opted in to marketing / seasonal outreach")),
      h("div", { style: "display:flex;gap:8px;margin-top:8px" }, save, cancel));
  };
  paintView();
  card.append(view);
  return card;
}

const row = (k, v) => h("div", { class: "crow" }, h("span", { class: "crow__k" }, k), h("span", { class: "crow__v" }, v));

function statRow(contact, spine, board, timeline) {
  const jobsN = spine.length + board.length;
  const contracted = board.reduce((s, b) => s + (Number(b.data && b.data.contractValue) || 0), 0);
  const est = board.reduce((s, b) => s + (Number(b.data && b.data.estValue) || 0), 0);
  return h("div", { class: "cstats" },
    stat(String(jobsN), "Jobs"),
    stat(String(timeline.length), "Interactions"),
    stat(contracted ? money(contracted) : est ? money(est) + " est" : "—", "Value"));
}
const stat = (v, k) => h("div", { class: "cstat" }, h("div", { class: "cstat__v" }, v), h("div", { class: "cstat__k" }, k));

function jobsCard(spine, board) {
  const card = h("div", { class: "card" });
  card.append(h("div", { style: "font-weight:700;margin-bottom:6px" }, "Jobs & leads"));
  if (!spine.length && !board.length) { card.append(h("p", { class: "muted", style: "font-size:13px" }, "No jobs linked yet.")); return card; }
  for (const j of spine) {
    card.append(h("div", { class: "jrow", onclick: () => { location.href = FIELD_ROOT + "#/p/" + (j.field_project_id || j.id); } },
      h("div", {}, h("strong", {}, j.owner_name || j.property_address || "Field job"),
        h("div", { class: "muted", style: "font-size:12px" }, [j.property_address, j.loss_type, j.claim_number ? "claim " + j.claim_number : ""].filter(Boolean).join(" · ") || "—")),
      h("span", { class: "badge" }, j.status || "field")));
  }
  for (const b of board) {
    const d = b.data || {};
    const lost = d.outcome === "lost";
    card.append(h("div", { class: "jrow", onclick: () => { location.href = FIELD_ROOT + "board/"; } },
      h("div", {}, h("strong", {}, d.title || d.customer || "Board job"),
        h("div", { class: "muted", style: "font-size:12px" }, [d.address, d.type].filter(Boolean).join(" · ") || "—")),
      h("span", { class: "badge", style: lost ? "background:#fbe3e0;color:#c0392b" : "" }, lost ? "lost" : (d.stage || "board").replace("_", " "))));
  }
  return card;
}

function timelineCard(timeline) {
  const card = h("div", { class: "card" });
  card.append(h("div", { style: "font-weight:700;margin-bottom:6px" }, "Timeline"),
    h("p", { class: "muted", style: "font-size:12px;margin:0 0 6px" }, "Every text, email, portal message, and call, newest first."));
  if (!timeline.length) { card.append(h("p", { class: "muted", style: "font-size:13px" }, "No messages or calls yet.")); return card; }
  for (const t of timeline) {
    const inbound = t.direction === "in";
    card.append(h("div", { class: "tlrow" + (inbound ? " tlrow--in" : "") },
      h("span", { class: "tlicon" }, LANES[t.lane] || "•"),
      h("div", { style: "flex:1;min-width:0" },
        h("div", { style: "font-size:12px" }, h("strong", {}, (inbound ? "← " : "→ ") + t.lane),
          h("span", { class: "muted" }, "  " + localWhen(t.at))),
        t.body ? h("div", { class: "muted", style: "font-size:12px" }, String(t.body).slice(0, 200)) : null)));
  }
  return card;
}
