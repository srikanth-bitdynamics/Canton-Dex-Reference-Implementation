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
      // Client-side Mermaid rendering for the <pre class="mermaid"> blocks that
      // sync-docs.mjs emits from ```mermaid fences.
      head: [
        {
          tag: 'script',
          attrs: { type: 'module' },
          content:
            "import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';" +
            "mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });" +
            "const run = () => mermaid.run({ querySelector: 'pre.mermaid' });" +
            "document.addEventListener('astro:page-load', run);" +
            "if (document.readyState !== 'loading') run(); else addEventListener('DOMContentLoaded', run);",
        },
      ],
      sidebar: [
        { label: 'Start here', items: [{ label: 'Getting Started', slug: 'getting-started' }] },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
});
