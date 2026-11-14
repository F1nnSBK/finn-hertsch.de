import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import sitemap from '@astrojs/sitemap';
import { isPostPublished } from './src/lib/publicationState.mjs';
import { openEncryptedVaultBundle } from './src/lib/vault/archive.mjs';
import {
  vaultDevServerPlugin,
  vaultDistillBuildIntegration,
} from './src/lib/vault/devMiddleware.mjs';

const publicDir = fileURLToPath(new URL('./public', import.meta.url));

const customSitemapPages = [
  'https://finn-hertsch.de/research/kairos/',
  'https://finn-hertsch.de/en/research/kairos/',
];

const redirectOnlySlugs = new Set();

try {
  const bundle = openEncryptedVaultBundle();
  for (const [slug, meta] of Object.entries(bundle.markdownPosts)) {
    if (!meta?.distillBundle) continue;
    redirectOnlySlugs.add(`/${slug}`);
    if (isPostPublished(slug)) {
      customSitemapPages.push(
        `https://finn-hertsch.de/blog/${meta.distillBundle}/`,
        `https://finn-hertsch.de/en/blog/${meta.distillBundle}/`
      );
    }
  }
} catch {
  // Vault key optional when all encrypted drafts are unpublished
}

export default defineConfig({
  site: 'https://finn-hertsch.de',
  output: 'static',
  integrations: [
    sitemap({
      filter: (page) => {
        if (page.includes('/vault')) return false;
        for (const suffix of redirectOnlySlugs) {
          if (page.includes(suffix)) return false;
        }
        return true;
      },
      customPages: customSitemapPages,
    }),
    vaultDistillBuildIntegration(),
  ],
  vite: {
    plugins: [vaultDevServerPlugin(publicDir)],
  },
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
    shikiConfig: {
      theme: 'github-dark',
      wrap: true,
    },
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
});
