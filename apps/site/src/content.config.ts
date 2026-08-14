import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/* `path` is the live URL the page ranks for. It is required on every entry
   and the parity check reads it, so a typo fails the build rather than
   quietly orphaning a ranking page. */
const seo = {
  title: z.string(),
  description: z.string(),
  heading: z.string(),
  path: z.string().startsWith("/"),
  image: z.string().optional(),
  /** Flipped to true once Branden has confirmed the copy is current. */
  reviewed: z.boolean().default(false),
};

/* Optional on-page FAQ. The page template renders these visibly AND emits
   them as FAQPage JSON-LD — Google only credits FAQ markup whose text
   appears on the page, so the two must come from the same source. */
const faq = z
  .array(z.object({ q: z.string(), a: z.string() }))
  .optional();

const services = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/services" }),
  schema: z.object({ ...seo, slug: z.string(), faq }),
});

const locations = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/locations" }),
  schema: z.object({ ...seo, faq }),
});

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    ...seo,
    publishDate: z.coerce.date().optional(),
  }),
});

export const collections = { services, locations, blog };
