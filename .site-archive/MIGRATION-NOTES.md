# Roybal Construction — Website Migration Notes

Archived 2026-08-11 from the live Marketing 360 site before any changes.

## What's in this archive

- `raw/` — full HTML of all 36 live pages, exactly as served
- `content.json` — per page: URL, title, meta description, headings, body text, image list, word count
- `images/` — all 132 referenced images (15.6 MB) + `manifest.json` mapping each back to its original URL and the pages that use it

This is the complete set of assets currently hosted on Madwire's servers. Once the
account is cancelled, `static.mywebsites360.com` stops serving them.

## Current platform

Marketing 360 (Madwire). Assets on `static.mywebsites360.com`, site served from `34.95.85.224`.
No build access — content is edited only through their portal.

## Business info as published (verify before reuse)

| Field | Value |
|---|---|
| Name | Roybal Construction, LLC |
| Address | 3335 Trailer St, Fairbanks, AK 99709 |
| Phone | (907) 371-9868 |
| Hours | Monday–Friday, 8:00am–5:00pm |
| Facebook | facebook.com/profile.php?id=100092349127530 |

## Domain and DNS — we control these

- Registrar: **Wix**, registrant org "roybal construction, llc", expires 2030-03-31
- Nameservers: `ns8.wixdns.net`, `ns9.wixdns.net`
- `www` A record → `34.95.85.224` (Marketing 360)
- MX → Google Workspace (**email is independent of the website — unaffected by cutover**)
- TXT → SPF includes `_spf.google.com` and `_spf.createsend.com` (Campaign Monitor)

Cutover is a DNS change at Wix. Madwire cannot hold the domain hostage.

## Redirects (currently correct — must be preserved)

`http://`, `https://` non-www, and `http://www` all 301 in one hop to `https://www.roybalconstruction.com`.

## Marketing 360 dependencies that break at cutover

| Dependency | Detail | Impact |
|---|---|---|
| Contact forms | `forms.marketing360.com/load.js?id=6758d7def3db51062f0283d2` and `...id=6758d7e05f1c6d21af0f57d2` | Lead capture stops. Must be rebuilt. |
| Google Tag Manager | Container `GTM-NVBWQFPR` | Likely owned by Madwire. Confirm access or stand up a fresh GA4. |
| Top Rated Local | `topratedlocal.com/review/roybal-construction-llc-reviews` | Madwire's review platform. Reviews there are **not portable**. |
| Tracking links | `m360.us/6152e` (sitewide), `m360.us/5d51` | Cosmetic; drop them. |

Google Business Profile reviews are unaffected — that's the asset that matters.

## SEO audit of the current site

Working well — preserve exactly:
- 36 pages, clean keyword-relevant URL structure
- Unique `<title>` and meta description on every page
- Clean single-hop canonical-domain redirects
- `robots.txt` allows all, points at a valid sitemap

Gaps to fix in the rebuild:
1. **No JSON-LD structured data anywhere.** Only a legacy `http://schema.org/GeneralContractor`
   microdata attribute. No NAP, hours, geo, service catalog, or review markup.
2. **No `<link rel="canonical">` on any page.**
3. **Every subpage renders an empty `<h1>` before the real one** — two H1s per page.
4. **Titles repeat the brand twice** — e.g. "Kitchen Remodeling in Fairbanks - Get a Quote - Roybal
   Construction, LLC". Wastes title width before Google truncates.
5. **Empty `meta keywords` and `meta author` tags.**
6. **Only 3 location pages** (Fairbanks, College, Hamilton Acres). Missing North Pole, Badger,
   Ester, Fox, Salcha, Steele Creek, Chena Ridge, Eielson AFB, Fort Wainwright.
7. **Location pages are thin** (~360–430 words) and largely boilerplate — doorway-page risk.
   Fix with genuinely local content, or consolidate.

## URL parity requirement

All 36 paths in `content.json` must resolve **200 at the identical path** after cutover.

Note: current URLs have **no trailing slash**. Most static generators emit `/about/index.html`,
which serves at `/about/` and 301s `/about` → `/about/`. Configure the build to emit flat
`.html` files so paths stay byte-identical. This detail quietly leaks rankings if missed.
