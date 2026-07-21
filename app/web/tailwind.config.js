/** @type {import('tailwindcss').Config} */
//
// Visual tokens for the DEX frontend, wired to the Bitdynamics design
// system (src/styles/bitdynamics/*). The console runs the dark theme
// (data-theme="dark" on <html>), so every color here resolves through
// the design system's semantic CSS variables:
//   - Archivo (UI) + JetBrains Mono (code and ALL data values)
//   - ink neutrals + one cobalt accent; desaturated status triads
//   - radius 2 (controls) / 4 (cards) / 8 (dialogs); borders, not shadows
//
// Component code uses either Tailwind classes (`bg-surface-card`) or raw
// CSS vars (`var(--danger-text)`); both resolve to the same tokens.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    // Radius follows the design system scale: 2px controls, 4px cards,
    // 8px dialogs/terminal windows. `rounded-full` stays for status dots
    // and avatar/glyph fallbacks only.
    borderRadius: {
      none: '0',
      sm: '2px',
      DEFAULT: '2px',
      md: '2px',
      lg: '4px',
      xl: '8px',
      '2xl': '8px',
      full: '999px',
    },
    extend: {
      colors: {
        surface: {
          DEFAULT: 'var(--bg-page)',
          card: 'var(--bg-surface)',
          border: 'var(--border-default)',
          hover: 'var(--hover-tint)',
          muted: 'var(--bg-inset)',
        },
        // Status palette. Names match StatusBadge classes; values are the
        // design system's desaturated text-grade status hues.
        accent: {
          green: 'var(--ok-text)',
          red: 'var(--danger-text)',
          blue: 'var(--accent)',
          yellow: 'var(--warn-text)',
          amber: 'var(--warn-text)',
          orange: 'var(--warn-icon)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
        },
        // Raw bg layers used by expand-in-place rows.
        bg: {
          2: 'var(--bg-surface)',
          3: 'var(--bg-raised)',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
        sans: ['Archivo', '-apple-system', '"Segoe UI"', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      },
      fontVariantNumeric: {
        tabular: 'tabular-nums',
      },
    },
  },
  plugins: [],
};
