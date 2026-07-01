// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const REPO = 'https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation';

// Docs content under src/content/docs/ is generated from the repo's ../docs
// tree by scripts/sync-docs.mjs (runs before dev/build). The canonical Markdown
// stays in docs/ so it also renders cleanly in the GitHub file view.
export default defineConfig({
  site: 'https://srikanth-bitdynamics.github.io',
  base: '/Canton-Dex-Reference-Implementation/',
  integrations: [
    starlight({
      title: 'Canton DEX',
      description:
        'A full-stack Token Standard V2 (CIP-0112) reference DEX for the Canton Network.',
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      sidebar: [
        { label: 'Start here', items: [{ label: 'Getting Started', slug: 'getting-started' }] },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
});
