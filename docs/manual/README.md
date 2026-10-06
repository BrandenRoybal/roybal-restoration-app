# App manual

The user manual for Field Forms, Office Admin, the Job Board and the Customer
Portal, written for Branden, the crew leads and the crew. The source is HTML so
it prints as a branded PDF that matches the field forms packet.

| File | What it is |
|---|---|
| `manual.html` | The manual itself. Edit this when a feature ships. |
| `sop-water-mitigation.html` | The crew's water mitigation SOP (first visit to Certificate of Drying, moisture-reading protocol). Same look and tools. |
| `manual.css` | Print styles (letterhead, section bands, tables), from `apps/field/css/print.css`. |
| `shots/` | Screenshots used by the manual. Made-up demo data only. |
| `tools/shoot.mjs` | Re-shoots every screen from the apps in this checkout. |
| `tools/demo-data.mjs` | The demo jobs, leads, crew and portal data the screens show. |
| `tools/mock.mjs` | Answers every network call during a shoot; anything else is blocked. |
| `tools/build.mjs` | Builds `dist/Roybal_App_Manual.pdf` (git-ignored). |

## Rebuild

From the repo root (needs Node and Playwright with Chromium):

```sh
node docs/manual/tools/shoot.mjs            # all screens, or pass a name filter: field-, admin-, board-, portal
node docs/manual/tools/build.mjs            # docs/manual/dist/Roybal_App_Manual.pdf
node docs/manual/tools/shoot.mjs sop-       # just the SOP's screens (demo job "demo-job-sop")
node docs/manual/tools/build.mjs sop        # docs/manual/dist/Roybal_Water_Mitigation_SOP.pdf
```

`build.mjs` stamps the edition date, the field build from `apps/field/js/config.js`
and the license line from `apps/field/js/model.js`. Contents page numbers need
`python3` with `pypdf`; without it the contents still links, unnumbered.

## When a feature ships

1. Update its section in `manual.html` and the "What's new and in progress" table.
2. If its screen changed, add or adjust the shot in `tools/shoot.mjs` (and demo
   data in `tools/demo-data.mjs`), then re-shoot just that one.
3. Rebuild the PDF and post it to the project files.

## Rules for screenshots

- Never use real customer names, addresses, phone numbers, claim numbers, amounts
  or credentials. Demo data uses example.com emails, 555 numbers and street
  numbers that do not exist.
- `mock.mjs` intercepts every request that leaves localhost and aborts anything it
  does not answer, so a shoot can never read from or write to the real
  Supabase project. Keep it that way.
- Don't change app code to get a screenshot. Mock the data instead.
