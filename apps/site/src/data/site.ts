/* ============================================================
   Roybal Construction — site-wide facts, in one place.

   Everything on the site reads NAP, hours, and the service list
   from here: the header, the footer, every page's JSON-LD, and
   the contact page. Correcting the phone number or the hours is
   a one-line edit that lands everywhere at once, which is what
   local SEO wants — Google penalises a business whose name,
   address, and phone disagree across its own pages.

   ⚠️ Values marked NEEDS REVIEW were carried over from the old
   Marketing 360 site and have NOT been confirmed as current.
   ============================================================ */

export const BUSINESS = {
  name: "Roybal Construction, LLC",
  shortName: "Roybal Construction",
  legalName: "Roybal Construction, LLC",

  /* The local line — the ONLY number published anywhere on this site.
     A 907 area code is a local-relevance signal in a market where knowing
     how Alaskan buildings fail is the whole product, and it is the number
     every existing citation, backlink, truck, and invoice already carries.
     See LOCAL_NUMBER_NOTE below. */
  phone: "(907) 371-9868",
  phoneHref: "tel:+19073719868",
  phoneE164: "+19073719868",

  /* Toll-free spare. NOT displayed. It is the Twilio DID the AI receptionist
     currently answers; once the 907 is ported into Twilio this becomes a
     backup line, useful for measuring a specific ad channel without touching
     the published NAP. Do not put it on the site. */
  sparePhone: "(866) 345-2290",
  sparePhoneE164: "+18663452290",

  email: "info@roybalconstruction.com",

  address: {
    street: "3850 Royal Rd",
    city: "Fairbanks",
    region: "AK",
    regionName: "Alaska",
    postalCode: "99701",
    country: "US",
  },

  // ⚠️ APPROXIMATE — Fairbanks city centre, not the Royal Rd parcel. Replace
  // with the real lat/long from the Google Business Profile listing once the
  // address change there is live; a geo that disagrees with GBP is worse than
  // a rounded one.
  geo: { latitude: 64.8378, longitude: -147.7164 },

  // NEEDS REVIEW — the old site said Mon–Fri 8:00am–5:00pm for the office
  // while the homepage advertised 24/7 emergency restoration response.
  // Both are modelled: office hours below, emergency availability separately.
  hours: [
    { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" },
  ],
  hoursLabel: "Monday – Friday, 8:00am – 5:00pm",
  emergencyAvailable: true,
  emergencyLabel: "24/7 emergency restoration response",

  url: "https://www.roybalconstruction.com",
  logo: "https://www.roybalconstruction.com/images/logo-full.png",

  social: [
    "https://www.facebook.com/profile.php?id=100092349127530",
  ],

  priceRange: "$$",
  foundingDate: "2023",
} as const;

/* ---------- LOCAL_NUMBER_NOTE ----------
   The site briefly published the 866 toll-free line. It now publishes the
   907 again, deliberately, and that decision should not get quietly reverted.

   Three reasons:

   1. Google's Business Profile guidance points at a local number as the
      primary line rather than a call-center number. An 866 as the main
      number works against the local pack.
   2. The area code is itself a local-relevance signal. For a restoration
      contractor whose entire pitch is understanding how Alaskan buildings
      fail in winter, a toll-free number reads as a national call centre —
      which is exactly the impression that loses the job.
   3. Every citation, backlink, truck, yard sign, and invoice already says
      907. Publishing anything else spends years of NAP consistency and buys
      a Google Business Profile re-verification for nothing.

   HOW CALLS REACH THE AI: port the 907 into Twilio so the receptionist
   answers it directly. Do NOT solve this by forwarding 907 → 866:
     - TWILIO_FROM is one number for both voice and SMS, so a customer who
       dialled 907 would get texts from a number they don't recognise;
     - depending on the carrier, forwarding can present the FORWARDING line
       to Twilio instead of the real caller — and services/phone-agent keys
       createLead, lookupCaller, and its per-caller rate limits on
       session.from. That is a functional break, not a cosmetic one. */

/* ---------- Service areas ----------
   The towns Roybal actually serves, confirmed by Branden 2026-08-11.
   `page: true` means a dedicated location page exists. */
export const SERVICE_AREAS = [
  { name: "Fairbanks", slug: "fairbanks", page: true },
  { name: "North Pole", slug: "north-pole", page: true },
  { name: "Fox", slug: "fox", page: false },
  { name: "Ester", slug: "ester", page: false },
] as const;

/* Fort Wainwright was removed 2026-08-12. It borders Fairbanks, but the post
   is military-owned and runs its own contractors, so Roybal does little or no
   work there — listing it advertises a service we don't really provide and
   dilutes the areaServed markup with a place we can't win.

   Nothing to redirect: no Fort Wainwright page or URL ever existed on this
   site or on the Marketing 360 site before it (the only location URLs are
   fairbanks, college, and hamilton-acres). It appeared solely in this list,
   so removing it here removes it everywhere — nav, footer, homepage, and the
   LocalBusiness areaServed. No SEO is at stake. */

/* ---------- Fairbanks neighbourhoods ----------
   College and Hamilton Acres are neighbourhoods INSIDE Fairbanks, not
   separate towns — so they are not `areaServed` cities and must not be
   presented as if they were.

   Their pages stay live regardless. /general-contractor-in-college and
   /general-contractor-in-hamilton-acres are two of the 36 URLs the site
   currently ranks for; deleting them throws that away for nothing. They are
   reframed as neighbourhood pages instead. See CONTENT-REVIEW.md for the
   consolidate-vs-keep decision. */
export const FAIRBANKS_NEIGHBORHOODS = [
  { name: "College", slug: "college", page: true },
  { name: "Hamilton Acres", slug: "hamilton-acres", page: true },
] as const;

/* ---------- Services ----------
   ⚠️ NEEDS REVIEW — carried over verbatim from the old site. Branden has
   flagged the services list as out of date. Each entry's `path` MUST keep
   matching the live URL: these are the ranking pages. Renaming a service is
   fine; changing its `path` is not, without a 301. */
export type Service = {
  name: string;
  path: string;
  blurb: string;
  group: "restoration" | "construction";
  emergency?: boolean;
};

export const SERVICES: Service[] = [
  {
    name: "Water Damage Restoration",
    path: "/restoration-services/water-damage-restoration-in-fairbanks",
    blurb:
      "We quickly and effectively restore your property after water damage, minimizing loss and preventing further issues like mold growth.",
    group: "restoration",
    emergency: true,
  },
  {
    name: "Frozen & Burst Pipe Repair",
    path: "/restoration-services/frozen-burst-pipe-repair-in-fairbanks",
    blurb:
      "Frozen lines thawed safely, burst pipes repaired fast — and the water damage extracted, dried, and rebuilt under one contract.",
    group: "restoration",
    emergency: true,
  },
  {
    name: "Fire Damage Restoration",
    path: "/restoration-services/fire-damage-restoration-in-fairbanks",
    blurb:
      "Our comprehensive fire damage restoration services address smoke, soot, and structural damage, helping you rebuild and recover.",
    group: "restoration",
    emergency: true,
  },
  {
    name: "Mold Removal",
    path: "/restoration-services/mold-removal-in-fairbanks",
    blurb:
      "We safely and thoroughly remove mold infestations, ensuring a healthy and clean environment for your home or business.",
    group: "restoration",
    emergency: true,
  },
  {
    name: "Storm Repair",
    path: "/restoration-services/storm-repair-in-fairbanks",
    blurb:
      "From hail to wind damage, we provide expert storm repair services to restore your property's integrity and appearance.",
    group: "restoration",
    emergency: true,
  },
  {
    name: "Residential Remodeling",
    path: "/residential-remodeling-in-fairbanks",
    blurb:
      "Transform your home with our residential remodeling services, creating beautiful and functional spaces tailored to your vision.",
    group: "construction",
  },
  {
    name: "Kitchen Remodeling",
    path: "/kitchen-remodeling-in-fairbanks",
    blurb:
      "Elevate your culinary space with our kitchen renovation expertise, designing and building the kitchen of your dreams.",
    group: "construction",
  },
  {
    name: "Commercial Remodeling",
    path: "/commercial-remodeling-in-fairbanks",
    blurb:
      "We enhance commercial properties with our efficient, professional remodeling services, improving functionality and aesthetics.",
    group: "construction",
  },
  {
    name: "Painting Services",
    path: "/painting-services-in-fairbanks",
    blurb:
      "Refresh and revitalize your indoor spaces with our professional interior painting services, delivering flawless finishes and lasting beauty.",
    group: "construction",
  },
  {
    name: "Exterior Painting",
    path: "/exterior-painting-in-fairbanks",
    blurb:
      "Boost your curb appeal and protect your property with our high-quality exterior painting services, offering durable and attractive results.",
    group: "construction",
  },
  {
    name: "Roofing Services",
    path: "/roofing-services-in-fairbanks",
    blurb:
      "From repairs to full replacements, our reliable roofing services ensure the protection and longevity of your home or business.",
    group: "construction",
  },
  {
    name: "Flooring Services",
    path: "/flooring-services-in-fairbanks",
    blurb:
      "When you're in need of new flooring, our team goes the extra mile to provide durable, beautiful options done right.",
    group: "construction",
  },
  {
    name: "Deck Construction",
    path: "/deck-construction-in-fairbanks",
    blurb:
      "We build, repair, and maintain decks, creating enjoyable and safe outdoor living spaces for your family and friends.",
    group: "construction",
  },
  {
    name: "Snow Removal",
    path: "/snow-removal-in-fairbanks",
    blurb:
      "Keep your property safe and accessible during winter with our dependable snow removal services for homes and businesses.",
    group: "construction",
  },
  {
    name: "New Construction",
    path: "/new-construction-services-in-fairbanks",
    blurb:
      "Building your dream home from the ground up. Explore our new construction services and let Roybal Construction bring your vision to life.",
    group: "construction",
  },
];

export const RESTORATION_SERVICES = SERVICES.filter((s) => s.group === "restoration");
export const CONSTRUCTION_SERVICES = SERVICES.filter((s) => s.group === "construction");

/* ── Backend endpoints ──────────────────────────────────────────
   The two Supabase edge functions the public site calls. Both are
   public, non-secret URLs (each function self-protects: honeypot,
   rate caps, spend ceiling), so the production values are committed
   here as build-time defaults.

   Why committed: on 2026-08-13 a build from a checkout without the
   gitignored apps/site/.env silently shipped with no receptionist
   panel and a quote form that posted nowhere. An UNSET env var must
   never again be a silent off-switch.

   Overriding per environment still works via PUBLIC_LEAD_ENDPOINT /
   PUBLIC_WEB_AGENT_ENDPOINT. Setting one EXPLICITLY to "" or "off"
   is the build-time kill switch (the receptionist's kill scenario);
   unset now means "use the production default". */
export const DEFAULT_LEAD_ENDPOINT =
  "https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-lead";
export const DEFAULT_WEB_AGENT_ENDPOINT =
  "https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-web-agent";

/** unset → fallback; "" or "off" → explicitly disabled (returns ""); else the override. */
export function resolveEndpoint(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value.toLowerCase() === "off" ? "" : value;
}
