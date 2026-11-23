import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { docsGlobLoader } from '@syntax-syllogism/docs-theme';

// Astro's glob loader resolves `base` with `new URL(base, config.root)`. A bare
// Windows path ("C:\...") parses as a URL with scheme "c:", which later fails
// fileURLToPath with "The URL must be of scheme file". Pass a file: URL (a URL
// object stringifies to its href) so the base resolves on every platform.
const docsRoot = new URL('../../docs/', import.meta.url);

export const collections = {
  docs: defineCollection({
    loader: docsGlobLoader({ base: docsRoot }),
    schema: docsSchema(),
  }),
};
