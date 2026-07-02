/* ============================================================
   Roybal Admin — QuickBooks Time connect panel
   One-time OAuth from the office. The redirect URI is this admin
   app's own URL, so QuickBooks Time returns here with ?code and
   handleQbCallback() finishes the exchange. No secrets client-side.
   ============================================================ */
import { h, toast } from "../../js/core.js";
import { QB_TIME_CLIENT_ID } from "../../js/config.js";
import { getStatus, syncJobcodes, disconnect, exchangeCode } from "../../js/qbtime.js";

// QuickBooks Time uses its OWN OAuth server (the TSheets API), NOT QuickBooks
// Online's appcenter endpoint. No `scope` param (TSheets doesn't support one),
// and the callback returns a `code` only — no `realmId` (that's a QBO concept).
const AUTH_BASE = "https://rest.tsheets.com/api/v1/authorize";

function redirectUri() { return location.origin + location.pathname; }

function buildAuthUrl() {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem("qb_oauth_state", state);
  const p = new URLSearchParams({
    client_id: QB_TIME_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(),
    state,
  });
  return `${AUTH_BASE}?${p}`;
}

/** If QuickBooks Time just redirected back here, finish the OAuth exchange.
    Returns true when it handled a callback (so the caller can re-render). */
export async function handleQbCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) return false;

  const state = params.get("state");
  const saved = sessionStorage.getItem("qb_oauth_state");
  history.replaceState({}, "", location.pathname); // scrub the code from the URL

  if (error) { toast("QuickBooks authorization denied: " + error); return true; }
  if (!code) { toast("QuickBooks redirect was missing its code."); return true; }
  if (saved && state && saved !== state) { toast("QuickBooks state mismatch — connect again."); return true; }

  try {
    await exchangeCode(code);
    toast("QuickBooks Time connected.");
    try { await syncJobcodes(); } catch { /* jobcodes sync is best-effort */ }
  } catch (e) {
    toast((e && e.message) || "QuickBooks connection failed");
  }
  return true;
}

/** The dashboard card: status + connect / sync / disconnect. */
export function qbPanel() {
  const box = h("div", { class: "card qb-panel" });

  function render(status) {
    box.replaceChildren();
    box.append(h("div", { class: "qb-panel__head" },
      h("strong", {}, "QuickBooks Time"),
      status && status.connected
        ? h("span", { class: "qb-ok" }, "● Connected")
        : h("span", { class: "qb-off" }, "○ Not connected")));

    if (!QB_TIME_CLIENT_ID) {
      box.append(h("p", { class: "subtle" }, "Add QB_TIME_CLIENT_ID to config.js to enable connecting."));
      return;
    }

    if (status && status.connected) {
      box.append(h("p", { class: "subtle" }, "Linked" +
        (status.updatedAt ? " · updated " + new Date(status.updatedAt).toLocaleDateString() : "")));
      const sync = h("button", { class: "btn btn--ghost btn--sm" }, "Sync job codes");
      sync.addEventListener("click", async () => {
        sync.disabled = true; const t = sync.textContent; sync.textContent = "Syncing…";
        try { const r = await syncJobcodes(); toast("Synced " + (r.synced ?? 0) + " job codes."); }
        catch (e) { toast((e && e.message) || "Sync failed"); }
        finally { sync.disabled = false; sync.textContent = t; }
      });
      const disc = h("button", { class: "btn btn--ghost btn--sm" }, "Disconnect");
      disc.addEventListener("click", async () => {
        if (!confirm("Disconnect QuickBooks Time?")) return;
        try { await disconnect(); toast("Disconnected."); load(); }
        catch (e) { toast((e && e.message) || "Disconnect failed"); }
      });
      box.append(h("div", { class: "qb-panel__row" }, sync, disc));
    } else {
      const connect = h("button", { class: "btn btn--primary btn--sm" }, "Connect QuickBooks Time");
      connect.addEventListener("click", () => { location.href = buildAuthUrl(); });
      box.append(h("p", { class: "subtle" }, "Connect once so job hours flow into the daily construction logs."), connect);
    }
  }

  async function load() {
    render({ connected: false });
    try { render(await getStatus()); } catch { render({ connected: false }); }
  }
  load();
  return box;
}
