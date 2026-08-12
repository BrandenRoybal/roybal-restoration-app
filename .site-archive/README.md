# .site-archive — the pre-migration snapshot of the Marketing 360 site

Captured 2026-08-11, before anything changed. This is the record of what the
old site was, and the build depends on part of it.

## What's here, and what isn't

| Path | In git? | Why |
|---|---|---|
| `content.json` | **yes** | Every live URL with its title, meta description, headings, and body text. **`npm run site:build` fails without it** — `scripts/check-parity.mjs` diffs the build against this file, so a change that orphans a ranking URL cannot deploy. |
| `raw/` | **yes** (1.7 MB) | The original HTML of all 36 pages, exactly as Madwire served it. The only copy that isn't on their infrastructure. |
| `images/manifest.json` | **yes** | Maps each original CDN URL to its local filename and the pages that used it. |
| `images/*.jpg,*.png` | **no** | 16 MB, and a byte-for-byte duplicate of `apps/site/public/images/`, which **is** committed and is what the live site serves. Carrying both would double the repo for nothing. |

The photos are therefore still fully preserved in git — just once, under
`apps/site/public/images/`, rather than twice.

## Regenerating the excluded images

Only needed if `apps/site/public/images/` were ever lost. `manifest.json` holds
every original URL, but those point at `static.mywebsites360.com` and **stop
resolving once the Marketing 360 account is cancelled**. After that, the copies
in `apps/site/public/images/` are the only ones that exist.

## Do not delete this directory

It is both the build's parity source and the only off-Madwire record of what
the site looked like. See `MIGRATION-NOTES.md` for the full audit.
