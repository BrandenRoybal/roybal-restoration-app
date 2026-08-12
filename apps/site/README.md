# apps/site — www.roybalconstruction.com

The public marketing site. Replaces the Marketing 360 (Madwire) hosted site.

Static HTML out of Astro: no client framework, no runtime, ~1.4s builds.
The only JavaScript that ships is the quote form's async submit, and the form
still works without it.

```bash
npm run site           # dev server on :4330
npm run site:build     # build + postbuild + parity gate
```

## The one rule

**Never change a `path:` in content frontmatter.** Those 36 URLs are what the
site ranks for, and a lot of money went into earning them. `npm run build`
runs `scripts/check-parity.mjs`, which diffs the build against
`.site-archive/content.json` and **fails** if any live URL stops resolving.

If a page genuinely must move, it needs an explicit 301 from the old path.
Ask before doing it.

## Layout

```
src/
  data/site.ts        NAP, hours, services, service areas — single source of
                      truth for nav, footer, and all JSON-LD
  layouts/Base.astro  the SEO contract: canonical, JSON-LD graph, OG tags
  content/
    services/         16 service pages     → src/pages/[...slug].astro
    locations/         3 location pages    → src/pages/general-contractor-in-[loc].astro
    blog/              7 posts             → src/pages/blog/[slug].astro
  pages/              everything else, one file per URL
```

Content lives in Markdown so copy can be edited without touching templates.
Each file carries `reviewed: false` until its copy has been confirmed current
— see `CONTENT-REVIEW.md`.

## Why the build emits flat files

`astro.config.mjs` sets `build.format: "file"`, so a page becomes
`contact-us.html`, not `contact-us/index.html`.

The old site served every URL extensionless with **no trailing slash**. The
default directory format would serve `/contact-us/` and 301 the old path —
a redirect on all 36 ranking URLs on cutover day. Flat files keep the paths
byte-identical.

The same reason is why `Base.astro` strips `.html` when building the canonical
URL: `Astro.url.pathname` names the *file*, and a canonical must name the URL
people actually link to.

## Lead capture

The quote form posts to the `roybal-lead` edge function
(`supabase/functions/roybal-lead/`), which writes a `coordination_jobs` row in
the same envelope the phone agent's `createLead` uses. A web lead and a phone
lead land as the same card in the same board column, so the office watches one
queue.

Set `PUBLIC_LEAD_ENDPOINT` in `.env` (see `.env.example`). Blank makes the
form a no-op, so set it before cutover.

## Docs

- `CONTENT-REVIEW.md` — what needs Branden's eyes before launch
- `CUTOVER.md` — the migration runbook, in order
- `../../.site-archive/` — the complete pre-migration snapshot of the old
  site: every page, its metadata, and all 132 images. Keep it. It is the only
  copy that doesn't live on Madwire's servers.
