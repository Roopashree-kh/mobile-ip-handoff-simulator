/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { mono: ['"Cascadia Mono"', 'Consolas', 'ui-monospace', 'monospace'] },
      colors: { noc: { bg: '#0b1018', panel: '#111827', line: '#1f2937', soft: '#94a3b8' } },
    },
  },
  plugins: [],
};
