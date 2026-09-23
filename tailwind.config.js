/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        dark: {
          bg: '#18191c',
          card: '#222327',
          surface: '#2b2d31',
          input: '#1e1f22',
          border: '#36373d',
          hover: '#313338'
        }
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "'SF Pro Text'",
          "'SF Pro Display'",
          "'Segoe UI'",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif"
        ],
        mono: [
          "'SF Mono'",
          "ui-monospace",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace"
        ]
      }
    },
  },
  plugins: [],
}
