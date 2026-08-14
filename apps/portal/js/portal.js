/* Roybal Customer Portal — read-only status page + message thread.
   Reads the share token from the URL (/j/<token>), asks the roybal-portal
   gateway for the curated slice, and renders status + milestones + photos +
   a two-way message thread with the office. No login: the token is the
   credential. */
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const app = document.getElementById("app");

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

function tokenFromUrl() {
  const m = location.pathname.match(/\/j\/([0-9a-f]{16,})/i);
  if (m) return m[1];
  const q = new URLSearchParams(location.search).get("t");
  return q && /^[0-9a-f]{16,}$/i.test(q) ? q : "";
}

async function callGateway(payload) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/roybal-portal`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) { const e = new Error(body.error || "load_failed"); e.status = res.status; throw e; }
  return body;
}

/* Every action takes a CRED — either {token} (a job link, Phase A) or
   {session, jobId} (a CF-1 account viewing one of its own jobs). The gateway
   resolves a session to the job's token server-side; this client never holds
   share tokens it wasn't opened with. */
const fetchView = (cred) => callGateway({ action: "view", ...cred });
const fetchThread = (cred) => callGateway({ action: "messages", ...cred });
const askConcierge = (cred, body) => callGateway({ action: "ask", ...cred, body });
const fetchSelections = (cred) => callGateway({ action: "selections", ...cred });
const respondSelection = (cred, selectionId, choice, note) =>
  callGateway({ action: "respondSelection", ...cred, selectionId, choice, note });
const submitSelections = (cred) => callGateway({ action: "submitSelections", ...cred });
const requestAccess = (cred) => callGateway({ action: "requestAccess", ...cred });
const verifyAccess = (cred, code) => callGateway({ action: "verifyAccess", ...cred, code });
const fetchProjects = (session) => callGateway({ action: "myProjects", session });
const warrantyRequest = (cred, note) => callGateway({ action: "warrantyRequest", ...cred, note });

const REVIEW_URL = "https://g.page/r/CSv3IUml4W9GEBM/review";

/* ---------- CF-1 account session (localStorage) ---------- */
const SESSION_KEY = "roybal-portal-session";
const storedSession = () => { try { return localStorage.getItem(SESSION_KEY) || ""; } catch { return ""; } };
const saveSession = (s) => { try { localStorage.setItem(SESSION_KEY, s); } catch { /* private mode */ } };
const clearSession = () => { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } };

function message(icon, title, sub) {
  app.replaceChildren(h("div", { class: "msg" },
    h("div", { class: "big" }, icon), h("h2", {}, title), sub ? h("p", {}, sub) : null));
}

/* pretty, terse timestamp for a message bubble */
function whenLabel(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return ""; }
}

/* ---------- message thread ---------- */
function renderThread(listEl, messages) {
  const bubbles = (messages || []).map((m) =>
    h("div", { class: "bubble bubble--" + (m.from === "you" ? "me" : "them") },
      h("div", { class: "bubble__body" }, m.body),
      h("div", { class: "bubble__meta" }, (m.from === "you" ? "You" : "Roybal Construction") + " · " + whenLabel(m.at))));
  if (!bubbles.length) {
    listEl.replaceChildren(h("p", { class: "thread__empty" },
      "Have a question about your project? Ask here — you'll get an answer right away, and anything that needs our team we'll follow up on personally."));
  } else {
    listEl.replaceChildren(...bubbles);
    listEl.scrollTop = listEl.scrollHeight;
  }
}

function threadCard(token) {
  const list = h("div", { class: "thread", id: "thread" },
    h("p", { class: "thread__empty" }, "Loading messages…"));
  const input = h("textarea", { class: "composer__input", rows: "1", placeholder: "Write a message…",
    "aria-label": "Write a message" });
  const btn = h("button", { class: "composer__send", type: "submit" }, "Send");
  const status = h("div", { class: "composer__status", role: "status" });

  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; };
  input.addEventListener("input", grow);

  const form = h("form", { class: "composer",
    onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      btn.disabled = true; status.textContent = "";
      // optimistic: show the question + a "typing" bubble immediately
      const typing = h("div", { class: "bubble bubble--them bubble--typing" },
        h("div", { class: "bubble__body" }, h("span", { class: "dots" }, h("i"), h("i"), h("i"))));
      list.append(h("div", { class: "bubble bubble--me" },
        h("div", { class: "bubble__body" }, text),
        h("div", { class: "bubble__meta" }, "You · just now")), typing);
      list.scrollTop = list.scrollHeight;
      input.value = ""; grow();
      try {
        await askConcierge(token, text);
        renderThread(list, (await fetchThread(token)).messages);
      } catch (err) {
        typing.remove();
        status.textContent = err.status === 429
          ? "You've sent a lot of messages — please give us a moment to reply."
          : "Couldn't send. Please try again, or call 907-371-9868.";
      } finally { btn.disabled = false; }
    } }, input, btn);

  // Enter sends, Shift+Enter makes a newline
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  const card = h("div", { class: "card" },
    h("p", { class: "sectitle" }, "Messages"), list, form, status);

  // load the thread
  fetchThread(token).then((r) => renderThread(list, r.messages)).catch(() => {
    list.replaceChildren(h("p", { class: "thread__empty" }, "Messages will appear here."));
  });
  return card;
}

/* ---------- selections ----------
   What we're putting back, room by room, with one decision to make on each:
   keep it, or say you'd like something different. There is no product
   catalog yet, so this deliberately does not pretend to be a shop — the
   honest job is to show people their own rooms and make it easy to raise a
   hand, which is the moment the conversation actually starts. */
function selectionsCard(token, sheet) {
  const card = h("div", { class: "card" });
  let state = sheet;
  let busy = false;
  // Sticky once true: changing an answer after sending clears submittedAt on
  // the server, and the button should then read "updated" rather than
  // pretending this is the first time.
  let everSubmitted = !!sheet.submittedAt;

  async function answer(sel, choice, note) {
    if (busy) return;
    busy = true; paint();
    try { state = await respondSelection(token, sel.id, choice, note || ""); }
    catch { /* keep the last good sheet; the row simply stays unanswered */ }
    busy = false; paint();
  }

  async function matchAll() {
    if (busy) return;
    busy = true; paint();
    for (const s of state.selections.filter((x) => !x.choice)) {
      try { state = await respondSelection(token, s.id, "match", ""); } catch { /* keep going */ }
    }
    busy = false; paint();
  }

  async function submit() {
    if (busy) return;
    busy = true; paint();
    try { state = { ...(await submitSelections(token)) }; everSubmitted = true; }
    catch { /* leave the sheet as-is; they can try again */ }
    busy = false; paint();
  }

  function row(sel) {
    const chosen = sel.choice;
    const where = sel.scope === "room" ? sel.room
      : sel.rooms.length > 3 ? `${sel.rooms.length} rooms` : sel.rooms.join(", ");
    const amount = sel.qty ? `${sel.qty} ${sel.unit}` : "";

    const keep = h("button", {
      class: "selbtn" + (chosen === "match" ? " selbtn--on" : ""),
      type: "button", disabled: busy, onclick: () => answer(sel, "match"),
    }, chosen === "match" ? "✓ Keeping this" : "Keep it");

    const change = h("button", {
      class: "selbtn" + (chosen === "change" ? " selbtn--want" : ""),
      type: "button", disabled: busy, onclick: () => answer(sel, "change", sel.note),
    }, chosen === "change" ? "✎ Let's talk about it" : "I'd like something different");

    const noteBox = chosen === "change" ? (() => {
      const ta = h("textarea", {
        class: "selnote", rows: "2", placeholder: "Anything you have in mind? (optional)",
        maxlength: "500",
      });
      ta.value = sel.note || "";
      ta.addEventListener("change", () => answer(sel, "change", ta.value));
      return ta;
    })() : null;

    return h("div", { class: "selrow" + (chosen ? " selrow--done" : "") },
      h("div", { class: "selrow__head" },
        h("div", {},
          h("div", { class: "selrow__t" }, sel.title),
          h("div", { class: "selrow__d" },
            [sel.what, amount, sel.scope !== "room" && where ? where : ""].filter(Boolean).join(" · "))),
      ),
      sel.alsoIncludes.length
        ? h("div", { class: "selrow__also" }, "Includes " + sel.alsoIncludes.join(", ").toLowerCase())
        : null,
      h("div", { class: "selrow__btns" }, keep, change),
      noteBox);
  }

  function paint() {
    const done = state.answered, total = state.total;
    const pct = total ? Math.round((done / total) * 100) : 0;

    const head = h("div", { class: "selhead" },
      h("div", { class: "ring", style: `--pct:${pct}` }, h("i", {}, `${done}/${total}`)),
      h("div", {},
        h("strong", {}, state.submittedAt ? "Thank you — we have your choices"
          : everSubmitted && state.complete ? "You've changed something — send it over"
            : state.complete ? "All set — ready to send"
              : `${state.remaining} ${state.remaining === 1 ? "choice" : "choices"} left`),
        h("span", {}, state.submittedAt
          ? "You can still change any of these — just send them again if you do."
          : "Nothing here costs you anything. Keeping what was there is covered by your insurance.")));

    const kids = [h("p", { class: "sectitle" }, "Your selections"), head];

    if (!state.submittedAt && done === 0 && total > 1) {
      kids.push(h("button", { class: "selall", type: "button", disabled: busy, onclick: matchAll },
        h("b", {}, "Put everything back the way it was"),
        h("span", {}, "One tap. Nothing extra on your bill.")));
    }

    kids.push(h("div", { class: "sellist" }, ...state.selections.map(row)));

    if (!state.submittedAt) {
      kids.push(h("button", {
        class: "selsubmit", type: "button", disabled: busy || !state.complete, onclick: submit,
      }, busy ? "Saving…"
        : !state.complete ? `${state.remaining} left to answer`
          : everSubmitted ? "Send my updated choices" : "Send my choices"));
    }
    card.replaceChildren(...kids.filter(Boolean));
  }

  paint();
  return card;
}

/* ---------- CF-1: save this job to an account ----------
   Shown only on a token link with no saved session. The code goes to the
   phone we already have on file — never one typed here. */
function accountCard(cred) {
  const card = h("div", { class: "card acct" });
  const start = h("button", { class: "acct__btn", type: "button" }, "Text me a code");
  const status = h("p", { class: "acct__status", role: "status" });
  const intro = () => card.replaceChildren(
    h("p", { class: "sectitle" }, "Keep this handy"),
    h("p", { class: "acct__p" }, "Save your projects to this phone — see every job, past and future, without keeping links."),
    start, status);
  start.addEventListener("click", async () => {
    start.disabled = true; status.textContent = "Sending…";
    try {
      const r = await requestAccess(cred);
      if (!r.sent) {
        status.textContent = r.reason === "try_later"
          ? "We've sent a few codes recently — try again in an hour."
          : "We can't set this up automatically — call us at 907-371-9868 and we'll sort it out.";
        start.disabled = false; return;
      }
      codeEntry(r.dest);
    } catch { status.textContent = "Couldn't send the code — try again in a moment."; start.disabled = false; }
  });
  function codeEntry(dest) {
    const code = h("input", { class: "acct__code", inputmode: "numeric", maxlength: "6", placeholder: "123456", "aria-label": "6-digit code" });
    const go = h("button", { class: "acct__btn", type: "button" }, "Verify");
    const st = h("p", { class: "acct__status", role: "status" });
    go.addEventListener("click", async () => {
      const v = code.value.replace(/\D/g, "");
      if (v.length !== 6) { st.textContent = "Enter the 6-digit code."; return; }
      go.disabled = true; st.textContent = "Checking…";
      try {
        const r = await verifyAccess(cred, v);
        if (r.verified && r.session) {
          saveSession(r.session);
          card.replaceChildren(h("p", { class: "sectitle" }, "Saved ✓"),
            h("p", { class: "acct__p" }, "Your projects now live at ",
              h("a", { href: "/" }, "portal.roybalconstruction.com"), " on this phone."));
        } else { st.textContent = "That code didn't match — check it and try again."; go.disabled = false; }
      } catch { st.textContent = "Couldn't verify — try again in a moment."; go.disabled = false; }
    });
    code.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
    card.replaceChildren(h("p", { class: "sectitle" }, "Enter your code"),
      h("p", { class: "acct__p" }, `We texted a 6-digit code to ${dest}. It expires in 10 minutes.`),
      h("div", { class: "acct__row" }, code, go), st);
    code.focus();
  }
  intro();
  return card;
}

/* ---------- CF-1: the "My projects" screen ---------- */
async function renderProjects(session) {
  message("⏳", "Loading your projects…");
  let r;
  try { r = await fetchProjects(session); }
  catch (e) {
    if (e.status === 404) { clearSession(); return message("🔒", "Signed out", "Open a project link we've sent you to sign back in."); }
    return message("⚠️", "Couldn't load your projects", "Please try again in a moment, or call 907-371-9868.");
  }
  const rows = (r.projects || []).map((p) => h("div", { class: "projrow", onclick: () => openProject(session, p.jobId) },
    h("div", {},
      h("div", { class: "projrow__t" }, p.address),
      h("div", { class: "projrow__s" }, [p.statusLabel, p.updated ? "updated " + p.updated : ""].filter(Boolean).join(" · ") || "—")),
    h("span", { class: "projrow__go" }, "›")));
  app.replaceChildren(
    h("div", { class: "card hero" }, h("h1", {}, "Your projects"),
      h("p", { class: "addr" }, rows.length ? "Everything we're doing (and have done) for you." : "No active projects right now — we're a call away when you need us.")),
    ...(rows.length ? [h("div", { class: "card" }, ...rows)] : []),
    h("p", { class: "acct__signout" }, h("a", { href: "#", onclick: (e) => { e.preventDefault(); clearSession(); location.href = "/"; } }, "Sign out on this phone")));
}

async function openProject(session, jobId) {
  const cred = { session, jobId };
  message("⏳", "Loading…");
  try {
    const [view, sheet] = await Promise.all([fetchView(cred), fetchSelections(cred).catch(() => null)]);
    render({ ...view, selections: sheet }, cred, { backToProjects: true });
  } catch {
    message("⚠️", "Couldn't load that project", "Please try again in a moment, or call 907-371-9868.");
  }
}

function render(data, token, opts) {
  const job = data.job || {};
  const badge = job.status
    ? h("span", { class: "statusbadge" }, h("span", { class: "dot" }),
        (job.milestones.find((m) => m.key === job.status)?.label) || currentLabel(job.milestones) || "In progress")
    : null;

  const hero = h("div", { class: "card hero" },
    h("h1", {}, job.customerName || "Your project"),
    job.address ? h("p", { class: "addr" }, job.address) : null,
    badge);

  const steps = (job.milestones || []).map((m) =>
    h("li", { class: "step step--" + (m.state || "upcoming") },
      h("div", { class: "step__rail" }, h("div", { class: "step__dot" }, m.state === "done" ? "✓" : m.state === "current" ? "●" : "")),
      h("div", { class: "step__label" }, m.label)));
  const timeline = steps.length
    ? h("div", { class: "card" }, h("p", { class: "sectitle" }, "Progress"), h("ul", { class: "steps" }, ...steps))
    : null;

  const photos = (data.photos || []).map((p) =>
    h("figure", { class: "photo" },
      h("img", { src: p.url, alt: p.caption || "Project photo", loading: "lazy",
        onclick: () => openLightbox(p.url, p.caption || "Project photo") }),
      (p.caption || p.stage) ? h("figcaption", {}, p.caption || "",
        p.stage ? h("span", { class: "stage" }, (p.caption ? " · " : "") + p.stage) : null) : null));
  const gallery = photos.length
    ? h("div", { class: "card" }, h("p", { class: "sectitle" }, "Photos"), h("div", { class: "gallery" }, ...photos))
    : null;

  // drying readings — measured facts, in plain words. No dates promised.
  const dr = data.drying;
  const drying = dr && ((dr.areas || []).length || dr.equipmentOut) ? h("div", { class: "card" },
    h("p", { class: "sectitle" }, "Drying progress"),
    dr.asOf ? h("p", { class: "dry__asof" }, "Readings from " + dr.asOf) : null,
    ...(dr.areas || []).map((a) => h("div", { class: "dry__row" + (a.dry ? " is-dry" : "") },
      h("span", { class: "dry__mark" }, a.dry ? "✓" : "…"),
      h("div", {},
        h("div", { class: "dry__area" }, a.area + (a.material ? " — " + a.material : "")),
        h("div", { class: "dry__nums" },
          `${a.current}% moisture now` + (a.goal != null ? ` · dry at ${a.goal}%` : ""),
          a.dry ? " · dry ✓" : " · still drying")))),
    dr.equipmentOut ? h("p", { class: "dry__equip" },
      `${dr.equipmentOut} drying machine${dr.equipmentOut === 1 ? "" : "s"} running at your property.`) : null,
    h("p", { class: "dry__note" }, "These are our meter readings — your team confirms timing directly with you.")) : null;

  // closeout (CF-4): once complete, the page becomes the customer's record —
  // warranty with one-tap service request, the home file, review + referral
  const co = data.closeout;
  let closeoutCards = [];
  if (co && job.status === "complete") {
    const ends = co.completedAt && co.warrantyMonths
      ? new Date(new Date(co.completedAt + "T12:00:00").setMonth(new Date(co.completedAt + "T12:00:00").getMonth() + co.warrantyMonths))
          .toISOString().slice(0, 10) : "";
    const note = h("textarea", { class: "warr__note", rows: "2", placeholder: "What's going on? (optional)" });
    const reqBtn = h("button", { class: "acct__btn", type: "button" }, "Request warranty service");
    const reqStatus = h("p", { class: "acct__status", role: "status" });
    reqBtn.addEventListener("click", async () => {
      reqBtn.disabled = true; reqStatus.textContent = "Sending…";
      try {
        const r = await warrantyRequest(token, note.value);
        reqStatus.textContent = r.already
          ? "We already have your request — we'll be in touch shortly."
          : "Got it — we'll reach out to schedule a look. Thank you!";
        note.value = "";
      } catch { reqStatus.textContent = "Couldn't send — call us at 907-371-9868."; reqBtn.disabled = false; }
    });
    const warranty = h("div", { class: "card" },
      h("p", { class: "sectitle" }, "Your warranty"),
      h("p", { class: "warr__p" },
        co.warrantyMonths
          ? `Our workmanship on this project is covered for ${co.warrantyMonths} months` +
            (co.completedAt ? ` from ${co.completedAt}` : "") + (ends ? ` (through ${ends})` : "") + "."
          : "Questions about our workmanship? We stand behind it — reach out any time."),
      h("p", { class: "warr__p" }, "Notice something that doesn't look right? Tell us and we'll make it right."),
      note, h("div", { style: "margin-top:8px" }, reqBtn), reqStatus);

    const fileRows = (co.homeFile || []).map((r) =>
      h("div", { class: "hf__row" }, h("span", { class: "hf__k" }, r.label), h("span", { class: "hf__v" }, r.value)));
    const homeFile = fileRows.length ? h("div", { class: "card" },
      h("p", { class: "sectitle" }, "Your home file"),
      h("p", { class: "dry__note", style: "margin-top:0" },
        "The details worth keeping — paint colors, materials, and what's behind the walls. This page is yours for good."),
      ...fileRows) : null;

    const review = h("div", { class: "card review" },
      h("p", { class: "sectitle" }, "How did we do?"),
      h("p", { class: "warr__p" }, "If we earned it, a quick review helps our small Fairbanks crew more than you know."),
      h("a", { class: "acct__btn review__btn", href: REVIEW_URL, target: "_blank", rel: "noopener" }, "Leave us a review"),
      h("p", { class: "dry__note" }, "Know someone with a project? Send them our way — 907-371-9868. Mention your name; we take care of the people our customers send."));

    closeoutCards = [warranty, homeFile, review].filter(Boolean);
  }

  // documents the office shared — tap a page to view it full screen
  const docs = (data.documents || []).map((d) =>
    h("div", { class: "doc" },
      h("div", { class: "doc__label" }, d.label, d.type ? h("span", { class: "stage" }, " · " + d.type) : null),
      h("div", { class: "doc__pages" }, ...(d.pages || []).map((u, i) =>
        h("img", { src: u, alt: `${d.label} — page ${i + 1}`, loading: "lazy",
          onclick: () => openLightbox(u, `${d.label} — page ${i + 1}`) })))));
  const documents = docs.length
    ? h("div", { class: "card" }, h("p", { class: "sectitle" }, "Documents"),
        h("p", { class: "dry__note", style: "margin-top:0" }, "Shared for you and your insurance — tap a page to read it."),
        ...docs)
    : null;

  // Selections sit above the photos: they're the only thing on this page the
  // customer has to act on, and they're time-bound by the material order.
  const selections = data.selections && data.selections.total
    ? selectionsCard(token, data.selections) : null;

  // account chrome: back-nav in session mode; the save-card on a bare token
  // link when this phone has no session yet
  const back = opts && opts.backToProjects
    ? h("p", { class: "acct__back" }, h("a", { href: "#", onclick: (e) => { e.preventDefault(); renderProjects(storedSession()); } }, "‹ All your projects"))
    : null;
  const saveCard = (!opts || !opts.backToProjects) && token && token.token && !storedSession()
    ? accountCard(token) : null;

  // native replaceChildren stringifies null args ("null"), so drop falsy first
  app.replaceChildren(...[back, hero, timeline, ...closeoutCards, drying, selections, gallery, documents, saveCard, threadCard(token)].filter(Boolean));
}

const currentLabel = (ms) => (ms || []).find((m) => m.state === "current")?.label || "";

/* full-screen photo viewer — tap the backdrop, the ✕, or Esc to close */
function openLightbox(src, alt) {
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const box = h("div", { class: "lightbox", role: "dialog", "aria-label": "Photo", onclick: close },
    h("button", { class: "lightbox__close", "aria-label": "Close", onclick: close }, "✕"),
    h("img", { src, alt, onclick: (e) => e.stopPropagation() }));
  document.addEventListener("keydown", onKey);
  document.body.append(box);
}

(async () => {
  const raw = tokenFromUrl();
  // No token in the URL: an account phone lands on My Projects; anyone else
  // gets the gentle link-not-found message, same as always.
  if (!raw) {
    const s = storedSession();
    if (s) return renderProjects(s);
    return message("🔗", "Link not found", "Open the project link we sent you to view your job status.");
  }
  const cred = { token: raw };
  try {
    // The status page must render even if the selections sheet fails or the
    // office hasn't published one — it is an addition to this page, not a
    // dependency of it.
    const [view, sheet] = await Promise.all([
      fetchView(cred),
      fetchSelections(cred).catch(() => null),
    ]);
    render({ ...view, selections: sheet }, cred);
  } catch (e) {
    if (e.status === 404) message("🔒", "This link isn't active", "It may have expired or been turned off. Call us at 907-371-9868 and we'll send a fresh one.");
    else message("⚠️", "Couldn't load your project", "Please try again in a moment, or call us at 907-371-9868.");
  }
})();
