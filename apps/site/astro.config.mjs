import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// URL PARITY IS THE WHOLE GAME HERE.
//
// The Marketing 360 site served every page at an extensionless path with NO
// trailing slash (/contact-us, not /contact-us/). Astro's default `directory`
// format would emit contact-us/index.html, which serves at /contact-us/ and
// 301s the old path — a redirect on all 36 ranking URLs at the exact moment
// we cut over. `file` format emits contact-us.html, which static hosts serve
// at /contact-us with no redirect at all.
//
// `npm run parity` diffs the built output against .site-archive/content.json
// and fails if any of the 36 live paths stops resolving. Run it before deploy.
export default defineConfig({
  site: "https://www.roybalconstruction.com",
  build: { format: "file" },
  trailingSlash: "never",
  integrations: [
    sitemap({
      // Match the old sitemap: no trailing slashes, homepage bare.
      serialize(item) {
        item.url = item.url.replace(/\/$/, "");
        return item;
      },
    }),
  ],
});
