/* ============================================================
   Roybal Field Forms — backend config
   The publishable key is safe to ship in the client; the data is
   protected by the shared login + row-level security in Supabase.
   Leave SUPABASE_URL blank to run the app in pure local-only mode.
   ============================================================ */
export const SUPABASE_URL = "https://djpgvcvhvgrzgaziruze.supabase.co";
export const SUPABASE_KEY = "sb_publishable_67P68AjuAtK5z649liJg1w_ZPhh_Ud4";
export const SYNC_ENABLED = !!SUPABASE_URL;

// QuickBooks Time OAuth client id — PUBLIC (safe to ship). The Client Secret
// and tokens live only in the qb-time-proxy Edge Function's secrets. Fill this
// from your Intuit Developer app to enable the admin "Connect" button. The
// redirect URI it uses is the admin app's own URL (origin + path); register
// that exact URL in the Intuit app AND set it as QB_TIME_REDIRECT_URI on the
// Edge Function.
export const QB_TIME_CLIENT_ID = "3902ee19a693773d69dd4a355e1f8984";

// QuickBooks ONLINE OAuth client id — PUBLIC (safe to ship). Separate Intuit
// app connection from QB Time (TSheets tokens can't call the Accounting API).
// Fill this from an Intuit Developer app with the Accounting scope to enable
// the admin "Connect QuickBooks Online" button; the Client Secret and tokens
// live only in the qbo-proxy Edge Function's secrets. Register the admin
// app's URL as the redirect URI AND set it as QBO_REDIRECT_URI on the function.
export const QBO_CLIENT_ID = "";

// Gmail OAuth client id — PUBLIC (safe to ship). Enables the email lane:
// job-matched inbox pull + confirm-chip sends from the office mailbox.
// Create a Google Cloud OAuth "Web application" client (Gmail API enabled,
// consent screen Internal) and fill this in; the Client Secret and tokens
// live only in the gmail-proxy Edge Function's secrets. Register the admin
// app's URL as an authorized redirect URI AND set it as GMAIL_REDIRECT_URI
// on the function.
export const GMAIL_CLIENT_ID = "";
