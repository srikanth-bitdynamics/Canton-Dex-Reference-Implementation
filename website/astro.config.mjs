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
      // A repo-base-aware page lives at src/pages/404.astro. Keeping it outside
      // the docs collection avoids both a missing-entry warning and a duplicate
      // `/404` route during static generation.
      disable404Route: true,
      description:
        'A full-stack Token Standard V2 (CIP-0112) reference DEX for the Canton Network.',
      customCss: ['./src/styles/custom.css'],
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      expressiveCode: {
        // Daml has no bundled Shiki grammar; Haskell's is close enough to
        // colour the inlined snippets.
        shiki: { langAlias: { daml: 'haskell' } },
      },
      // Client-side Mermaid rendering for the <pre class="mermaid"> blocks that
      // sync-docs.mjs emits from ```mermaid fences.
      head: [
        {
          tag: 'script',
          attrs: { type: 'module' },
          content:
            "import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs';" +
            "const theme = () => document.documentElement.dataset.theme === 'light' ? 'default' : 'dark';" +
            "const render = () => {" +
            "  const els = [...document.querySelectorAll('pre.mermaid')];" +
            "  els.forEach(el => { if (el.dataset.src == null) el.dataset.src = el.textContent; el.removeAttribute('data-processed'); el.textContent = el.dataset.src; });" +
            "  mermaid.initialize({ startOnLoad: false, theme: theme() });" +
            "  if (els.length) mermaid.run({ nodes: els });" +
            "};" +
            "document.addEventListener('astro:page-load', render);" +
            "if (document.readyState !== 'loading') render(); else addEventListener('DOMContentLoaded', render);" +
            "new MutationObserver(m => { if (m.some(x => x.attributeName === 'data-theme')) render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });",
        },
      ],
      sidebar: [
        {
          label: 'Newcomer learning path',
          items: [
            { label: 'Canton & Daml Primer', slug: 'concepts/canton-daml-primer' },
            { label: 'Overview', slug: 'concepts/overview' },
            { label: 'Getting Started', slug: 'getting-started' },
            { label: 'AMM-first Walkthrough', slug: 'tutorials/amm-first-walkthrough' },
            { label: '15-minute Design Tour', slug: 'concepts/design-tour' },
            { label: 'Architecture', slug: 'concepts/architecture' },
            { label: 'Workflow Design', slug: 'concepts/workflows' },
            { label: 'Make Your First AMM Change', slug: 'tutorials/make-your-first-amm-change' },
            { label: 'Builder Guide', slug: 'guides/builder-guide' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Liquidity & Custody', slug: 'concepts/liquidity-and-custody' },
            { label: 'LP Tokens', slug: 'concepts/lp-tokens' },
            { label: 'Pricing', slug: 'concepts/pricing' },
            { label: 'Glossary', slug: 'concepts/glossary' },
            { label: 'Non-goals', slug: 'concepts/non-goals' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Local Canton (DPM sandbox)', slug: 'guides/localnet' },
            { label: 'Using the dApp', slug: 'guides/using-the-dapp' },
            { label: 'Add a Trading Pair', slug: 'guides/add-a-trading-pair' },
            { label: 'Add an LP or Instrument', slug: 'guides/add-lp-or-instrument' },
            { label: 'Choice Context', slug: 'guides/choice-context' },
            { label: 'Registry Integration', slug: 'guides/registry-integration' },
            { label: 'Deployment', slug: 'guides/deployment' },
            { label: 'Run on a Testnet', slug: 'guides/run-on-testnet' },
            { label: 'Operator Guide', slug: 'guides/operator-guide' },
            { label: 'Operator Runbook', slug: 'guides/operator-runbook' },
            { label: 'Validator Test Plan', slug: 'guides/validator-test-plan' },
          ],
        },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
});
