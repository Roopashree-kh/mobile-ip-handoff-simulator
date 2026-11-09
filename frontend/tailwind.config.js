/** @type {import('tailwindcss').Config} */
// Light desktop-tool theme. Type scale 11 / 12 / 13 / 15 / 18 px, body text 13 px.
// One accent (acc, muted blue) for active state and primary buttons. The packet-type
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
        sans: ['Inter', '"Segoe UI"', 'system-ui', '-apple-system', 'Roboto', 'sans-serif'],
        mono: ['Consolas', '"Cascadia Mono"', 'ui-monospace', 'Menlo', 'monospace'],
      },
      colors: {
        noc: {
          bg: '#f4f5f7',
          panel: '#ffffff',
          raised: '#f7f8fa',
          head: '#eef0f3',
          line: '#d0d4da',
          edge: '#b8bfc8',
          ink: '#1f2933',
          head1: '#111111',
          dim: '#5f6b7a',
          mute: '#7b8794',
        },
        acc: { DEFAULT: '#2457a6', dark: '#1c4787', soft: '#e6edf8', line: '#9db4da' },
        warn: { DEFAULT: '#8a5a00', soft: '#fdf3dc', line: '#e3c27a' },
        bad: { DEFAULT: '#b42318', soft: '#fdecea', line: '#f0b4ae' },
        good: { DEFAULT: '#1e7b34', soft: '#e7f4ea' },
      },
      borderRadius: { panel: '4px' },
    },
  },
  plugins: [],
};
