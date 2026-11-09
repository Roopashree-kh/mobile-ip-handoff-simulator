/** @type {import('tailwindcss').Config} */
// One typographic scale for the whole console: 11 / 12 / 13 / 15 / 18 px.
// Chrome accents are limited to sky (primary) and amber (warning). The packet-type
// palette in src/lib/util.js is for data only.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    fontSize: {
      '2xs': ['11px', '16px'],
      xs: ['12px', '17px'],
      sm: ['13px', '19px'],
      base: ['15px', '21px'],
      lg: ['18px', '24px'],
    },
    extend: {
      fontFamily: {
        sans: ['Inter', '"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', '-apple-system', 'Roboto', 'sans-serif'],
        mono: ['"Cascadia Mono"', '"JetBrains Mono"', 'Consolas', 'ui-monospace', 'Menlo', 'monospace'],
      },
      colors: {
        noc: {
          bg: '#0b1018',
          panel: '#111827',
          raised: '#161f2e',
          line: '#1f2937',
          edge: '#2b3646',
          ink: '#e5e7eb',
          dim: '#9ca3af',
          mute: '#6b7280',
        },
      },
      borderRadius: { panel: '8px' },
    },
  },
  plugins: [],
};
