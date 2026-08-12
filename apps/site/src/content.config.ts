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

const services = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/services" }),
  schema: z.object({ ...seo, slug: z.string() }),
});

const locations = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/locations" }),
  schema: z.object(seo),
});

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    ...seo,
    publishDate: z.coerce.date().optional(),
  }),
});

export const collections = { services, locations, blog };
