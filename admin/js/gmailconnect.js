/* ============================================================
   Roybal Admin — Gmail connect panel (the email lane)
   ------------------------------------------------------------
   Mirrors qboconnect.js: OAuth once, tokens live server-side in
   gmail_tokens (service-role only). Google's callback is told apart
   from Intuit's by the "gm-" state prefix — Intuit callbacks carry
   their own realmId/state shapes and fall through untouched.
   Scopes: gmail.readonly (the 15-min job-matched pull) + gmail.send
   (confirm-chip sends from the owner's real address).
   ============================================================ */
import { h, toast } from "../../js/core.js";
import { GMAIL_CLIENT_ID } from "../../js/config.js";
import { currentEmail } from "../../js/supa.js";
import { gmailStatus, gmailDisconnect, gmailExchangeCode, gmailPullInbox } from "../../js/gmail.js";

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

function redirectUri() { return location.origin + location.pathname; }

function buildAuthUrl() {
  const state = "gm-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem("gmail_oauth_state", state);
  const p = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    response_type: "code",
    scope: SCOPES,
    redirect_uri: redirectUri(),
    access_type: "offline",   // refresh token — the cron pulls while everyone sleeps
    prompt: "consent",        // re-consent always re-issues the refresh token
    state,
  });
  return `${AUTH_BASE}?${p}`;
}

/** Finish the Google OAuth exchange if Google just redirected back here.
    Only claims callbacks whose state carries the gm- prefix; Intuit
    callbacks fall through to the QBO/QB-Time handlers. Returns true if handled. */
export async function handleGmailCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const state = params.get("state") || "";
  if (!code || !state.startsWith("gm-")) return false;

  const saved = sessionStorage.getItem("gmail_oauth_state");
  history.replaceState({}, "", location.pathname); // scrub the code from the URL

  if (saved && saved !== state) { toast("Gmail state mismatch — connect again."); return true; }
  try {
    const r = await gmailExchangeCode(code, currentEmail());
    toast(`Gmail connected — ${r.account}. Scanning for job email…`);
    gmailPullInbox().catch(() => {});   // first scan right away; the cron takes over after
  } catch (e) {
    toast((e && e.message) || "Gmail connection failed");
  }
  return true;
}

/** The dashboard card: status + connect / disconnect / scan-now. */
export function gmailPanel() {
  const box = h("div", { class: "card qb-panel" });

  function render(status) {
    box.replaceChildren();
    box.append(h("div", { class: "qb-panel__head" },
      h("strong", {}, "Email (Gmail)"),
      status && status.connected
        ? h("span", { class: "qb-ok" }, "● Connected")
        : h("span", { class: "qb-off" }, "○ Not connected")));

    if (!GMAIL_CLIENT_ID) {
      box.append(h("p", { class: "subtle" }, "Add GMAIL_CLIENT_ID to config.js to enable the email lane."));
      return;
    }

    if (status && status.connected) {
      box.append(h("p", { class: "subtle" }, (status.account || "") +
        " · only email matching a job (customer, claim #, name) is ever stored"));
      const scan = h("button", { class: "btn btn--ghost btn--sm" }, "↻ Scan inbox now");
      scan.addEventListener("click", async () => {
        scan.disabled = true; scan.textContent = "Scanning…";
        try {
          const r = await gmailPullInbox();
          toast(`Scanned ${r.scanned} new — filed ${r.filed} to jobs.`);
        } catch (e) { toast((e && e.message) || "Scan failed"); }
        scan.disabled = false; scan.textContent = "↻ Scan inbox now";
      });
      const disc = h("button", { class: "linklike" }, "Disconnect");
      disc.addEventListener("click", async () => {
        if (!confirm("Disconnect Gmail? The assistant stops seeing job email and can no longer send.")) return;
        try { await gmailDisconnect(); toast("Disconnected."); load(); }
        catch (e) { toast((e && e.message) || "Disconnect failed"); }
      });
      box.append(h("div", { class: "qb-panel__row" }, scan, disc));
    } else {
      const connect = h("button", { class: "btn btn--primary btn--sm" }, "Connect Gmail");
      connect.addEventListener("click", () => { location.href = buildAuthUrl(); });
      box.append(h("p", { class: "subtle" },
        "Connect the office mailbox once. Adjuster and customer email files itself onto the right job, " +
        "the assistant drafts replies you approve with a tap, and everything sends from your real address."), connect);
    }
  }

  async function load() {
    render({ connected: false });
    try { render(await gmailStatus()); } catch { render({ connected: false }); }
  }
  load();
  return box;
}
