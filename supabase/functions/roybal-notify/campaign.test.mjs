/* CF-5 campaign gate — pure-logic tests (no Deno, no network).
   Run: node supabase/functions/roybal-notify/campaign.test.mjs */
import assert from "node:assert/strict";
import { campaignGate } from "./campaign.mjs";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

const base = { used: 10, cap: 500, reserve: 150, campaignUsed: 0, campaignCap: 100 };
const optedIn = { id: "c1", optIn: true };

ok("happy path: known opted-in contact, budget clear",
  campaignGate({ ...base, contact: optedIn }).ok === true);

/* consent — never waivable */
ok("no matching contact → refused as consent",
  /campaign_consent/.test(campaignGate({ ...base, contact: null }).error));
ok("contact without opt-in → refused",
  /campaign_consent/.test(campaignGate({ ...base, contact: { id: "c1", optIn: false } }).error));
ok("opt-in must be literal true, not truthy",
  /campaign_consent/.test(campaignGate({ ...base, contact: { id: "c1", optIn: "yes" } }).error));
ok("consent refused even with zero caps (0 disables budgets, never consent)",
  /campaign_consent/.test(campaignGate({ ...base, campaignCap: 0, cap: 0, contact: null }).error));

/* the campaign's own ceiling */
ok("campaign cap reached → refused",
  /campaign_cap_reached/.test(campaignGate({ ...base, campaignUsed: 100, contact: optedIn }).error));
ok("campaign cap 0 → no per-lane ceiling",
  campaignGate({ ...base, campaignCap: 0, campaignUsed: 9999, contact: optedIn }).ok === true);

/* the shared reserve floor — campaigns can never starve the alert lanes */
ok("at cap−reserve the campaign is refused (350 of 500, reserve 150)",
  /campaign_reserve/.test(campaignGate({ ...base, used: 350, contact: optedIn }).error));
ok("one under the floor still sends",
  campaignGate({ ...base, used: 349, contact: optedIn }).ok === true);
ok("shared cap 0 → no reserve check (cap disabled entirely)",
  campaignGate({ ...base, cap: 0, used: 9999, contact: optedIn }).ok === true);

/* both limits bite independently */
ok("under campaign cap but over the floor → floor wins",
  /campaign_reserve/.test(campaignGate({ ...base, used: 400, campaignUsed: 5, contact: optedIn }).error));
ok("under the floor but over campaign cap → cap wins",
  /campaign_cap_reached/.test(campaignGate({ ...base, used: 20, campaignUsed: 150, contact: optedIn }).error));

console.log(`\n${pass} campaign-gate checks passed.`);
