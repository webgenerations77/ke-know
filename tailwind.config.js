/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: '#0e0e10',
        surface: '#16161a',
        crimson: {
          DEFAULT: '#8B1A4A',
          hover: '#a81f5a',
          light: '#b52060',
        },
      },
    },
  },
  plugins: [],
};
