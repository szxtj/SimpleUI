import plugin from 'tailwindcss/plugin';

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
  plugins: [
    /**
     * Container-query variants for the chat column.
     *
     * Why: the chat column width = window width - open sidebars (260px sessions
     * sidebar / 440px knowledge panel). Viewport breakpoints (sm:/md:) therefore
     * lie as soon as a sidebar is open: a 890px window with the knowledge panel
     * open leaves the chat column only ~450px wide, yet sm:/md: still applied
     * the "desktop" chrome (px-8 paddings, chip labels, bigger gaps) and the
     * input toolbar overflowed its capsule.
     *
     * These variants key off the chat column's own width instead, so the chat
     * area always picks the same layout as the sidebar-free window at the same
     * width. Requires an ancestor with `container-type: inline-size`
     * (see `.chat-container` in src/index.css).
     */
    plugin(({ addVariant }) => {
      // >= 480px column: room for the full input toolbar (labels + wider gaps)
      addVariant('cq-md', '@container (min-width: 30rem)');
      // >= 640px column: desktop-grade paddings
      addVariant('cq-lg', '@container (min-width: 40rem)');
    }),
  ],
}
