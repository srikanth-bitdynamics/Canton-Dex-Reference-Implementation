/** @type {import('tailwindcss').Config} */
//
// Visual tokens for the DEX frontend:
//   - IBM Plex Sans + IBM Plex Mono typography stack
//   - black-on-graphite surface palette
//   - accent palette + status-pill colors aligned with StatusBadge
//   - `bg-2` / `bg-3` row tints for expand-in-place patterns
//
// CSS variables flow through `index.css` so the existing component code
// can use either Tailwind classes (`bg-surface-card`) or raw CSS vars
// (`var(--bg-2)`). Both resolve to the same colors.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#0D1117',
          card: '#161B22',
          border: '#30363D',
          hover: '#1C2128',
          muted: '#1C2128',
        },
        // Status-pill palette. Names match StatusBadge classes.
        accent: {
          green: '#3FB950',
          red: '#F85149',
          blue: '#58A6FF',
          yellow: '#D29922',
          amber: '#D29922',
          orange: '#F97316',
        },
        text: {
          primary: '#E6EDF3',
          secondary: '#8B949E',
          muted: '#484F58',
        },
        // Raw bg layers used by expand-in-place rows. bg-2 is one shade
        // lighter than the card; bg-3 is the expanded-row highlight.
        bg: {
          2: '#161B22',
          3: '#1C2128',
        },
      },
      fontFamily: {
        // IBM Plex stack, matching Canton DEX.html.
        mono: ['"IBM Plex Mono"', 'JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['"IBM Plex Sans"', 'Inter', 'system-ui', 'sans-serif'],
      },
      fontVariantNumeric: {
        tabular: 'tabular-nums',
      },
    },
  },
  plugins: [],
};
